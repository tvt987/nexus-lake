import React, { useMemo, useState } from 'react';
import { ArrowUpRight, Flame, Layers, TrendingUp } from 'lucide-react';
import type { CopyDict } from '../i18n';
import { buildCohortDrilldownSql, buildCohortHeatmapModel } from '../engines/cohortEngine';
import type {
  CohortCellMetric,
  CohortGranularity,
  CohortMetricMode,
  CohortSegmentFilter,
  Locale,
} from '../types/lakehouse';

interface CohortHeatmapPanelProps {
  copy: CopyDict;
  locale: Locale;
  sourceRows?: Record<string, unknown>[];
  compact?: boolean;
  onExpandFull?: () => void;
  onDrilldownSql?: (sql: string, title: string) => void;
}

const SEGMENTS: CohortSegmentFilter[] = ['ALL', 'Enterprise', 'Mid-Market', 'Growth'];

function formatMrrVnd(val: number): string {
  if (Math.abs(val) >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B ₫`;
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M ₫`;
  return `${Math.round(val).toLocaleString('en-US')} ₫`;
}

function getHeatColor(mode: CohortMetricMode, cell: CohortCellMetric): { fill: string; text: string } {
  if (mode === 'nrr_pct') {
    if (cell.nrrPct >= 112) return { fill: 'rgba(16, 185, 129, 0.36)', text: 'var(--text-primary)' };
    if (cell.nrrPct >= 100) return { fill: 'rgba(16, 185, 129, 0.22)', text: 'var(--text-primary)' };
    if (cell.nrrPct >= 88) return { fill: 'rgba(6, 182, 212, 0.22)', text: 'var(--text-primary)' };
    if (cell.nrrPct >= 74) return { fill: 'rgba(245, 158, 11, 0.22)', text: 'var(--text-primary)' };
    return { fill: 'rgba(255, 85, 0, 0.26)', text: 'var(--text-primary)' };
  }

  if (mode === 'expansion_vnd') {
    const m = cell.expansionVnd / 1_000_000;
    if (m >= 250) return { fill: 'rgba(16, 185, 129, 0.36)', text: 'var(--text-primary)' };
    if (m >= 120) return { fill: 'rgba(16, 185, 129, 0.24)', text: 'var(--text-primary)' };
    if (m >= 40) return { fill: 'rgba(6, 182, 212, 0.22)', text: 'var(--text-primary)' };
    if (m > 0) return { fill: 'rgba(6, 182, 212, 0.12)', text: 'var(--text-secondary)' };
    return { fill: 'rgba(148, 163, 184, 0.08)', text: 'var(--text-muted)' };
  }

  // Logo retention %
  if (cell.retentionPct >= 95) return { fill: 'rgba(6, 182, 212, 0.36)', text: 'var(--text-primary)' };
  if (cell.retentionPct >= 85) return { fill: 'rgba(6, 182, 212, 0.24)', text: 'var(--text-primary)' };
  if (cell.retentionPct >= 75) return { fill: 'rgba(16, 185, 129, 0.22)', text: 'var(--text-primary)' };
  if (cell.retentionPct >= 65) return { fill: 'rgba(245, 158, 11, 0.22)', text: 'var(--text-primary)' };
  return { fill: 'rgba(255, 85, 0, 0.26)', text: 'var(--text-primary)' };
}

export const CohortHeatmapPanel: React.FC<CohortHeatmapPanelProps> = ({
  copy,
  locale,
  sourceRows,
  compact = false,
  onExpandFull,
  onDrilldownSql,
}) => {
  const [granularity, setGranularity] = useState<CohortGranularity>('monthly');
  const [segment, setSegment] = useState<CohortSegmentFilter>('ALL');
  const [metricMode, setMetricMode] = useState<CohortMetricMode>('retention_pct');
  const [hovered, setHovered] = useState<{ cohort: string; cell: CohortCellMetric } | null>(null);

  const model = useMemo(
    () => buildCohortHeatmapModel(granularity, segment, sourceRows),
    [granularity, segment, sourceRows],
  );

  // SVG geometric layout
  const visibleRows = compact ? model.rows.slice(0, 5) : model.rows;
  const labelW = compact ? 76 : 112;
  const sizeW = compact ? 38 : 54;
  const colW = compact ? 54 : 86;
  const rowH = compact ? 24 : 38;
  const headerH = compact ? 20 : 28;
  const svgW = labelW + sizeW + model.periods.length * colW + 8;
  const svgH = headerH + visibleRows.length * rowH + 6;

  return (
    <section
      data-testid={compact ? 'cohort-heatmap-compact' : 'cohort-heatmap-panel'}
      className="nexus-panel rounded-md overflow-hidden flex flex-col"
    >
      {/* Header & Controls */}
      <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Flame className="w-3.5 h-3.5 text-[var(--accent-emerald)] shrink-0" />
          <h2 className="font-mono-tech text-[10.5px] font-semibold tracking-wide text-[var(--text-primary)] m-0 truncate">
            {compact ? 'COHORT RETENTION HEATMAP' : copy.cohortStudioTitle}
          </h2>
          {!compact && (
            <span className="hidden sm:inline font-mono-tech text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]">
              {model.granularity === 'monthly' ? 'M0 -> M6' : 'W0 -> W6'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Granularity Toggle */}
          {!compact && (
            <div className="flex items-center rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] p-0.5 font-mono-tech text-[9.5px]">
              <button
                type="button"
                data-testid="cohort-granularity-monthly"
                onClick={() => setGranularity('monthly')}
                className={`px-2 py-0.5 rounded-[3px] cursor-pointer ${
                  granularity === 'monthly'
                    ? 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {copy.cohortMonthly}
              </button>
              <button
                type="button"
                data-testid="cohort-granularity-weekly"
                onClick={() => setGranularity('weekly')}
                className={`px-2 py-0.5 rounded-[3px] cursor-pointer ${
                  granularity === 'weekly'
                    ? 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {copy.cohortWeekly}
              </button>
            </div>
          )}

          {/* Segment Filter */}
          {!compact && (
            <select
              aria-label="Cohort segment filter"
              data-testid="cohort-segment-select"
              value={segment}
              onChange={(e) => setSegment(e.target.value as CohortSegmentFilter)}
              className="px-2 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-mono-tech text-[10px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-cyan)] cursor-pointer"
            >
              {SEGMENTS.map((seg) => (
                <option key={seg} value={seg}>
                  {seg === 'ALL' ? (locale === 'vi' ? 'Tất cả phân khúc' : 'All Segments') : seg}
                </option>
              ))}
            </select>
          )}

          {/* Metric Mode Selector */}
          <div className="flex items-center rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] p-0.5 font-mono-tech text-[9.5px]">
            {(
              [
                { id: 'retention_pct' as const, label: compact ? 'Ret %' : copy.cohortRetentionMode },
                { id: 'nrr_pct' as const, label: compact ? 'NRR %' : copy.cohortNrrMode },
                { id: 'expansion_vnd' as const, label: compact ? 'Exp ₫' : copy.cohortExpansionMode },
              ]
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                data-testid={`cohort-mode-${m.id}`}
                onClick={() => setMetricMode(m.id)}
                className={`px-2 py-0.5 rounded-[3px] cursor-pointer whitespace-nowrap ${
                  metricMode === m.id
                    ? 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {compact && onExpandFull && (
            <button
              type="button"
              data-testid="cohort-expand-full-btn"
              onClick={onExpandFull}
              className="px-2 py-0.5 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] font-mono-tech text-[9.5px] text-[var(--text-primary)] flex items-center gap-1 cursor-pointer"
            >
              <span>Studio</span>
              <ArrowUpRight className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Executive Cohort KPI Strip */}
      <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-surface)]/55 grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {[
          {
            label: compact ? 'M3 RET' : locale === 'vi' ? 'GIỮ CHÂN TRUNG BÌNH M3' : 'AVG M3 RETENTION',
            value: `${model.summary.avgM3RetentionPct.toFixed(1)}%`,
            tone: 'text-[var(--accent-cyan)]',
          },
          {
            label: compact ? 'NET NRR' : locale === 'vi' ? 'MỞ RỘNG DOANH THU NRR' : 'NET REVENUE RETENTION',
            value: `${model.summary.avgLatestNrrPct.toFixed(1)}%`,
            tone:
              model.summary.avgLatestNrrPct >= 100
                ? 'text-[var(--accent-emerald)]'
                : 'text-[var(--accent-amber)]',
          },
          {
            label: compact ? 'EXP MRR' : locale === 'vi' ? 'MRR MỞ RỘNG TÍCH LŨY' : 'EXPANSION MRR',
            value: `+${formatMrrVnd(model.summary.totalExpansionMrrVnd)}`,
            tone: 'text-[var(--accent-emerald)]',
          },
          {
            label: compact ? 'CHURN RISK' : locale === 'vi' ? 'MRR RỜI BỎ RỦI RO' : 'CHURNED MRR AT RISK',
            value: formatMrrVnd(model.summary.churnedMrrAtRiskVnd),
            tone: 'text-[var(--accent-signal)]',
          },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)]"
          >
            <div className="font-mono-tech text-[8.5px] tracking-wider text-[var(--text-muted)] truncate">
              {kpi.label}
            </div>
            <div className={`font-mono-tech text-xs font-bold mt-0.5 tabular-nums ${kpi.tone}`}>
              {kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* Live Hover Telemetry Readout */}
      {(!compact || hovered) && (
        <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-inset)] flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px]">
          {hovered ? (
            <div className="flex flex-wrap items-center gap-3 text-[var(--text-secondary)]">
              <span className="text-[var(--accent-cyan)] font-semibold">
                {hovered.cohort} · {model.periods[hovered.cell.periodIndex]}
              </span>
              <span>
                Retained: <strong className="text-[var(--text-primary)]">{hovered.cell.activeAccounts}</strong>
                {' / '}
                Churned: <strong className="text-[var(--accent-signal)]">{hovered.cell.churnedAccounts}</strong>
              </span>
              <span>
                Retention: <strong className="text-[var(--accent-cyan)]">{hovered.cell.retentionPct}%</strong>
              </span>
              <span>
                NRR: <strong className="text-[var(--accent-emerald)]">{hovered.cell.nrrPct}%</strong>
              </span>
              <span>
                Expansion: <strong className="text-[var(--accent-emerald)]">+{formatMrrVnd(hovered.cell.expansionVnd)}</strong>
              </span>
            </div>
          ) : (
            <span className="text-[var(--text-muted)] flex items-center gap-1.5">
              <TrendingUp className="w-3 h-3 text-[var(--accent-emerald)]" />
              {locale === 'vi'
                ? 'Di chuột vào từng ô để xem chi tiết tài khoản giữ chân & mở rộng doanh thu. Nhấn vào dòng cohort để mở SQL drill-down.'
                : 'Hover any cohort cell for account retention & expansion telemetry. Click a cohort row to launch SQL drill-down in the Notebook.'}
            </span>
          )}
          <span className="text-[var(--text-muted)] flex items-center gap-1">
            <Layers className="w-3 h-3" />
            {model.summary.totalAccounts} accts
          </span>
        </div>
      )}

      {/* Interactive SVG Heatmap Matrix */}
      <div className="p-2 bg-[var(--bg-inset)] overflow-x-auto">
        <svg
          data-testid="cohort-heatmap-svg"
          viewBox={`0 0 ${svgW} ${svgH}`}
          className={`w-full ${compact ? 'min-w-[440px]' : 'min-w-[660px]'} h-auto select-none block`}
          role="img"
          aria-label="Interactive SaaS Cohort Retention and Revenue Expansion Heatmap"
          onMouseLeave={() => setHovered(null)}
        >
          {/* Column Headers */}
          <text
            x="8"
            y={compact ? '13' : '18'}
            fill="var(--text-muted)"
            fontSize={compact ? '8.5' : '10'}
            fontFamily="JetBrains Mono, monospace"
            fontWeight="600"
          >
            COHORT
          </text>
          <text
            x={labelW + sizeW - 6}
            y={compact ? '13' : '18'}
            textAnchor="end"
            fill="var(--text-muted)"
            fontSize={compact ? '8.5' : '10'}
            fontFamily="JetBrains Mono, monospace"
            fontWeight="600"
          >
            {compact ? 'N' : 'USERS'}
          </text>
          {model.periods.map((period, pIdx) => (
            <text
              key={period}
              x={labelW + sizeW + pIdx * colW + colW / 2}
              y={compact ? '13' : '18'}
              textAnchor="middle"
              fill="var(--text-secondary)"
              fontSize={compact ? '8.5' : '10'}
              fontFamily="JetBrains Mono, monospace"
              fontWeight="600"
            >
              {period}
            </text>
          ))}

          {/* Cohort Rows */}
          {visibleRows.map((row, rIdx) => {
            const y = headerH + rIdx * rowH;
            return (
              <g key={row.cohortLabel}>
                {/* Clickable Cohort Label for SQL Drilldown */}
                <g
                  className={onDrilldownSql ? 'cursor-pointer' : undefined}
                  onClick={() => {
                    if (!onDrilldownSql) return;
                    const sql = buildCohortDrilldownSql(row.cohortLabel, segment);
                    onDrilldownSql(sql, `Cohort Drilldown ${row.cohortLabel} (${segment})`);
                  }}
                >
                  <rect
                    x="2"
                    y={y + 2}
                    width={labelW - 6}
                    height={rowH - 4}
                    rx="4"
                    fill="var(--bg-surface)"
                    stroke="var(--border-hairline)"
                  />
                  <text
                    x={compact ? '8' : '12'}
                    y={y + rowH / 2 + 3.5}
                    fill="var(--accent-cyan)"
                    fontSize={compact ? '9' : '10.5'}
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight="600"
                  >
                    {row.cohortLabel}
                  </text>
                </g>

                {/* Cohort Initial Account Count */}
                <text
                  x={labelW + sizeW - 6}
                  y={y + rowH / 2 + 3.5}
                  textAnchor="end"
                  fill="var(--text-secondary)"
                  fontSize={compact ? '9' : '10.5'}
                  fontFamily="JetBrains Mono, monospace"
                >
                  {row.cohortSize}
                </text>

                {/* Period Cells M0 -> M6 */}
                {row.cells.map((cell, cIdx) => {
                  const x = labelW + sizeW + cIdx * colW + 3;
                  const cellW = colW - 6;
                  const cellH = rowH - 5;

                  if (!cell) {
                    return (
                      <rect
                        key={cIdx}
                        x={x}
                        y={y + 2.5}
                        width={cellW}
                        height={cellH}
                        rx="4"
                        fill="var(--bg-surface)"
                        opacity="0.28"
                      />
                    );
                  }

                  const { fill, text } = getHeatColor(metricMode, cell);
                  const isHovered =
                    hovered?.cohort === row.cohortLabel && hovered?.cell.periodIndex === cIdx;

                  const mainText =
                    metricMode === 'retention_pct'
                      ? `${cell.retentionPct.toFixed(1)}%`
                      : metricMode === 'nrr_pct'
                        ? `${cell.nrrPct.toFixed(1)}%`
                        : `+${(cell.expansionVnd / 1_000_000).toFixed(0)}M`;

                  const subText =
                    metricMode === 'retention_pct'
                      ? `NRR ${cell.nrrPct.toFixed(0)}%`
                      : metricMode === 'nrr_pct'
                        ? `${cell.activeAccounts} accts`
                        : `${cell.retentionPct.toFixed(0)}% ret`;

                  return (
                    <g
                      key={cIdx}
                      onMouseEnter={() => setHovered({ cohort: row.cohortLabel, cell })}
                      className="cursor-crosshair"
                    >
                      <rect
                        x={x}
                        y={y + 2.5}
                        width={cellW}
                        height={cellH}
                        rx="4"
                        fill={fill}
                        stroke={isHovered ? 'var(--text-primary)' : 'var(--border-hairline)'}
                        strokeWidth={isHovered ? 1.4 : 0.7}
                      />
                      <text
                        x={x + cellW / 2}
                        y={compact ? y + cellH / 2 + 5 : y + cellH / 2 + 1}
                        textAnchor="middle"
                        fill={text}
                        fontSize={compact ? '8.5' : '10.5'}
                        fontFamily="JetBrains Mono, monospace"
                        fontWeight="700"
                      >
                        {compact && metricMode === 'retention_pct'
                          ? `${Math.round(cell.retentionPct)}%`
                          : mainText}
                      </text>
                      {!compact && (
                        <text
                          x={x + cellW / 2}
                          y={y + cellH - 4}
                          textAnchor="middle"
                          fill="var(--text-muted)"
                          fontSize="8.5"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {subText}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
};
