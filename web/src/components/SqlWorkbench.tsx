import React, { useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Clock,
  Download,
  GitCommitHorizontal,
  Pin,
  Play,
  Table2,
  Terminal,
  Zap,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import { SQL_PRESETS } from '../engine/sqlPresets';
import type {
  QueryHistoryEntry,
  QueryHistorySource,
  SqlQueryResult,
  WorkbenchSubTab,
} from '../types/lakehouse';
import { AutoChartPanel } from './AutoChartPanel';
import { QueryPlanPanel } from './QueryPlanPanel';
import { VirtualResultsTable } from './VirtualResultsTable';

interface SqlWorkbenchProps {
  copy: CopyDict;
  sql: string;
  onSqlChange: (next: string) => void;
  onRunSql: (sqlOverride?: string, source?: QueryHistorySource) => Promise<void>;
  isRunning: boolean;
  result: SqlQueryResult | null;
  rawExplainText?: string | null;
  history: QueryHistoryEntry[];
  onTogglePinHistory: (id: string) => void;
  onRerunHistory: (entry: QueryHistoryEntry) => void;
}

function downloadBlob(fileName: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
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

export const SqlWorkbench: React.FC<SqlWorkbenchProps> = ({
  copy,
  sql,
  onSqlChange,
  onRunSql,
  isRunning,
  result,
  rawExplainText,
  history,
  onTogglePinHistory,
  onRerunHistory,
}) => {
  const [subTab, setSubTab] = useState<WorkbenchSubTab>('results');
  const lineCount = Math.max(6, sql.split('\n').length);

  const handleExportCsv = () => {
    if (!result || result.rows.length === 0) return;
    const header = result.columns.join(',');
    const lines = result.rows.map((r) =>
      result.columns.map((c) => JSON.stringify(r[c] ?? '')).join(','),
    );
    downloadBlob('nexus-lake-export.csv', [header, ...lines].join('\n'), 'text/csv;charset=utf-8');
  };

  const handleExportJson = () => {
    if (!result || result.rows.length === 0) return;
    downloadBlob(
      'nexus-lake-export.json',
      JSON.stringify(result.rows, null, 2),
      'application/json;charset=utf-8',
    );
  };

  return (
    <section className="nexus-panel rounded-md flex flex-col overflow-hidden h-full">
      {/* Header & Actions */}
      <div className="px-3 py-2 nexus-hairline-b flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-surface)]">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
          <span className="font-mono-tech text-[11px] font-semibold tracking-wide text-[var(--text-primary)]">
            OLAP SQL WORKBENCH
          </span>
          <span className="hidden sm:inline font-mono-tech text-[10px] text-[var(--text-muted)]">
            Ctrl+Enter
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={!result || result.rows.length === 0}
            className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10px] text-[var(--text-secondary)] disabled:opacity-40 flex items-center gap-1 cursor-pointer"
          >
            <Download className="w-3 h-3" />
            {copy.exportCsv}
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            disabled={!result || result.rows.length === 0}
            className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10px] text-[var(--text-secondary)] disabled:opacity-40 flex items-center gap-1 cursor-pointer"
          >
            <Download className="w-3 h-3" />
            {copy.exportJson}
          </button>
          <button
            type="button"
            data-testid="run-sql-btn"
            disabled={isRunning}
            onClick={() => void onRunSql(undefined, 'manual')}
            className="px-3 py-1 rounded bg-[var(--accent-signal)] hover:brightness-110 text-white font-mono-tech text-[11px] font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
          >
            <Play className="w-3 h-3 fill-current" />
            {isRunning ? 'EXEC...' : copy.runQuery}
          </button>
        </div>
      </div>

      {/* 6 Curated Presets Bar */}
      <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-inset)] flex items-center gap-1.5 overflow-x-auto">
        <span className="font-mono-tech text-[9px] tracking-wider uppercase text-[var(--text-muted)] shrink-0 mr-1">
          {copy.presetsLabel}:
        </span>
        {SQL_PRESETS.map((preset) => {
          const isActive = sql.trim() === preset.sql.trim();
          return (
            <button
              key={preset.id}
              type="button"
              data-testid={`preset-${preset.id}`}
              title={preset.description}
              onClick={() => {
                onSqlChange(preset.sql);
                void onRunSql(preset.sql, 'preset');
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

      {/* Editor Area with Synchronized Line Gutter */}
      <div className="flex bg-[var(--bg-inset)] nexus-hairline-b max-h-[212px] overflow-y-auto">
        <div
          aria-hidden="true"
          className="py-2.5 px-2.5 text-right select-none font-mono-tech text-[11px] leading-[1.55] text-[var(--text-muted)] opacity-55 border-r border-[var(--border-hairline)] bg-[var(--bg-surface)] shrink-0"
        >
          {Array.from({ length: lineCount }, (_, idx) => (
            <div key={idx}>{idx + 1}</div>
          ))}
        </div>
        <textarea
          data-testid="sql-editor"
          value={sql}
          onChange={(e) => onSqlChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void onRunSql(undefined, 'manual');
            }
          }}
          spellCheck={false}
          rows={lineCount}
          className="flex-1 p-2.5 bg-transparent font-mono-tech text-[11.5px] leading-[1.55] text-[var(--text-primary)] focus:outline-none resize-none overflow-x-auto"
        />
      </div>

      {/* Live Execution Telemetry Strip */}
      <div
        data-testid="sql-telemetry-bar"
        className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px]"
      >
        {result?.error ? (
          <div className="flex items-center gap-1.5 text-[var(--accent-signal)]">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{result.error}</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-[var(--text-secondary)]">
            <span className="flex items-center gap-1 text-[var(--accent-emerald)]">
              <Zap className="w-3 h-3" />
              {result?.engine ?? 'READY'}
            </span>
            <span>
              EXEC:{' '}
              <strong className="text-[var(--text-primary)]">
                {result ? `${result.executionMs.toFixed(2)} ms` : '--'}
              </strong>
            </span>
            <span>
              SCANNED:{' '}
              <strong className="text-[var(--text-primary)]">
                {result ? result.scannedRows.toLocaleString() : '0'}
              </strong>
            </span>
            <span>
              RETURNED:{' '}
              <strong className="text-[var(--text-primary)]">
                {result ? result.rowCount.toLocaleString() : '0'} rows
              </strong>
            </span>
            <span className="hidden sm:inline text-[var(--accent-cyan)]">
              {result && result.rowsPerSec > 0
                ? `${(result.rowsPerSec / 1_000_000).toFixed(2)}M rows/s`
                : '--'}
            </span>
          </div>
        )}
        <span className="text-[var(--text-muted)]">ARROW IPC VECTORIZED</span>
      </div>

      {/* v2.0 Sub-Tabs Bar: Results Table | Auto-Chart | Query Plan & Arrow | History */}
      <div
        role="tablist"
        aria-label="SQL Output Views"
        className="px-2.5 pt-1.5 nexus-hairline-b bg-[var(--bg-surface)] flex items-center gap-1 overflow-x-auto"
      >
        {(
          [
            {
              id: 'results' as const,
              label: copy.subtabResults,
              Icon: Table2,
              badge: result ? `${result.rowCount}` : undefined,
            },
            {
              id: 'chart' as const,
              label: copy.subtabChart,
              Icon: BarChart3,
            },
            {
              id: 'plan' as const,
              label: copy.subtabPlan,
              Icon: GitCommitHorizontal,
            },
            {
              id: 'history' as const,
              label: copy.subtabHistory,
              Icon: Clock,
              badge: history.length > 0 ? `${history.length}` : undefined,
            },
          ]
        ).map(({ id, label, Icon, badge }) => {
          const active = subTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`subtab-${id}`}
              onClick={() => setSubTab(id)}
              className={`px-2.5 py-1.5 rounded-t font-mono-tech text-[10.5px] whitespace-nowrap flex items-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
                active
                  ? 'border-[var(--accent-cyan)] text-[var(--text-primary)] bg-[var(--bg-inset)] font-semibold'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              <Icon className={`w-3 h-3 ${active ? 'text-[var(--accent-cyan)]' : ''}`} />
              <span>{label}</span>
              {badge && (
                <span className="px-1 py-0.2 rounded text-[9px] bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sub-Tab Viewport */}
      {subTab === 'results' && (
        <VirtualResultsTable
          columns={result?.columns ?? []}
          rows={result?.rows ?? []}
          heightClass="h-[228px]"
        />
      )}

      {subTab === 'chart' && <AutoChartPanel result={result} />}

      {subTab === 'plan' && (
        <QueryPlanPanel result={result} rawExplainText={rawExplainText} />
      )}

      {subTab === 'history' && (
        <div
          data-testid="query-history-panel"
          className="h-[228px] overflow-y-auto bg-[var(--bg-inset)] p-2 space-y-1.5"
        >
          {history.length === 0 ? (
            <div className="h-full flex items-center justify-center font-mono-tech text-[11px] text-[var(--text-muted)]">
              Executed SQL queries will be tracked here with latency telemetry.
            </div>
          ) : (
            history.map((entry) => (
              <div
                key={entry.id}
                data-testid="query-history-item"
                className={`p-2 rounded border bg-[var(--bg-surface)] flex items-center justify-between gap-2 transition-colors ${
                  entry.pinned
                    ? 'border-[var(--accent-cyan)]/50'
                    : 'border-[var(--border-hairline)] hover:border-[var(--border-strong)]'
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
                    <span className="text-[var(--text-muted)]">
                      {entry.rowCount} rows
                    </span>
                  </div>
                  <p className="font-mono-tech text-[9.5px] text-[var(--text-muted)] truncate m-0">
                    {entry.sql.replace(/\s+/g, ' ').trim()}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    aria-label={entry.pinned ? 'Unpin query' : 'Pin query'}
                    data-testid={`history-pin-${entry.id}`}
                    onClick={() => onTogglePinHistory(entry.id)}
                    className={`p-1.5 rounded border transition-colors cursor-pointer ${
                      entry.pinned
                        ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)]'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <Pin className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    data-testid={`history-rerun-${entry.id}`}
                    onClick={() => {
                      onRerunHistory(entry);
                      setSubTab('results');
                    }}
                    className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-signal)] hover:text-[var(--accent-signal)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 transition-colors cursor-pointer"
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
    </section>
  );
};
