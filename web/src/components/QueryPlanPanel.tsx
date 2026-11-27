import React, { useMemo, useState } from 'react';
import { ArrowRight, Code2, Cpu, Gauge, Layers } from 'lucide-react';
import { buildQueryPlanAnalysis, formatByteSize } from '../engine/queryPlanParser';
import type { SqlQueryResult } from '../types/lakehouse';

interface QueryPlanPanelProps {
  result: SqlQueryResult | null;
  rawExplainText?: string | null;
}

const OP_ACCENT: Record<string, string> = {
  ARROW_SCAN: 'border-[var(--accent-cyan)] text-[var(--accent-cyan)]',
  FILTER: 'border-[var(--accent-amber)] text-[var(--accent-amber)]',
  HASH_AGG: 'border-[var(--accent-signal)] text-[var(--accent-signal)]',
  WINDOW: 'border-[var(--accent-emerald)] text-[var(--accent-emerald)]',
  TOP_N: 'border-[var(--accent-emerald)] text-[var(--accent-emerald)]',
  ORDER_BY: 'border-[var(--accent-emerald)] text-[var(--accent-emerald)]',
  HASH_JOIN: 'border-[var(--accent-signal)] text-[var(--accent-signal)]',
  PROJECTION: 'border-[var(--border-strong)] text-[var(--text-secondary)]',
};

const BUFFER_COLORS = [
  '#2563EB',
  '#0D9488',
  '#059669',
  '#D97706',
  '#6366F1',
  '#64748B',
];

