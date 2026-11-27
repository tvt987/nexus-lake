import React, { useEffect, useMemo, useState } from 'react';
import { Grid3X3 } from 'lucide-react';
import type { CopyDict } from '../i18n';
import {
  classifyPivotColumns,
  computePivotMatrix,
  formatPivotValue,
  suggestPivotConfig,
} from '../engines/pivotEngine';
import type { PivotAggregation, PivotConfig, SqlQueryResult } from '../types/lakehouse';

interface PivotMatrixPanelProps {
  copy: CopyDict;
  result: SqlQueryResult | null;
  initialConfig?: PivotConfig;
  onConfigChange?: (config: PivotConfig) => void;
  heightClass?: string;
}

const AGGREGATIONS: PivotAggregation[] = ['SUM', 'AVG', 'COUNT', 'MAX'];

export const PivotMatrixPanel: React.FC<PivotMatrixPanelProps> = ({
  copy,
  result,
  initialConfig,
  onConfigChange,
  heightClass = 'h-[244px]',
}) => {
  const columnsKey = result?.columns.join('|') ?? '';

  const suggested = useMemo(() => suggestPivotConfig(result), [result]);
  const [config, setConfig] = useState<PivotConfig | null>(initialConfig ?? suggested);

  useEffect(() => {
    if (!result || result.columns.length === 0) {
      setConfig(null);
      return;
    }
    const validCols = new Set(result.columns);
    if (
      initialConfig &&
      validCols.has(initialConfig.rowDim) &&
      validCols.has(initialConfig.colDim) &&
      validCols.has(initialConfig.metricCol)
    ) {
      setConfig(initialConfig);
    } else {
      setConfig(suggestPivotConfig(result));
    }
  }, [columnsKey, initialConfig, result]);

  const { dimensions, metrics } = useMemo(() => {
    if (!result) return { dimensions: [], metrics: [] };
    return classifyPivotColumns(result.columns, result.rows);
  }, [result]);

  const pivot = useMemo(() => {
    if (!result || result.error || result.rows.length === 0 || !config) return null;
    return computePivotMatrix(result.rows, config);
  }, [result, config]);

  const updateConfig = (patch: Partial<PivotConfig>) => {
    if (!config) return;
    const next = { ...config, ...patch };
    setConfig(next);
    onConfigChange?.(next);
  };

  if (!result || result.error || result.rows.length === 0 || !config || !pivot) {
    return (
      <div
        data-testid="pivot-matrix-empty"
        className={`${heightClass} flex flex-col items-center justify-center gap-1.5 bg-[var(--bg-inset)] text-center px-4`}
      >
        <Grid3X3 className="w-5 h-5 text-[var(--text-muted)] opacity-60" />
        <p className="font-mono-tech text-[11px] text-[var(--text-muted)]">
          Run a SQL query with categorical and numeric columns to inspect the Cross-Tab Pivot Matrix.
        </p>
      </div>
    );
  }

  const allColumns = result.columns;
  const metricOptions = metrics.length > 0 ? metrics : allColumns;
  const span = Math.max(1e-6, pivot.maxCellValue - pivot.minCellValue);

  return (
    <div
      data-testid="pivot-matrix-panel"
      className={`${heightClass} flex flex-col bg-[var(--bg-inset)] overflow-hidden`}
    >
      {/* Pivot Dimension & Aggregation Toolbar */}
      <div className="px-2.5 py-1.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center gap-2 font-mono-tech text-[10px]">
        <label className="flex items-center gap-1 text-[var(--text-muted)]">
          <span>{copy.pivotRowDim}:</span>
          <select
            aria-label="Pivot Row Dimension"
            data-testid="pivot-row-select"
            value={config.rowDim}
            onChange={(e) => updateConfig({ rowDim: e.target.value })}
            className="px-1.5 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-cyan)] max-w-[125px]"
          >
            {(dimensions.length > 0 ? dimensions : allColumns).map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
            {allColumns
              .filter((c) => !dimensions.includes(c))
              .map((col) => (
                <option key={`extra-r-${col}`} value={col}>
                  {col}
                </option>
              ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-[var(--text-muted)]">
          <span>{copy.pivotColDim}:</span>
          <select
            aria-label="Pivot Column Dimension"
            data-testid="pivot-col-select"
            value={config.colDim}
            onChange={(e) => updateConfig({ colDim: e.target.value })}
            className="px-1.5 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-cyan)] max-w-[125px]"
          >
            {allColumns.map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-[var(--text-muted)]">
          <span>{copy.pivotMetric}:</span>
          <select
            aria-label="Pivot Metric Column"
            data-testid="pivot-metric-select"
            value={config.metricCol}
            onChange={(e) => updateConfig({ metricCol: e.target.value })}
            className="px-1.5 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-cyan)] max-w-[140px]"
          >
            {metricOptions.map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] p-0.5">
          {AGGREGATIONS.map((agg) => {
            const active = config.aggregation === agg;
            return (
              <button
                key={agg}
                type="button"
                data-testid={`pivot-agg-${agg}`}
                onClick={() => updateConfig({ aggregation: agg })}
                className={`px-1.5 py-0.5 rounded-[3px] text-[9.5px] transition-colors cursor-pointer ${
                  active
                    ? 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {agg}
              </button>
            );
          })}
        </div>

        <span className="ml-auto text-[9.5px] text-[var(--text-muted)] hidden sm:inline">
          {pivot.rowKeys.length} x {pivot.colKeys.length} matrix
          {pivot.truncatedCols > 0 ? ` (+${pivot.truncatedCols} cols)` : ''}
        </span>
      </div>

      {/* Scrollable Cross-Tab Matrix Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-left font-mono-tech text-[10.5px]">
          <thead className="sticky top-0 z-10 bg-[var(--bg-elevated)] nexus-hairline-b">
            <tr>
              <th className="sticky left-0 z-20 bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[9.5px] uppercase tracking-wider text-[var(--text-muted)] border-r border-[var(--border-strong)] whitespace-nowrap">
                {config.rowDim} \ {config.colDim}
              </th>
              {pivot.colKeys.map((cKey) => (
                <th
                  key={cKey}
                  className="px-2.5 py-1.5 text-right text-[9.5px] uppercase tracking-wider text-[var(--text-secondary)] border-r border-[var(--border-hairline)] whitespace-nowrap"
                >
                  {cKey.length > 16 ? `${cKey.slice(0, 15)}..` : cKey}
                </th>
              ))}
              <th className="px-2.5 py-1.5 text-right text-[9.5px] uppercase tracking-wider text-[var(--accent-cyan)] whitespace-nowrap">
                TOTAL ({config.aggregation})
              </th>
            </tr>
          </thead>
          <tbody>
            {pivot.rowKeys.map((rKey) => (
              <tr
                key={rKey}
                className="border-b border-[var(--border-hairline)] hover:bg-[var(--bg-elevated)]/60 transition-colors"
              >
                <td className="sticky left-0 z-10 bg-[var(--bg-surface)] px-2.5 py-1.5 font-medium text-[var(--text-primary)] border-r border-[var(--border-strong)] whitespace-nowrap">
                  {rKey.length > 24 ? `${rKey.slice(0, 23)}..` : rKey}
                </td>
                {pivot.colKeys.map((cKey) => {
                  const cell = pivot.matrix[rKey]?.[cKey];
                  const hasVal = cell && cell.count > 0;
                  const norm = hasVal ? Math.max(0, Math.min(1, (cell.value - pivot.minCellValue) / span)) : 0;
                  const bgAlpha = hasVal ? (0.06 + norm * 0.24).toFixed(3) : '0';
                  return (
                    <td
                      key={cKey}
                      className="px-2.5 py-1.5 text-right border-r border-[var(--border-hairline)] whitespace-nowrap"
                      style={{
                        backgroundColor: hasVal
                          ? norm >= 0.82
                            ? `rgba(255, 85, 0, ${bgAlpha})`
                            : `rgba(6, 182, 212, ${bgAlpha})`
                          : undefined,
                      }}
                    >
                      {hasVal ? (
                        <span
                          className={
                            norm >= 0.82
                              ? 'text-[var(--accent-signal)] font-semibold'
                              : 'text-[var(--text-primary)]'
                          }
                        >
                          {formatPivotValue(config.metricCol, config.aggregation, cell.value)}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)] opacity-40">--</span>
                      )}
                    </td>
                  );
                })}
                <td className="px-2.5 py-1.5 text-right font-semibold text-[var(--accent-cyan)] bg-[var(--bg-surface)]/70 whitespace-nowrap">
                  {formatPivotValue(config.metricCol, config.aggregation, pivot.rowTotals[rKey] ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 z-10 bg-[var(--bg-elevated)] nexus-hairline-t">
            <tr>
              <td className="sticky left-0 z-20 bg-[var(--bg-elevated)] px-2.5 py-1.5 font-semibold text-[10px] uppercase text-[var(--accent-cyan)] border-r border-[var(--border-strong)] whitespace-nowrap">
                GRAND TOTAL
              </td>
              {pivot.colKeys.map((cKey) => (
                <td
                  key={`tot-${cKey}`}
                  className="px-2.5 py-1.5 text-right font-semibold text-[var(--text-primary)] border-r border-[var(--border-hairline)] whitespace-nowrap"
                >
                  {formatPivotValue(config.metricCol, config.aggregation, pivot.colTotals[cKey] ?? 0)}
                </td>
              ))}
              <td className="px-2.5 py-1.5 text-right font-bold text-[var(--accent-signal)] whitespace-nowrap">
                {formatPivotValue(config.metricCol, config.aggregation, pivot.grandTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
};
