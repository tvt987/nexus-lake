import React, { useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  GitCommitHorizontal,
  Grid3X3,
  Pin,
  Play,
  Plus,
  Table2,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import { SQL_PRESETS } from '../engine/sqlPresets';
import {
  serializeRowsToCsvBom,
  serializeRowsToJson,
  triggerBrowserDownload,
} from '../engines/exportEngine';
import type {
  NotebookCell,
  NotebookCellViewMode,
  PivotConfig,
  QueryHistoryEntry,
  QueryHistorySource,
} from '../types/lakehouse';
import { AutoChartPanel } from './AutoChartPanel';
import { PivotMatrixPanel } from './PivotMatrixPanel';
import { QueryPlanPanel } from './QueryPlanPanel';
import { VirtualResultsTable } from './VirtualResultsTable';

interface SqlNotebookPanelProps {
  copy: CopyDict;
  cells: NotebookCell[];
  activeCellId: string;
  onSelectCell: (id: string) => void;
  onUpdateCellSql: (id: string, sql: string) => void;
  onUpdateCellTitle: (id: string, title: string) => void;
  onUpdateCellView: (id: string, view: NotebookCellViewMode) => void;
  onUpdateCellPivot: (id: string, config: PivotConfig) => void;
  onToggleCollapseCell: (id: string) => void;
  onRunCell: (id: string, sqlOverride?: string, source?: QueryHistorySource) => Promise<void>;
  onRunAllCells: () => Promise<void>;
  onAddCell: () => void;
  onDuplicateCell: (id: string) => void;
  onDeleteCell: (id: string) => void;
  isBusy: boolean;
  history: QueryHistoryEntry[];
  onTogglePinHistory: (id: string) => void;
  onRerunHistory: (entry: QueryHistoryEntry) => void;
}

const SOURCE_BADGE: Record<QueryHistorySource, string> = {
  preset: 'text-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)]',
  brush: 'text-[var(--accent-signal)] bg-[var(--accent-signal-soft)]',
  copilot: 'text-[var(--accent-emerald)] bg-[var(--accent-emerald-soft)]',
  manual: 'text-[var(--text-secondary)] bg-[var(--bg-elevated)]',
  cdc: 'text-[var(--accent-emerald)] bg-[var(--accent-emerald-soft)]',
  peer: 'text-[var(--accent-amber)] bg-[var(--bg-elevated)]',
  notebook: 'text-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)]',
  nl2sql: 'text-[var(--accent-signal)] bg-[var(--accent-signal-soft)]',
};

export const SqlNotebookPanel: React.FC<SqlNotebookPanelProps> = ({
  copy,
  cells,
  activeCellId,
  onSelectCell,
  onUpdateCellSql,
  onUpdateCellTitle,
  onUpdateCellView,
  onUpdateCellPivot,
  onToggleCollapseCell,
  onRunCell,
  onRunAllCells,
  onAddCell,
  onDuplicateCell,
  onDeleteCell,
  isBusy,
  history,
  onTogglePinHistory,
  onRerunHistory,
}) => {
  const [showHistory, setShowHistory] = useState(false);

  const activeCell = cells.find((c) => c.id === activeCellId) ?? cells[0];

  const handleExportCellCsv = (cell: NotebookCell) => {
    if (!cell.result || cell.result.rows.length === 0) return;
    const csvBom = serializeRowsToCsvBom(cell.result.columns, cell.result.rows);
    const slug = cell.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'query';
    triggerBrowserDownload(`nexus-lake-${slug}.csv`, csvBom, 'text/csv;charset=utf-8');
  };

  const handleExportCellJson = (cell: NotebookCell) => {
    if (!cell.result || cell.result.rows.length === 0) return;
    const json = serializeRowsToJson(cell.result.rows);
    const slug = cell.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'query';
    triggerBrowserDownload(`nexus-lake-${slug}.json`, json, 'application/json;charset=utf-8');
  };

  return (
    <section
      data-testid="sql-notebook-panel"
      className="nexus-panel rounded-md flex flex-col overflow-hidden"
    >
      {/* Notebook Top Toolbar */}
      <div className="px-3 py-2 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className="w-3.5 h-3.5 text-[var(--accent-cyan)] shrink-0" />
          <span className="font-mono-tech text-[11px] font-semibold tracking-wide text-[var(--text-primary)] truncate">
            {copy.notebookTitle}
          </span>
          <span
            data-testid="notebook-cell-count"
            className="font-mono-tech text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-hairline)] text-[var(--accent-cyan)]"
          >
            {cells.length} {cells.length === 1 ? 'CELL' : 'CELLS'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {activeCell?.result && activeCell.result.rows.length > 0 && (
            <>
              <button
                type="button"
                data-testid="export-active-csv-btn"
                onClick={() => handleExportCellCsv(activeCell)}
                className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-emerald)] hover:text-[var(--accent-emerald)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 transition-colors cursor-pointer"
                title="Export active cell results as UTF-8 BOM CSV"
              >
                <Download className="w-3 h-3" />
                {copy.exportCsv}
              </button>
              <button
                type="button"
                data-testid="export-active-json-btn"
                onClick={() => handleExportCellJson(activeCell)}
                className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 transition-colors cursor-pointer"
                title="Export active cell results as JSON"
              >
                <Download className="w-3 h-3" />
                {copy.exportJson}
              </button>
            </>
          )}

          <button
            type="button"
            data-testid="notebook-history-toggle"
            onClick={() => setShowHistory((s) => !s)}
            className={`px-2 py-1 rounded border font-mono-tech text-[10px] flex items-center gap-1 transition-colors cursor-pointer ${
              showHistory
                ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)]'
                : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
            }`}
          >
            <Clock className="w-3 h-3" />
            <span>{history.length}</span>
          </button>

          <button
            type="button"
            data-testid="notebook-add-cell-btn"
            onClick={onAddCell}
            className="px-2 py-1 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] font-mono-tech text-[10px] text-[var(--text-primary)] flex items-center gap-1 transition-colors cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            <span>{copy.addCell}</span>
          </button>

          <button
            type="button"
            data-testid="notebook-run-all-btn"
            disabled={isBusy}
            onClick={() => void onRunAllCells()}
            className="px-2.5 py-1 rounded bg-[var(--accent-signal)] hover:brightness-110 text-white font-mono-tech text-[10.5px] font-semibold flex items-center gap-1 transition-all disabled:opacity-50 cursor-pointer"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>{copy.runAllCells}</span>
          </button>
        </div>
      </div>

      {/* Curated OLAP Presets Bar (targets active cell) */}
      <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-inset)] flex items-center gap-1.5 overflow-x-auto">
        <span className="font-mono-tech text-[9px] tracking-wider uppercase text-[var(--text-muted)] shrink-0 mr-1">
          {copy.presetsLabel}:
        </span>
        {SQL_PRESETS.map((preset) => {
          const isActive = activeCell?.sql.trim() === preset.sql.trim();
          return (
            <button
              key={preset.id}
              type="button"
              data-testid={`preset-${preset.id}`}
              title={preset.description}
              onClick={() => {
                if (!activeCell) return;
                onUpdateCellSql(activeCell.id, preset.sql);
                onUpdateCellTitle(activeCell.id, preset.label);
                void onRunCell(activeCell.id, preset.sql, 'preset');
              }}
              className={`px-2 py-0.5 rounded font-mono-tech text-[10px] whitespace-nowrap border transition-colors cursor-pointer ${
                isActive
                  ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-medium'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
              }`}
            >
              <span className="text-[var(--text-muted)] mr-1">[{preset.shortTag}]</span>
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* Collapsible Query History Drawer */}
      {showHistory && (
        <div
          data-testid="query-history-panel"
          className="nexus-hairline-b bg-[var(--bg-inset)] p-2.5 max-h-48 overflow-y-auto space-y-1.5"
        >
          {history.length === 0 ? (
            <p className="font-mono-tech text-[10.5px] text-[var(--text-muted)] text-center py-3 m-0">
              Executed SQL notebook cells will be logged here with execution latency.
            </p>
          ) : (
            history.map((entry) => (
              <div
                key={entry.id}
                data-testid="query-history-item"
                className={`p-2 rounded border bg-[var(--bg-surface)] flex items-center justify-between gap-2 ${
                  entry.pinned ? 'border-[var(--accent-cyan)]/50' : 'border-[var(--border-hairline)]'
                }`}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5 font-mono-tech text-[10px]">
                    <span
                      className={`px-1.5 py-0.2 rounded text-[9px] uppercase font-semibold ${SOURCE_BADGE[entry.source]}`}
                    >
                      {entry.source}
                    </span>
                    <span className="text-[var(--text-primary)] font-medium truncate">
                      {entry.label}
                    </span>
                    <span className="text-[var(--accent-emerald)]">
                      {entry.executionMs.toFixed(1)}ms
                    </span>
                    <span className="text-[var(--text-muted)]">{entry.rowCount} rows</span>
                  </div>
                  <p className="font-mono-tech text-[9.5px] text-[var(--text-muted)] truncate m-0">
                    {entry.sql.replace(/\s+/g, ' ').trim()}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    aria-label={entry.pinned ? 'Unpin query' : 'Pin query'}
                    onClick={() => onTogglePinHistory(entry.id)}
                    className={`p-1 rounded border cursor-pointer ${
                      entry.pinned
                        ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)]'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-muted)]'
                    }`}
                  >
                    <Pin className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onRerunHistory(entry);
                      setShowHistory(false);
                    }}
                    className="px-2 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-signal)] hover:text-[var(--accent-signal)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
                  >
                    <Play className="w-2.5 h-2.5 fill-current" />
                    Re-run
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Multi-Cell Stack */}
      <div className="p-2.5 space-y-3 bg-[var(--bg-canvas)]/40">
        {cells.map((cell, index) => {
          const isActive = cell.id === activeCellId;
          const lines = Math.max(4, Math.min(10, cell.sql.split('\n').length));

          return (
            <article
              key={cell.id}
              data-testid={`notebook-cell-${index + 1}`}
              onClick={() => onSelectCell(cell.id)}
              className={`rounded-md border overflow-hidden transition-colors bg-[var(--bg-surface)] ${
                isActive
                  ? 'border-[var(--accent-cyan)]/65 shadow-[0_0_0_1px_rgba(6,182,212,0.18)]'
                  : 'border-[var(--border-hairline)] hover:border-[var(--border-strong)]'
              }`}
            >
              {/* Cell Header Bar */}
              <div className="px-2.5 py-1.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <button
                    type="button"
                    aria-label={cell.collapsed ? 'Expand SQL editor' : 'Collapse SQL editor'}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleCollapseCell(cell.id);
                    }}
                    className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer shrink-0"
                  >
                    {cell.collapsed ? (
                      <ChevronRight className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>

                  <span className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--accent-cyan)] font-semibold shrink-0">
                    In [{index + 1}]
                  </span>

                  <input
                    type="text"
                    aria-label={`Cell ${index + 1} title`}
                    value={cell.title}
                    onChange={(e) => onUpdateCellTitle(cell.id, e.target.value)}
                    className="min-w-0 flex-1 max-w-[260px] bg-transparent font-mono-tech text-[11px] font-medium text-[var(--text-primary)] focus:outline-none focus:bg-[var(--bg-inset)] px-1.5 py-0.5 rounded"
                  />

                  {cell.result && !cell.result.error && (
                    <div
                      data-testid={`cell-metrics-${index + 1}`}
                      className="hidden sm:flex items-center gap-2 font-mono-tech text-[9.5px] text-[var(--text-muted)] shrink-0"
                    >
                      <span className="flex items-center gap-1 text-[var(--accent-emerald)]">
                        <Zap className="w-2.5 h-2.5" />
                        {cell.result.executionMs.toFixed(1)} ms
                      </span>
                      <span>·</span>
                      <span className="text-[var(--text-secondary)]">
                        {cell.result.rowCount.toLocaleString()} rows
                      </span>
                    </div>
                  )}
                </div>

                {/* Cell Action Controls */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    title="Export cell CSV (UTF-8 BOM)"
                    disabled={!cell.result || cell.result.rows.length === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExportCellCsv(cell);
                    }}
                    className="p-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--accent-emerald)] disabled:opacity-35 cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                  </button>

                  <button
                    type="button"
                    data-testid={`cell-duplicate-${index + 1}`}
                    title="Duplicate SQL cell"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicateCell(cell.id);
                    }}
                    className="p-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--accent-cyan)] cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                  </button>

                  {cells.length > 1 && (
                    <button
                      type="button"
                      data-testid={`cell-delete-${index + 1}`}
                      title="Delete SQL cell"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteCell(cell.id);
                      }}
                      className="p-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--accent-signal)] cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}

                  <button
                    type="button"
                    data-testid={`cell-run-${index + 1}`}
                    disabled={cell.isRunning || isBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onRunCell(cell.id, undefined, 'notebook');
                    }}
                    className="px-2.5 py-1 rounded bg-[var(--accent-signal)] hover:brightness-110 text-white font-mono-tech text-[10px] font-semibold flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                  >
                    <Play className="w-2.5 h-2.5 fill-current" />
                    <span>{cell.isRunning ? 'EXEC...' : 'Run'}</span>
                  </button>
                </div>
              </div>

              {/* Line-Numbered SQL Editor */}
              {!cell.collapsed && (
                <div className="flex bg-[var(--bg-inset)] nexus-hairline-b max-h-[126px] overflow-y-auto">
                  <div
                    aria-hidden="true"
                    className="py-2 px-2 text-right select-none font-mono-tech text-[10.5px] leading-[1.5] text-[var(--text-muted)] opacity-50 border-r border-[var(--border-hairline)] bg-[var(--bg-surface)] shrink-0"
                  >
                    {Array.from({ length: lines }, (_, idx) => (
                      <div key={idx}>{idx + 1}</div>
                    ))}
                  </div>
                  <textarea
                    data-testid={index === 0 ? 'sql-editor' : `sql-editor-${index + 1}`}
                    value={cell.sql}
                    onFocus={() => onSelectCell(cell.id)}
                    onChange={(e) => onUpdateCellSql(cell.id, e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        void onRunCell(cell.id, undefined, 'notebook');
                      }
                    }}
                    spellCheck={false}
                    rows={lines}
                    className="flex-1 p-2 bg-transparent font-mono-tech text-[11px] leading-[1.5] text-[var(--text-primary)] focus:outline-none resize-none overflow-x-auto"
                  />
                </div>
              )}

              {/* Cell Execution Error or View Switcher + Result Viewport */}
              {cell.result?.error ? (
                <div className="px-3 py-2 bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] font-mono-tech text-[10.5px] flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span className="break-all">{cell.result.error}</span>
                </div>
              ) : (
                <>
                  {/* View Mode Switcher Bar: Data Grid | SVG Chart | Pivot Matrix | EXPLAIN Plan */}
                  <div className="px-2.5 py-1 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
                    <div
                      role="tablist"
                      aria-label={`Cell ${index + 1} output view`}
                      className="flex items-center gap-1 overflow-x-auto"
                    >
                      {(
                        [
                          { id: 'grid' as const, label: copy.viewGrid, Icon: Table2 },
                          { id: 'chart' as const, label: copy.viewChart, Icon: BarChart3 },
                          { id: 'pivot' as const, label: copy.viewPivot, Icon: Grid3X3 },
                          { id: 'plan' as const, label: copy.viewPlan, Icon: GitCommitHorizontal },
                        ]
                      ).map(({ id, label, Icon }) => {
                        const active = cell.viewMode === id;
                        return (
                          <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            data-testid={`cell-${index + 1}-view-${id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateCellView(cell.id, id);
                            }}
                            className={`px-2 py-0.5 rounded font-mono-tech text-[10px] whitespace-nowrap flex items-center gap-1 transition-colors cursor-pointer ${
                              active
                                ? 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold border border-[var(--accent-cyan)]/35'
                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-transparent'
                            }`}
                          >
                            <Icon className="w-3 h-3" />
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-2 font-mono-tech text-[9.5px] text-[var(--text-muted)]">
                      <span>{cell.result?.engine ?? 'READY'}</span>
                      {cell.result && (
                        <>
                          <span>·</span>
                          <span>{cell.result.scannedRows.toLocaleString()} scanned</span>
                          <span className="hidden md:inline text-[var(--accent-cyan)]">
                            {cell.result.rowsPerSec > 0
                              ? `${(cell.result.rowsPerSec / 1_000_000).toFixed(2)}M r/s`
                              : ''}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Active Output View */}
                  {cell.viewMode === 'grid' && (
                    <VirtualResultsTable
                      columns={cell.result?.columns ?? []}
                      rows={cell.result?.rows ?? []}
                      heightClass={index === 0 ? 'h-[172px]' : 'h-[168px]'}
                    />
                  )}
                  {cell.viewMode === 'chart' && <AutoChartPanel result={cell.result} />}
                  {cell.viewMode === 'pivot' && (
                    <PivotMatrixPanel
                      copy={copy}
                      result={cell.result}
                      initialConfig={cell.pivotConfig}
                      onConfigChange={(cfg) => onUpdateCellPivot(cell.id, cfg)}
                      heightClass="h-[214px]"
                    />
                  )}
                  {cell.viewMode === 'plan' && (
                    <QueryPlanPanel
                      result={cell.result}
                      rawExplainText={cell.rawExplainText}
                    />
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
};