export const QueryPlanPanel: React.FC<QueryPlanPanelProps> = ({ result, rawExplainText }) => {
  const [showRawExplain, setShowRawExplain] = useState(false);

  const analysis = useMemo(
    () => buildQueryPlanAnalysis(result, rawExplainText),
    [result, rawExplainText],
  );

  if (!analysis) {
    return (
      <div className="h-[228px] flex flex-col items-center justify-center gap-1.5 bg-[var(--bg-inset)] text-center px-4">
        <Layers className="w-5 h-5 text-[var(--text-muted)] opacity-60" />
        <p className="font-mono-tech text-[11px] text-[var(--text-muted)]">
          Execute a valid SQL query to inspect physical EXPLAIN stages & Arrow IPC buffers.
        </p>
      </div>
    );
  }

  const throughputMillions = analysis.rowsPerSec / 1_000_000;
  const throughputGaugePct = Math.min(100, Math.max(8, (throughputMillions / 6) * 100));

  return (
    <div
      data-testid="query-plan-panel"
      className="h-[228px] flex flex-col bg-[var(--bg-inset)] overflow-hidden"
    >
      {/* Top Plan Header & Throughput Bar */}
      <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-mono-tech text-[10px]">
          <span className="px-1.5 py-0.5 rounded bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold">
            {analysis.source === 'DUCKDB_EXPLAIN' ? 'EXPLAIN PHYSICAL' : 'VECTORIZED PIPELINE'}
          </span>
          <span className="text-[var(--text-muted)] flex items-center gap-1">
            <Gauge className="w-3 h-3 text-[var(--accent-emerald)]" />
            <strong className="text-[var(--text-primary)]">
              {throughputMillions.toFixed(2)}M
            </strong>{' '}
            rows/s
          </span>
          <div className="hidden sm:flex items-center gap-1.5">
            <div className="w-20 h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
              <div
                className="h-full bg-[var(--accent-emerald)] rounded-full transition-all duration-300"
                style={{ width: `${throughputGaugePct}%` }}
              />
            </div>
            <span className="text-[var(--text-muted)]">{analysis.totalExecutionMs.toFixed(2)}ms</span>
          </div>
        </div>

        <button
          type="button"
          data-testid="toggle-raw-explain"
          onClick={() => setShowRawExplain((s) => !s)}
          className="px-2 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
        >
          <Code2 className="w-3 h-3" />
          {showRawExplain ? 'Visual DAG' : 'Raw EXPLAIN'}
        </button>
      </div>

      {/* Main Content */}
      {showRawExplain ? (
        <pre className="flex-1 m-0 p-3 overflow-auto font-mono-tech text-[10.5px] leading-relaxed text-[var(--text-secondary)] bg-[var(--bg-inset)]">
          {analysis.rawExplainText}
        </pre>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
          {/* v4.0 Query Plan Cost Inspector Telemetry Strip */}
          <div
            data-testid="query-cost-strip"
            className="grid grid-cols-3 gap-2 font-mono-tech text-[9.5px]"
          >
            <div className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] flex items-center justify-between gap-1">
              <span className="text-[var(--text-muted)]">EST. SCAN</span>
              <span className="text-[var(--text-primary)] font-semibold tabular-nums">
                {analysis.estimatedScanRows.toLocaleString()} rows
              </span>
            </div>
            <div className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] flex items-center justify-between gap-1">
              <span className="text-[var(--text-muted)]">PRUNING</span>
              <span className="text-[var(--accent-emerald)] font-semibold tabular-nums">
                {(analysis.partitionPruningRatio * 100).toFixed(0)}% pruned
              </span>
            </div>
            <div className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] flex items-center justify-between gap-1">
              <span className="text-[var(--text-muted)]">MEMORY</span>
              <span className="text-[var(--accent-cyan)] font-semibold tabular-nums">
                {analysis.memoryFootprintMb.toFixed(2)} MB
              </span>
            </div>
          </div>

          {/* Physical Execution Pipeline DAG */}
          <div className="overflow-x-auto pb-1">
            <div className="flex items-stretch gap-1 min-w-max sm:min-w-0">
              {analysis.stages.map((stage, idx) => {
                const badgeClass =
                  OP_ACCENT[stage.operator] ??
                  'border-[var(--border-strong)] text-[var(--text-primary)]';
                return (
                  <React.Fragment key={stage.id}>
                    <div
                      data-testid={`plan-stage-${stage.operator}`}
                      className="flex-1 min-w-[126px] p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className={`px-1.5 py-0.5 rounded border font-mono-tech text-[9.5px] font-semibold ${badgeClass}`}
                        >
                          {stage.operator}
                        </span>
                        <span className="font-mono-tech text-[9.5px] text-[var(--text-primary)] font-semibold">
                          {stage.timingMs}ms
                        </span>
                      </div>

                      <p
                        className="font-mono-tech text-[9px] text-[var(--text-muted)] truncate"
                        title={stage.detail}
                      >
                        {stage.detail}
                      </p>

                      {/* Timing Share Bar + Row Funnel */}
                      <div className="space-y-1">
                        <div className="h-1 w-full rounded bg-[var(--bg-elevated)] overflow-hidden">
                          <div
                            className="h-full bg-[var(--accent-cyan)]"
                            style={{ width: `${Math.max(8, stage.sharePct)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between font-mono-tech text-[8.5px] text-[var(--text-muted)]">
                          <span>
                            {stage.estimatedRowsIn.toLocaleString()} -&gt;{' '}
                            <strong className="text-[var(--text-secondary)]">
                              {stage.estimatedRowsOut.toLocaleString()}
                            </strong>
                          </span>
                          <span>{stage.sharePct}%</span>
                        </div>
                      </div>
                    </div>

                    {idx < analysis.stages.length - 1 && (
                      <div className="flex items-center text-[var(--text-muted)] shrink-0">
                        <ArrowRight className="w-3.5 h-3.5" />
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>

          {/* Arrow IPC Columnar Buffer Memory Breakdown */}
          <div className="p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px]">
              <span className="text-[var(--text-secondary)] font-semibold flex items-center gap-1.5">
                <Cpu className="w-3 h-3 text-[var(--accent-cyan)]" />
                ARROW IPC COLUMNAR MEMORY ({analysis.scannedRows.toLocaleString()} ROWS)
              </span>
              <span className="text-[var(--accent-emerald)] font-semibold">
                {formatByteSize(analysis.arrowTotalBytes)} ZERO-COPY
              </span>
            </div>

            {/* Segmented Columnar Allocation Bar */}
            <div className="h-2 w-full rounded overflow-hidden flex bg-[var(--bg-elevated)]">
              {analysis.arrowBuffers.slice(0, 6).map((buf, idx) => (
                <div
                  key={buf.column}
                  style={{
                    width: `${Math.max(3, buf.sharePct)}%`,
                    backgroundColor: BUFFER_COLORS[idx % BUFFER_COLORS.length],
                  }}
                  title={`${buf.column} (${buf.arrowType}): ${formatByteSize(buf.bytes)} (${buf.sharePct}%)`}
                />
              ))}
            </div>

            {/* Top Column Buffers Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 pt-0.5">
              {analysis.arrowBuffers.slice(0, 6).map((buf, idx) => (
                <div
                  key={buf.column}
                  className="flex items-center justify-between gap-1 font-mono-tech text-[9.5px] min-w-0"
                >
                  <span className="flex items-center gap-1 min-w-0">
                    <span
                      className="w-1.5 h-1.5 rounded-[1px] shrink-0"
                      style={{ backgroundColor: BUFFER_COLORS[idx % BUFFER_COLORS.length] }}
                    />
                    <span className="text-[var(--text-primary)] truncate">{buf.column}</span>
                  </span>
                  <span className="text-[var(--text-muted)] shrink-0">
                    {formatByteSize(buf.bytes)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
