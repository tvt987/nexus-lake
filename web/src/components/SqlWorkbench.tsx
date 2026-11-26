import React from 'react';
import {
  AlertTriangle,
  Download,
  Play,
  Terminal,
  Zap,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import { SQL_PRESETS } from '../engine/sqlPresets';
import type { SqlQueryResult } from '../types/lakehouse';
import { VirtualResultsTable } from './VirtualResultsTable';

interface SqlWorkbenchProps {
  copy: CopyDict;
  sql: string;
  onSqlChange: (next: string) => void;
  onRunSql: (sqlOverride?: string) => Promise<void>;
  isRunning: boolean;
  result: SqlQueryResult | null;
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

export const SqlWorkbench: React.FC<SqlWorkbenchProps> = ({
  copy,
  sql,
  onSqlChange,
  onRunSql,
  isRunning,
  result,
}) => {
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
    <section className="nexus-panel rounded-md flex flex-col overflow-hidden">
      {/* Header & 6 Curated Presets */}
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
            onClick={() => void onRunSql()}
            className="px-3 py-1 rounded bg-[var(--accent-signal)] hover:brightness-110 text-white font-mono-tech text-[11px] font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
          >
            <Play className="w-3 h-3 fill-current" />
            {isRunning ? 'EXEC...' : copy.runQuery}
          </button>
        </div>
      </div>

      {/* 6 Preset Pills Bar */}
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
                void onRunSql(preset.sql);
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

      {/* Editor Area with Gutter */}
      <div className="flex bg-[var(--bg-inset)] nexus-hairline-b">
        <div
          aria-hidden="true"
          className="py-2.5 px-2.5 text-right select-none font-mono-tech text-[11px] leading-[1.55] text-[var(--text-muted)] opacity-55 border-r border-[var(--border-hairline)] bg-[var(--bg-surface)]"
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
              void onRunSql();
            }
          }}
          spellCheck={false}
          rows={Math.min(9, Math.max(6, lineCount))}
          className="flex-1 p-2.5 bg-transparent font-mono-tech text-[11.5px] leading-[1.5] text-[var(--text-primary)] focus:outline-none resize-y"
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

      {/* Virtualized Results Grid */}
      <VirtualResultsTable
        columns={result?.columns ?? []}
        rows={result?.rows ?? []}
        heightClass="h-[192px]"
      />
    </section>
  );
};
