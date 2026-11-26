import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COPY } from './i18n';
import {
  appendCdcBatch,
  buildLakehouseSnapshotPayload,
  DEFAULT_CDC_TELEMETRY,
  generateCdcBatch,
  nextCdcTelemetry,
} from './engine/cdcStream';
import { generateColumnarTransactions } from './engine/dataGenerator';
import { NexusDuckDbEngine } from './engine/duckdbEngine';
import { recordQueryHistory, togglePinHistoryEntry } from './engine/queryHistory';
import { SQL_PRESETS } from './engine/sqlPresets';
import {
  clearAllLocalStorage,
  deleteNotebook,
  getStorageTelemetry,
  loadPinnedWidgets,
  loadSavedNotebooks,
  recordUploadedTableMeta,
  removePinnedWidget,
  saveNotebook,
  savePinnedWidget,
} from './engine/storageIdb';
import { LocalSemanticVectorIndex } from './engine/vectorIndex';
import type {
  BrushSelectionBounds,
  CdcTelemetryState,
  ColumnarTransactions,
  EngineBackend,
  GenerativeWidget,
  Locale,
  QueryHistoryEntry,
  QueryHistorySource,
  SavedNotebook,
  SqlQueryResult,
  StorageTelemetry,
  TableSchemaInfo,
  ThemeMode,
  WorkspaceTab,
} from './types/lakehouse';
import { TopBar } from './components/TopBar';
import { SidebarCatalog } from './components/SidebarCatalog';
import { SqlWorkbench } from './components/SqlWorkbench';
import { WebGpuAnomalyCanvas } from './components/WebGpuAnomalyCanvas';
import { CdcLiveStrip } from './components/CdcLiveStrip';
import { AguiCopilotDock } from './components/AguiCopilotDock';
import { CrdtMultiplayerLab } from './components/CrdtMultiplayerLab';
import { ArchitectureInspector } from './components/ArchitectureInspector';
import { CommandPalette } from './components/CommandPalette';

const INITIAL_ROWS = 100_000;
const CDC_TICK_MS = 900;

