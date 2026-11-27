import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  ENTERPRISE_SAMPLE_CATALOG,
  generateEnterpriseSampleDataset,
} from './engines/ingestionEngine';
import type {
  BrushSelectionBounds,
  CdcTelemetryState,
  ColumnarTransactions,
  EngineBackend,
  EnterpriseSampleId,
  GenerativeWidget,
  Locale,
  NlSqlTranslation,
  NotebookCell,
  NotebookCellViewMode,
  PivotConfig,
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
import { NlToSqlBar } from './components/NlToSqlBar';
import { SqlNotebookPanel } from './components/SqlNotebookPanel';
import { WebGpuAnomalyCanvas } from './components/WebGpuAnomalyCanvas';
import { CdcLiveStrip } from './components/CdcLiveStrip';
import { AguiCopilotDock } from './components/AguiCopilotDock';
import { CommandPalette } from './components/CommandPalette';

const SchemaLineageView = lazy(() =>
  import('./components/SchemaLineageView').then((m) => ({ default: m.SchemaLineageView })),
);
const DataIngestStudio = lazy(() =>
  import('./components/DataIngestStudio').then((m) => ({ default: m.DataIngestStudio })),
);
const CohortHeatmapPanel = lazy(() =>
  import('./components/CohortHeatmapPanel').then((m) => ({ default: m.CohortHeatmapPanel })),
);
const CrdtMultiplayerLab = lazy(() =>
  import('./components/CrdtMultiplayerLab').then((m) => ({ default: m.CrdtMultiplayerLab })),
);
const ArchitectureInspector = lazy(() =>
  import('./components/ArchitectureInspector').then((m) => ({
    default: m.ArchitectureInspector,
  })),
);
const EnterpriseLicenseModal = lazy(() =>
  import('./components/EnterpriseLicenseModal').then((m) => ({
    default: m.EnterpriseLicenseModal,
  })),
);

const LazyViewFallback: React.FC<{ label: string }> = ({ label }) => (
  <div className="nexus-panel rounded-md p-8 flex items-center justify-center font-mono-tech text-xs text-[var(--text-muted)]">
    Loading {label}...
  </div>
);

const INITIAL_ROWS = 100_000;
const CDC_TICK_MS = 900;

function createInitialCells(): NotebookCell[] {
  return [
    {
      id: 'cell-1',
      title: 'Regional Revenue & Anomaly Rollup',
      sql: SQL_PRESETS[0].sql,
      viewMode: 'grid',
      result: null,
      rawExplainText: null,
      isRunning: false,
      lastExecutedAt: null,
      collapsed: false,
    },
    {
      id: 'cell-2',
      title: 'P99 Settlement Latency Cross-Tab (Region x Category)',
      sql: SQL_PRESETS[2].sql,
      viewMode: 'pivot',
      result: null,
      rawExplainText: null,
      isRunning: false,
      lastExecutedAt: null,
      collapsed: true,
    },
  ];
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [locale, setLocale] = useState<Locale>('en');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('workbench');
  const [cmdOpen, setCmdOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);

  const [rowScale, setRowScale] = useState<number>(INITIAL_ROWS);
  const [isLoadingScale, setIsLoadingScale] = useState<boolean>(true);
  const [isIngesting, setIsIngesting] = useState<boolean>(false);
  const [dataset, setDataset] = useState<ColumnarTransactions>(() =>
    generateColumnarTransactions(INITIAL_ROWS),
  );
  const [engineBackend, setEngineBackend] = useState<EngineBackend>('DUCKDB-WASM');
  const [tables, setTables] = useState<TableSchemaInfo[]>([]);

  // v3.0 Multi-Cell Interactive SQL Notebook State
  const [cells, setCells] = useState<NotebookCell[]>(() => createInitialCells());
  const [activeCellId, setActiveCellId] = useState<string>('cell-1');

  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);
  const [activeBrushBounds, setActiveBrushBounds] = useState<BrushSelectionBounds | null>(null);

  // Live Kafka CDC Streaming state
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
  const cellsRef = useRef<NotebookCell[]>(cells);
  cellsRef.current = cells;
  const activeCellIdRef = useRef<string>(activeCellId);
  activeCellIdRef.current = activeCellId;
  const cdcSeqRef = useRef<number>(INITIAL_ROWS);
  const cdcBatchIdxRef = useRef<number>(0);
  const cdcInFlightRef = useRef<boolean>(false);

  const copy = COPY[locale];

  const activeCell = useMemo(
    () => cells.find((c) => c.id === activeCellId) ?? cells[0],
    [cells, activeCellId],
  );

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

  const handleRunCell = useCallback(
    async (
      cellId: string,
      sqlOverride?: string,
      source: QueryHistorySource = 'notebook',
    ) => {
      const targetCell = cellsRef.current.find((c) => c.id === cellId);
      const targetSql = sqlOverride ?? targetCell?.sql ?? SQL_PRESETS[0].sql;

      setCells((prev) =>
        prev.map((c) =>
          c.id === cellId ? { ...c, sql: targetSql, isRunning: true } : c,
        ),
      );

      try {
        const res = await executeSql(targetSql);
        const engine = engineRef.current;
        const explain = engine && !res.error ? await engine.explainSql(targetSql) : null;
        const executedAt = new Date().toISOString();

        setCells((prev) =>
          prev.map((c) =>
            c.id === cellId
              ? {
                  ...c,
                  sql: targetSql,
                  result: res,
                  rawExplainText: explain,
                  isRunning: false,
                  lastExecutedAt: executedAt,
                }
              : c,
          ),
        );

        setQueryHistory((prev) =>
          recordQueryHistory(prev, {
            sql: targetSql,
            executedAt,
            executionMs: res.executionMs,
            rowCount: res.rowCount,
            scannedRows: res.scannedRows,
            engine: res.engine,
            source,
            error: res.error,
          }),
        );
      } catch {
        setCells((prev) =>
          prev.map((c) => (c.id === cellId ? { ...c, isRunning: false } : c)),
        );
      }
    },
    [executeSql],
  );

  const handleRunAllCells = useCallback(async () => {
    const snapshot = [...cellsRef.current];
    for (const cell of snapshot) {
      await handleRunCell(cell.id, cell.sql, 'notebook');
    }
  }, [handleRunCell]);

  const handleRunOnActiveCell = useCallback(
    async (
      nextSql: string,
      source: QueryHistorySource = 'manual',
      titleOverride?: string,
      viewOverride?: NotebookCellViewMode,
    ) => {
      const targetId = activeCellIdRef.current || cellsRef.current[0]?.id;
      if (!targetId) return;
      setCells((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? {
                ...c,
                sql: nextSql,
                title: titleOverride ?? c.title,
                viewMode: viewOverride ?? c.viewMode,
                collapsed: false,
              }
            : c,
        ),
      );
      await handleRunCell(targetId, nextSql, source);
    },
    [handleRunCell],
  );

  // Bootstrap DuckDB-WASM + IndexedDB + Initial Multi-Cell Notebook Execution
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

      // Execute both starter cells on boot so Grid + Pivot Matrix are immediately live
      const initial = cellsRef.current;
      const updatedCells: NotebookCell[] = [];
      for (const cell of initial) {
        const res = await engine.executeSql(cell.sql);
        const explain = !res.error ? await engine.explainSql(cell.sql) : null;
        if (!active) return;
        const executedAt = new Date().toISOString();
        updatedCells.push({
          ...cell,
          result: res,
          rawExplainText: explain,
          isRunning: false,
          lastExecutedAt: executedAt,
        });
        setQueryHistory((prev) =>
          recordQueryHistory(prev, {
            sql: cell.sql,
            executedAt,
            executionMs: res.executionMs,
            rowCount: res.rowCount,
            scannedRows: res.scannedRows,
            engine: res.engine,
            source: 'preset',
            error: res.error,
          }),
        );
      }

      if (!active) return;
      setCells(updatedCells);
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
      if (e.key === 'Escape' && licenseOpen) {
        setLicenseOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [licenseOpen]);

  const handleToggleCdcStream = useCallback(() => {
    setCdcTelemetry((prev) => ({
      ...prev,
      isStreaming: !prev.isStreaming,
      currentRateTxSec: !prev.isStreaming ? Math.max(5000, prev.currentRateTxSec) : 0,
      burstAlertActive: !prev.isStreaming ? prev.burstAlertActive : false,
    }));
  }, []);

  const handleExportSnapshot = useCallback(() => {
    const current = cellsRef.current.find((c) => c.id === activeCellIdRef.current) ?? cellsRef.current[0];
    const payload = buildLakehouseSnapshotPayload({
      engine: engineBackend,
      totalRows: datasetRef.current.rowCount,
      activeSql: current?.sql ?? '',
      cdcTelemetry,
      activeBrushBounds,
      queryResult: current?.result ?? null,
      queryHistory,
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-lake-v4-snapshot-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeBrushBounds, cdcTelemetry, engineBackend, queryHistory]);

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
          await handleRunAllCells();
        }
      } finally {
        setIsLoadingScale(false);
      }
    },
    [handleRunAllCells, isLoadingScale, rowScale],
  );

  const ensureEnterpriseSampleLoaded = useCallback(
    async (sampleId: EnterpriseSampleId): Promise<string> => {
      const engine = engineRef.current;
      const meta = ENTERPRISE_SAMPLE_CATALOG.find((s) => s.id === sampleId);
      const starterSql = meta?.starterSql ?? `SELECT * FROM "${sampleId}" LIMIT 100;`;
      if (!engine) return starterSql;

      if (!engine.hasTable(sampleId)) {
        const ingested = generateEnterpriseSampleDataset(sampleId);
        const schema = await engine.ingestStructuredDataset(ingested, 'sample');
        setTables(engine.getTables());
        await recordUploadedTableMeta({
          name: schema.name,
          rowCount: schema.rowCount,
          uploadedAt: new Date().toISOString(),
        });
        await refreshStorage();
      }
      return starterSql;
    },
    [refreshStorage],
  );

  const handleLoadEnterpriseSample = useCallback(
    async (sampleId: EnterpriseSampleId, openNotebook = false) => {
      setIsIngesting(true);
      try {
        const starterSql = await ensureEnterpriseSampleLoaded(sampleId);
        if (openNotebook) {
          const meta = ENTERPRISE_SAMPLE_CATALOG.find((s) => s.id === sampleId);
          setActiveTab('workbench');
          await handleRunOnActiveCell(
            starterSql,
            'manual',
            meta ? meta.titleEn : sampleId,
          );
        }
      } finally {
        setIsIngesting(false);
      }
    },
    [ensureEnterpriseSampleLoaded, handleRunOnActiveCell],
  );

  const handleUploadFile = useCallback(
    async (fileName: string, content: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      setIsIngesting(true);
      try {
        const schema = await engine.ingestFile(fileName, content);
        setTables(engine.getTables());
        await recordUploadedTableMeta({
          name: schema.name,
          rowCount: schema.rowCount,
          uploadedAt: new Date().toISOString(),
        });
        await refreshStorage();
        const previewSql = `SELECT * FROM "${schema.name}" LIMIT 100;`;
        await handleRunOnActiveCell(previewSql, 'manual', `Uploaded: ${schema.name}`);
      } finally {
        setIsIngesting(false);
      }
    },
    [handleRunOnActiveCell, refreshStorage],
  );

  const handleCompileNlToSql = useCallback(
    async (translation: NlSqlTranslation) => {
      setIsIngesting(true);
      try {
        if (translation.requiredSampleDataset) {
          await ensureEnterpriseSampleLoaded(translation.requiredSampleDataset);
        }
        const preferredView: NotebookCellViewMode =
          translation.intent === 'monthly_revenue_mom_growth' ? 'chart' : 'grid';
        await handleRunOnActiveCell(
          translation.sql,
          'nl2sql',
          `NL-SQL: ${translation.prompt.slice(0, 42)}`,
          preferredView,
        );
      } finally {
        setIsIngesting(false);
      }
    },
    [ensureEnterpriseSampleLoaded, handleRunOnActiveCell],
  );

  const handleCohortDrilldown = useCallback(
    async (drillSql: string, title: string) => {
      setIsIngesting(true);
      try {
        await ensureEnterpriseSampleLoaded('saas_mrr_cohorts');
        setActiveTab('workbench');
        await handleRunOnActiveCell(drillSql, 'notebook', title, 'grid');
      } finally {
        setIsIngesting(false);
      }
    },
    [ensureEnterpriseSampleLoaded, handleRunOnActiveCell],
  );

  // Notebook Cell CRUD Handlers
  const handleAddCell = useCallback(() => {
    const newId = `cell-${Date.now().toString(36)}`;
    const nextIdx = cellsRef.current.length + 1;
    const preset = SQL_PRESETS[nextIdx % SQL_PRESETS.length];
    const newCell: NotebookCell = {
      id: newId,
      title: `Cell ${nextIdx} · ${preset.label}`,
      sql: preset.sql,
      viewMode: 'grid',
      result: null,
      rawExplainText: null,
      isRunning: false,
      lastExecutedAt: null,
      collapsed: false,
    };
    setCells((prev) => [...prev, newCell]);
    setActiveCellId(newId);
  }, []);

  const handleDuplicateCell = useCallback((id: string) => {
    const src = cellsRef.current.find((c) => c.id === id);
    if (!src) return;
    const dupId = `cell-${Date.now().toString(36)}`;
    const copyCell: NotebookCell = {
      ...src,
      id: dupId,
      title: `${src.title} (Copy)`,
      collapsed: false,
    };
    setCells((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      const next = [...prev];
      next.splice(idx + 1, 0, copyCell);
      return next;
    });
    setActiveCellId(dupId);
  }, []);

  const handleDeleteCell = useCallback((id: string) => {
    setCells((prev) => {
      if (prev.length <= 1) return prev;
      const filtered = prev.filter((c) => c.id !== id);
      if (activeCellIdRef.current === id && filtered[0]) {
        setActiveCellId(filtered[0].id);
      }
      return filtered;
    });
  }, []);

  const handleSaveNotebook = useCallback(async () => {
    const current = cellsRef.current.find((c) => c.id === activeCellIdRef.current) ?? cellsRef.current[0];
    if (!current) return;
    const nb: SavedNotebook = {
      id: `nb-${Date.now().toString(36)}`,
      title: current.title || `Query Snapshot ${new Date().toTimeString().slice(0, 8)}`,
      sql: current.sql,
      updatedAt: new Date().toISOString(),
      tags: ['saved', 'v3', 'olap'],
    };
    await saveNotebook(nb);
    setNotebooks((prev) => [nb, ...prev]);
    await refreshStorage();
  }, [refreshStorage]);

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
      void handleRunOnActiveCell(brushSql, 'brush', 'WebGPU Lasso Cluster Selection', 'grid');
    },
    [handleRunOnActiveCell],
  );

  const handleTogglePinHistory = useCallback((id: string) => {
    setQueryHistory((prev) => togglePinHistoryEntry(prev, id));
  }, []);

  const handleRerunHistory = useCallback(
    (entry: QueryHistoryEntry) => {
      void handleRunOnActiveCell(entry.sql, entry.source, entry.label);
    },
    [handleRunOnActiveCell],
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

  const saasCohortRows = engineRef.current?.getUploadedRows('saas_mrr_cohorts');

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-x-clip">
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
        onOpenEnterpriseLicense={() => setLicenseOpen(true)}
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
            if (autoRun) {
              void handleRunOnActiveCell(nextSql, 'manual');
            } else if (activeCell) {
              setCells((prev) =>
                prev.map((c) => (c.id === activeCell.id ? { ...c, sql: nextSql } : c)),
              );
            }
          }}
          onUploadFile={handleUploadFile}
          onLoadEnterpriseSample={handleLoadEnterpriseSample}
          onOpenIngestProfiler={() => setActiveTab('ingest')}
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

              {/* Offline VI/EN NL-to-SQL Copilot Strip */}
              <NlToSqlBar
                copy={copy}
                locale={locale}
                tables={tables}
                isBusy={isLoadingScale || isIngesting}
                onCompileAndRun={handleCompileNlToSql}
              />

              {/* Flagship 12-Col Bento: Multi-Cell SQL Notebook (7) + WebGPU Canvas & Live Cohort Heatmap (5) */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
                <div className="xl:col-span-7 min-w-0">
                  <SqlNotebookPanel
                    copy={copy}
                    cells={cells}
                    activeCellId={activeCellId}
                    onSelectCell={setActiveCellId}
                    onUpdateCellSql={(id, nextSql) =>
                      setCells((prev) =>
                        prev.map((c) => (c.id === id ? { ...c, sql: nextSql } : c)),
                      )
                    }
                    onUpdateCellTitle={(id, title) =>
                      setCells((prev) =>
                        prev.map((c) => (c.id === id ? { ...c, title } : c)),
                      )
                    }
                    onUpdateCellView={(id, viewMode) =>
                      setCells((prev) =>
                        prev.map((c) => (c.id === id ? { ...c, viewMode } : c)),
                      )
                    }
                    onUpdateCellPivot={(id, pivotConfig: PivotConfig) =>
                      setCells((prev) =>
                        prev.map((c) => (c.id === id ? { ...c, pivotConfig } : c)),
                      )
                    }
                    onToggleCollapseCell={(id) =>
                      setCells((prev) =>
                        prev.map((c) =>
                          c.id === id ? { ...c, collapsed: !c.collapsed } : c,
                        ),
                      )
                    }
                    onRunCell={handleRunCell}
                    onRunAllCells={handleRunAllCells}
                    onAddCell={handleAddCell}
                    onDuplicateCell={handleDuplicateCell}
                    onDeleteCell={handleDeleteCell}
                    isBusy={isLoadingScale || isIngesting}
                    history={queryHistory}
                    onTogglePinHistory={handleTogglePinHistory}
                    onRerunHistory={handleRerunHistory}
                  />
                </div>

                <div className="xl:col-span-5 min-w-0 space-y-4">
                  <WebGpuAnomalyCanvas
                    copy={copy}
                    dataset={dataset}
                    theme={theme}
                    onApplyBrushSql={handleApplyBrushSql}
                    onBrushChange={setActiveBrushBounds}
                  />
                  <Suspense fallback={<LazyViewFallback label="Cohort Retention Heatmap" />}>
                    <CohortHeatmapPanel
                      copy={copy}
                      locale={locale}
                      sourceRows={saasCohortRows}
                      compact
                      onExpandFull={() => setActiveTab('cohorts')}
                      onDrilldownSql={(drillSql, title) => void handleCohortDrilldown(drillSql, title)}
                    />
                  </Suspense>
                </div>
              </div>

              <AguiCopilotDock
                copy={copy}
                executeSql={executeSql}
                onApplySql={(nextSql) => {
                  void handleRunOnActiveCell(nextSql, 'copilot', 'AG-UI Copilot Dispatch');
                }}
                pinnedWidgets={pinnedWidgets}
                onPinWidget={(w) => void handlePinWidget(w)}
                onUnpinWidget={(id) => void handleUnpinWidget(id)}
              />
            </>
          )}

          {activeTab === 'lineage' && (
            <Suspense fallback={<LazyViewFallback label="Medallion Schema Lineage ERD" />}>
              <SchemaLineageView
                copy={copy}
                locale={locale}
                tables={tables}
                baseTransactionRows={dataset.rowCount}
                onQueryTableInNotebook={(tblName, starterSql) => {
                  setActiveTab('workbench');
                  void handleRunOnActiveCell(starterSql, 'manual', `Lineage: ${tblName}`);
                }}
              />
            </Suspense>
          )}

          {activeTab === 'ingest' && (
            <Suspense fallback={<LazyViewFallback label="Data Ingest Studio" />}>
              <DataIngestStudio
                copy={copy}
                locale={locale}
                tables={tables}
                isIngesting={isIngesting}
                onUploadFile={handleUploadFile}
                onLoadEnterpriseSample={handleLoadEnterpriseSample}
                onQueryTableInNotebook={(tblName, starterSql) => {
                  setActiveTab('workbench');
                  void handleRunOnActiveCell(starterSql, 'manual', `Query: ${tblName}`);
                }}
              />
            </Suspense>
          )}

          {activeTab === 'cohorts' && (
            <Suspense fallback={<LazyViewFallback label="Cohort Retention Studio" />}>
              <CohortHeatmapPanel
                copy={copy}
                locale={locale}
                sourceRows={saasCohortRows}
                onDrilldownSql={(drillSql, title) => void handleCohortDrilldown(drillSql, title)}
              />
            </Suspense>
          )}

          {activeTab === 'multiplayer' && (
            <Suspense fallback={<LazyViewFallback label="CRDT Multiplayer Lab" />}>
              <CrdtMultiplayerLab
                copy={copy}
                onExecutePeerSql={(peerSql) => {
                  setActiveTab('workbench');
                  void handleRunOnActiveCell(peerSql, 'peer', 'CRDT Peer Converged SQL');
                }}
              />
            </Suspense>
          )}

          {activeTab === 'architecture' && (
            <Suspense fallback={<LazyViewFallback label="Architecture Inspector" />}>
              <ArchitectureInspector />
            </Suspense>
          )}
        </main>
      </div>

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        vectorIndex={vectorIndex}
        onRunPresetSql={(nextSql) => {
          void handleRunOnActiveCell(nextSql, 'preset');
        }}
        onSwitchTab={setActiveTab}
        onSwitchRowScale={(r) => void handleRowScaleChange(r)}
        onOpenEnterpriseLicense={() => setLicenseOpen(true)}
      />

      {licenseOpen && (
        <Suspense fallback={null}>
          <EnterpriseLicenseModal
            open={licenseOpen}
            onClose={() => setLicenseOpen(false)}
            copy={copy}
            locale={locale}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
