import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COPY } from './i18n';
import { generateColumnarTransactions } from './engine/dataGenerator';
import { NexusDuckDbEngine } from './engine/duckdbEngine';
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
  ColumnarTransactions,
  EngineBackend,
  GenerativeWidget,
  Locale,
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
import { AguiCopilotDock } from './components/AguiCopilotDock';
import { CrdtMultiplayerLab } from './components/CrdtMultiplayerLab';
import { ArchitectureInspector } from './components/ArchitectureInspector';
import { CommandPalette } from './components/CommandPalette';

const INITIAL_ROWS = 100_000;

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
    async (sqlOverride?: string) => {
      const target = sqlOverride ?? sql;
      setIsRunningSql(true);
      try {
        const res = await executeSql(target);
        setQueryResult(res);
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

      const firstRes = await engine.executeSql(SQL_PRESETS[0].sql);
      if (!active) return;
      setQueryResult(firstRes);
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

  const handleRowScaleChange = useCallback(
    async (nextRows: number) => {
      if (isLoadingScale || nextRows === rowScale) return;
      setIsLoadingScale(true);
      try {
        const nextDataset = generateColumnarTransactions(nextRows);
        setDataset(nextDataset);
        setRowScale(nextRows);
        const engine = engineRef.current;
        if (engine) {
          await engine.loadTransactions(nextDataset);
          setTables(engine.getTables());
          const res = await engine.executeSql(sql);
          setQueryResult(res);
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
      const res = await engine.executeSql(previewSql);
      setQueryResult(res);
    },
    [refreshStorage],
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
          onSelectSql={(nextSql, autoRun) => {
            setActiveTab('workbench');
            setSql(nextSql);
            if (autoRun) void handleRunSql(nextSql);
          }}
          onUploadFile={handleUploadFile}
          onSaveCurrentNotebook={() => void handleSaveNotebook()}
          onDeleteNotebook={(id) => void handleDeleteNotebook(id)}
          onClearStorage={() => void handleClearStorage()}
        />

        <main className="flex-1 min-w-0 p-3 sm:p-4 overflow-y-auto nexus-grid-bg space-y-4">
          {activeTab === 'workbench' && (
            <>
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
                <div className="xl:col-span-7 min-w-0">
                  <SqlWorkbench
                    copy={copy}
                    sql={sql}
                    onSqlChange={setSql}
                    onRunSql={handleRunSql}
                    isRunning={isRunningSql || isLoadingScale}
                    result={queryResult}
                  />
                </div>
                <div className="xl:col-span-5 min-w-0">
                  <WebGpuAnomalyCanvas copy={copy} dataset={dataset} theme={theme} />
                </div>
              </div>

              <AguiCopilotDock
                copy={copy}
                executeSql={executeSql}
                onApplySql={(nextSql) => {
                  setSql(nextSql);
                  void handleRunSql(nextSql);
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
                void handleRunSql(peerSql);
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
          void handleRunSql(nextSql);
        }}
        onSwitchTab={setActiveTab}
        onSwitchRowScale={(r) => void handleRowScaleChange(r)}
      />
    </div>
  );
}

export default App;