export function App() {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [locale, setLocale] = useState<Locale>('en');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('workbench');
  const [cmdOpen, setCmdOpen] = useState(false);

  const [rowScale, setRowScale] = useState<number>(INITIAL_ROWS);
  const [isLoadingScale, setIsLoadingScale] = useState<boolean>(true);
  const [dataset, setDataset] = useState<ColumnarTransactions>(() =>
    generateColumnarTransactions(INITIAL_ROWS),
  );
  const [engineBackend, setEngineBackend] = useState<EngineBackend>('DUCKDB-WASM');
  const [tables, setTables] = useState<TableSchemaInfo[]>([]);

  const [sql, setSql] = useState<string>(SQL_PRESETS[0].sql);
  const [isRunningSql, setIsRunningSql] = useState<boolean>(false);
  const [queryResult, setQueryResult] = useState<SqlQueryResult | null>(null);
  const [rawExplainText, setRawExplainText] = useState<string | null>(null);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);
  const [activeBrushBounds, setActiveBrushBounds] = useState<BrushSelectionBounds | null>(null);

  // v2.0 Live Kafka CDC Streaming state
  const [cdcTelemetry, setCdcTelemetry] = useState<CdcTelemetryState>(DEFAULT_CDC_TELEMETRY);

  const [notebooks, setNotebooks] = useState<SavedNotebook[]>([]);
  const [pinnedWidgets, setPinnedWidgets] = useState<GenerativeWidget[]>([]);
  const [storageTelemetry, setStorageTelemetry] = useState<StorageTelemetry>({
    backend: 'IndexedDB',
    notebooksCount: 0,
    uploadedTablesCount: 0,
    pinnedWidgetsCount: 0,
    usageBytes: 0,
    quotaBytes: 0,
  });

  const engineRef = useRef<NexusDuckDbEngine | null>(null);
  const datasetRef = useRef<ColumnarTransactions>(dataset);
  datasetRef.current = dataset;
  const cdcSeqRef = useRef<number>(INITIAL_ROWS);
  const cdcBatchIdxRef = useRef<number>(0);
  const cdcInFlightRef = useRef<boolean>(false);

  const copy = COPY[locale];

  const vectorIndex = useMemo(() => {
    const idx = new LocalSemanticVectorIndex();
    idx.rebuild(tables, SQL_PRESETS, notebooks);
    return idx;
  }, [tables, notebooks]);

  const refreshStorage = useCallback(async () => {
    const telemetry = await getStorageTelemetry();
    setStorageTelemetry(telemetry);
  }, []);

  const executeSql = useCallback(async (queryText: string): Promise<SqlQueryResult> => {
    const engine = engineRef.current;
    if (!engine) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        scannedRows: 0,
        executionMs: 0,
        rowsPerSec: 0,
        engine: 'FALLBACK-OLAP',
        sql: queryText,
        error: 'Engine initializing...',
      };
    }
    return engine.executeSql(queryText);
  }, []);

  const handleRunSql = useCallback(
    async (sqlOverride?: string, source: QueryHistorySource = 'manual') => {
      const target = sqlOverride ?? sql;
      setIsRunningSql(true);
      try {
        const res = await executeSql(target);
        setQueryResult(res);
        setQueryHistory((prev) =>
          recordQueryHistory(prev, {
            sql: target,
            executedAt: new Date().toISOString(),
            executionMs: res.executionMs,
            rowCount: res.rowCount,
            scannedRows: res.scannedRows,
            engine: res.engine,
            source,
            error: res.error,
          }),
        );
        const engine = engineRef.current;
        if (engine && !res.error) {
          const explain = await engine.explainSql(target);
          setRawExplainText(explain);
        } else {
          setRawExplainText(null);
        }
      } finally {
        setIsRunningSql(false);
      }
    },
    [executeSql, sql],
  );

  // Bootstrap DuckDB-WASM + IndexedDB state on mount
  useEffect(() => {
    let active = true;
    const engine = new NexusDuckDbEngine();
    engineRef.current = engine;

    const boot = async () => {
      setIsLoadingScale(true);
      const [initInfo, savedNbs, savedWidgets] = await Promise.all([
        engine.initialize(dataset),
        loadSavedNotebooks(),
        loadPinnedWidgets(),
      ]);
      if (!active) return;

      setEngineBackend(initInfo.backend);
      setTables(engine.getTables());
      setNotebooks(savedNbs);
      setPinnedWidgets(savedWidgets);
      await refreshStorage();

      const firstSql = SQL_PRESETS[0].sql;
      const firstRes = await engine.executeSql(firstSql);
      const firstExplain = await engine.explainSql(firstSql);
      if (!active) return;
      setQueryResult(firstRes);
      setRawExplainText(firstExplain);
      setQueryHistory((prev) =>
        recordQueryHistory(prev, {
          sql: firstSql,
          executedAt: new Date().toISOString(),
          executionMs: firstRes.executionMs,
          rowCount: firstRes.rowCount,
          scannedRows: firstRes.scannedRows,
          engine: firstRes.engine,
          source: 'preset',
          error: firstRes.error,
        }),
      );
      setIsLoadingScale(false);
    };

    void boot();

    return () => {
      active = false;
      void engine.dispose();
    };
    // Run bootstrap strictly once with initial dataset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live Streaming CDC Mode (+5,000 tx/sec simulated Kafka ingest every 900ms)
  useEffect(() => {
    if (!cdcTelemetry.isStreaming || isLoadingScale) return;

    let cancelled = false;

    const runCdcTick = async () => {
      if (cancelled || cdcInFlightRef.current) return;
      const engine = engineRef.current;
      if (!engine) return;

      cdcInFlightRef.current = true;
      try {
        cdcBatchIdxRef.current += 1;
        // ~4,500 tx per 900ms = ~5,000 tx/sec with realistic jitter (4,350..5,550 tx/s)
        const jitter = ((cdcBatchIdxRef.current * 373) % 900) - 450;
        const batchSize = Math.max(3900, 4500 + jitter);
        const generated = generateCdcBatch(
          batchSize,
          cdcSeqRef.current,
          cdcBatchIdxRef.current,
          Date.now(),
          CDC_TICK_MS,
        );
        cdcSeqRef.current += batchSize;

        const nextDataset = appendCdcBatch(datasetRef.current, generated.batch, 500_000);
        const ingestMs = await engine.appendTransactionsBatch(generated.batch, nextDataset);
        if (cancelled) return;

        datasetRef.current = nextDataset;
        setDataset(nextDataset);
        setTables(engine.getTables());
        setCdcTelemetry((prev) =>
          prev.isStreaming ? nextCdcTelemetry(prev, generated, ingestMs) : prev,
        );
      } catch (err) {
        console.warn('[NexusLake] CDC batch skipped:', err);
      } finally {
        cdcInFlightRef.current = false;
      }
    };

    // Trigger immediate first batch on activation for snappy responsiveness
    void runCdcTick();
    const timer = window.setInterval(() => {
      void runCdcTick();
    }, CDC_TICK_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cdcTelemetry.isStreaming, isLoadingScale]);

  // Global CMD+K / Ctrl+K listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleToggleCdcStream = useCallback(() => {
    setCdcTelemetry((prev) => ({
      ...prev,
      isStreaming: !prev.isStreaming,
      currentRateTxSec: !prev.isStreaming ? Math.max(5000, prev.currentRateTxSec) : 0,
      burstAlertActive: !prev.isStreaming ? prev.burstAlertActive : false,
    }));
  }, []);

  const handleExportSnapshot = useCallback(() => {
    const payload = buildLakehouseSnapshotPayload({
      engine: engineBackend,
      totalRows: datasetRef.current.rowCount,
      activeSql: sql,
      cdcTelemetry,
      activeBrushBounds,
      queryResult,
      queryHistory,
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-lake-v2-snapshot-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeBrushBounds, cdcTelemetry, engineBackend, queryHistory, queryResult, sql]);

  const handleRowScaleChange = useCallback(
    async (nextRows: number) => {
      if (isLoadingScale || nextRows === rowScale) return;
      setIsLoadingScale(true);
      try {
        const nextDataset = generateColumnarTransactions(nextRows);
        datasetRef.current = nextDataset;
        cdcSeqRef.current = nextRows;
        setDataset(nextDataset);
        setRowScale(nextRows);
        const engine = engineRef.current;
        if (engine) {
          await engine.loadTransactions(nextDataset);
          setTables(engine.getTables());
          const res = await engine.executeSql(sql);
          const explain = await engine.explainSql(sql);
          setQueryResult(res);
          setRawExplainText(explain);
        }
      } finally {
        setIsLoadingScale(false);
      }
    },
    [isLoadingScale, rowScale, sql],
  );

  const handleUploadFile = useCallback(
    async (fileName: string, content: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      const schema = await engine.ingestFile(fileName, content);
      setTables(engine.getTables());
      await recordUploadedTableMeta({
        name: schema.name,
        rowCount: schema.rowCount,
        uploadedAt: new Date().toISOString(),
      });
      await refreshStorage();
      const previewSql = `SELECT * FROM "${schema.name}" LIMIT 100;`;
      setSql(previewSql);
      await handleRunSql(previewSql, 'manual');
    },
    [handleRunSql, refreshStorage],
  );

  const handleSaveNotebook = useCallback(async () => {
    const nb: SavedNotebook = {
      id: `nb-${Date.now().toString(36)}`,
      title: `Query Snapshot ${new Date().toTimeString().slice(0, 8)}`,
      sql,
      updatedAt: new Date().toISOString(),
      tags: ['saved', 'olap'],
    };
    await saveNotebook(nb);
    setNotebooks((prev) => [nb, ...prev]);
    await refreshStorage();
  }, [refreshStorage, sql]);

  const handleDeleteNotebook = useCallback(
    async (id: string) => {
      await deleteNotebook(id);
      setNotebooks((prev) => prev.filter((n) => n.id !== id));
      await refreshStorage();
    },
    [refreshStorage],
  );

  const handlePinWidget = useCallback(
    async (widget: GenerativeWidget) => {
      await savePinnedWidget(widget);
      setPinnedWidgets((prev) => [widget, ...prev.filter((w) => w.id !== widget.id)]);
      await refreshStorage();
    },
    [refreshStorage],
  );

  const handleUnpinWidget = useCallback(
    async (id: string) => {
      await removePinnedWidget(id);
      setPinnedWidgets((prev) => prev.filter((w) => w.id !== id));
      await refreshStorage();
    },
    [refreshStorage],
  );

  const handleClearStorage = useCallback(async () => {
    await clearAllLocalStorage();
    const fresh = await loadSavedNotebooks();
    setNotebooks(fresh);
    setPinnedWidgets([]);
    await refreshStorage();
  }, [refreshStorage]);

  const handleApplyBrushSql = useCallback(
    (brushSql: string, bounds: BrushSelectionBounds) => {
      setActiveBrushBounds(bounds);
      setSql(brushSql);
      void handleRunSql(brushSql, 'brush');
    },
    [handleRunSql],
  );

  const handleTogglePinHistory = useCallback((id: string) => {
    setQueryHistory((prev) => togglePinHistoryEntry(prev, id));
  }, []);

  const handleRerunHistory = useCallback(
    (entry: QueryHistoryEntry) => {
      setSql(entry.sql);
      void handleRunSql(entry.sql, entry.source);
    },
    [handleRunSql],
  );

  // View Transitions API circular wipe theme switcher
  const handleToggleTheme = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const nextTheme: ThemeMode = theme === 'dark' ? 'light' : 'dark';
      const apply = () => {
        document.documentElement.setAttribute('data-theme', nextTheme);
        setTheme(nextTheme);
      };

      const docWithVt = document as Document & {
        startViewTransition?: (cb: () => void) => { ready: Promise<void> };
      };
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

      if (!docWithVt.startViewTransition || reducedMotion) {
        apply();
        return;
      }

      const x = e.clientX;
      const y = e.clientY;
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );

      const transition = docWithVt.startViewTransition(apply);
      void transition.ready.then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 420,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            pseudoElement: '::view-transition-new(root)',
          },
        );
      });
    },
    [theme],
  );

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <TopBar
        copy={copy}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        engine={engineBackend}
        rowScale={rowScale}
        isLoadingScale={isLoadingScale}
        onRowScaleChange={(r) => void handleRowScaleChange(r)}
        cdcTelemetry={cdcTelemetry}
        onToggleCdcStream={handleToggleCdcStream}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        locale={locale}
        onToggleLocale={() => setLocale((l) => (l === 'en' ? 'vi' : 'en'))}
        onOpenCommandPalette={() => setCmdOpen(true)}
      />

      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        <SidebarCatalog
          copy={copy}
          tables={tables}
          notebooks={notebooks}
          vectorIndex={vectorIndex}
          storageTelemetry={storageTelemetry}
          cdcTelemetry={cdcTelemetry}
          onToggleCdcStream={handleToggleCdcStream}
          onExportSnapshot={handleExportSnapshot}
          onSelectSql={(nextSql, autoRun) => {
            setActiveTab('workbench');
            setSql(nextSql);
            if (autoRun) void handleRunSql(nextSql, 'manual');
          }}
          onUploadFile={handleUploadFile}
          onSaveCurrentNotebook={() => void handleSaveNotebook()}
          onDeleteNotebook={(id) => void handleDeleteNotebook(id)}
          onClearStorage={() => void handleClearStorage()}
        />

        <main className="flex-1 min-w-0 p-3 sm:p-4 overflow-y-auto nexus-grid-bg space-y-4">
          {activeTab === 'workbench' && (
            <>
              {(cdcTelemetry.isStreaming || cdcTelemetry.batchCount > 0) && (
                <CdcLiveStrip
                  copy={copy}
                  telemetry={cdcTelemetry}
                  onToggleStream={handleToggleCdcStream}
                  onExportSnapshot={handleExportSnapshot}
                />
              )}

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
                <div className="xl:col-span-7 min-w-0">
                  <SqlWorkbench
                    copy={copy}
                    sql={sql}
                    onSqlChange={setSql}
                    onRunSql={handleRunSql}
                    isRunning={isRunningSql || isLoadingScale}
                    result={queryResult}
                    rawExplainText={rawExplainText}
                    history={queryHistory}
                    onTogglePinHistory={handleTogglePinHistory}
                    onRerunHistory={handleRerunHistory}
                  />
                </div>
                <div className="xl:col-span-5 min-w-0">
                  <WebGpuAnomalyCanvas
                    copy={copy}
                    dataset={dataset}
                    theme={theme}
                    onApplyBrushSql={handleApplyBrushSql}
                    onBrushChange={setActiveBrushBounds}
                  />
                </div>
              </div>

              <AguiCopilotDock
                copy={copy}
                executeSql={executeSql}
                onApplySql={(nextSql) => {
                  setSql(nextSql);
                  void handleRunSql(nextSql, 'copilot');
                }}
                pinnedWidgets={pinnedWidgets}
                onPinWidget={(w) => void handlePinWidget(w)}
                onUnpinWidget={(id) => void handleUnpinWidget(id)}
              />
            </>
          )}

          {activeTab === 'multiplayer' && (
            <CrdtMultiplayerLab
              copy={copy}
              onExecutePeerSql={(peerSql) => {
                setSql(peerSql);
                setActiveTab('workbench');
                void handleRunSql(peerSql, 'peer');
              }}
            />
          )}

          {activeTab === 'architecture' && <ArchitectureInspector />}
        </main>
      </div>

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        vectorIndex={vectorIndex}
        onRunPresetSql={(nextSql) => {
          setSql(nextSql);
          void handleRunSql(nextSql, 'preset');
        }}
        onSwitchTab={setActiveTab}
        onSwitchRowScale={(r) => void handleRowScaleChange(r)}
      />
    </div>
  );
}

export default App;
