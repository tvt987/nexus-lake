import React, { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, LayoutGrid } from 'lucide-react';
import { extractAutoChart, formatChartMetricValue } from '../engine/autoChart';
import type { AutoChartType, SqlQueryResult } from '../types/lakehouse';

interface AutoChartPanelProps {
  result: SqlQueryResult | null;
}

export const AutoChartPanel: React.FC<AutoChartPanelProps> = ({ result }) => {
  const [preferredMetric, setPreferredMetric] = useState<string | undefined>(undefined);
  const [chartTypeOverride, setChartTypeOverride] = useState<AutoChartType | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Reset overrides when query schema changes
  const columnsKey = result?.columns.join('|') ?? '';
  useEffect(() => {
    setPreferredMetric(undefined);
    setChartTypeOverride(null);
    setHoveredIdx(null);
  }, [columnsKey]);

  const model = useMemo(
    () => extractAutoChart(result, preferredMetric),
    [result, preferredMetric],
  );

  if (!model) {
    return (
      <div
        data-testid="auto-chart-empty"
        className="h-[228px] flex flex-col items-center justify-center gap-1.5 bg-[var(--bg-inset)] text-center px-4"
      >
        <BarChart3 className="w-5 h-5 text-[var(--text-muted)] opacity-60" />
        <p className="font-mono-tech text-[11px] text-[var(--text-muted)]">
          Run a SQL query with numeric columns to auto-generate interactive charts.
        </p>
      </div>
    );
  }

  const activeType: AutoChartType = chartTypeOverride ?? model.recommendedType;
  const activePoint =
    hoveredIdx !== null && model.points[hoveredIdx] ? model.points[hoveredIdx] : null;

  return (
    <div
      data-testid="auto-chart-panel"
      className="h-[228px] flex flex-col bg-[var(--bg-inset)] overflow-hidden"
    >
      {/* Chart Control Toolbar */}
      <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="flex items-center rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] p-0.5">
            {(
              [
                { id: 'bar', label: 'Bar', Icon: BarChart3 },
                { id: 'area', label: 'Area', Icon: Activity },
                { id: 'metric', label: 'Breakdown', Icon: LayoutGrid },
              ] as const
            ).map(({ id, label, Icon }) => {
              const selected = activeType === id;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`chart-mode-${id}`}
                  onClick={() => setChartTypeOverride(id)}
                  className={`px-2 py-0.5 rounded-[3px] font-mono-tech text-[10px] flex items-center gap-1 transition-colors cursor-pointer ${
                    selected
                      ? 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <Icon className="w-2.5 h-2.5" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          <select
            aria-label="Chart metric column"
            data-testid="chart-metric-select"
            value={model.metricColumn}
            onChange={(e) => setPreferredMetric(e.target.value)}
            className="px-2 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-mono-tech text-[10px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-cyan)] cursor-pointer max-w-[165px]"
          >
            {model.numericColumns.map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3 font-mono-tech text-[10px] text-[var(--text-muted)]">
          {activePoint ? (
            <span className="text-[var(--text-primary)] font-medium truncate max-w-[230px]">
              {activePoint.label}:{' '}
              <strong className="text-[var(--accent-cyan)]">
                {formatChartMetricValue(model.metricColumn, activePoint.value)}
              </strong>
            </span>
          ) : (
            <>
              <span>
                MAX{' '}
                <strong className="text-[var(--text-primary)]">
                  {formatChartMetricValue(model.metricColumn, model.summary.max)}
                </strong>
              </span>
              <span className="hidden sm:inline">
                AVG{' '}
                <strong className="text-[var(--text-primary)]">
                  {formatChartMetricValue(model.metricColumn, model.summary.avg)}
                </strong>
              </span>
              <span className="hidden md:inline">
                SUM{' '}
                <strong className="text-[var(--accent-cyan)]">
                  {formatChartMetricValue(model.metricColumn, model.summary.sum)}
                </strong>
              </span>
            </>
          )}
        </div>
      </div>

      {/* Interactive SVG / Breakdown Viewport */}
      <div className="flex-1 min-h-0 px-2.5 py-2 overflow-hidden">
        {activeType === 'bar' && (
          <BarChartSvg
            model={model}
            hoveredIdx={hoveredIdx}
            onHover={setHoveredIdx}
          />
        )}
        {activeType === 'area' && (
          <AreaTrendSvg
            model={model}
            hoveredIdx={hoveredIdx}
            onHover={setHoveredIdx}
          />
        )}
        {activeType === 'metric' && <MetricBreakdownView model={model} />}
      </div>
    </div>
  );
};

interface ChartSvgProps {
  model: NonNullable<ReturnType<typeof extractAutoChart>>;
  hoveredIdx: number | null;
  onHover: (idx: number | null) => void;
}

const BarChartSvg: React.FC<ChartSvgProps> = ({ model, hoveredIdx, onHover }) => {
  const width = 640;
  const height = 168;
  const padL = 56;
  const padR = 14;
  const padT = 14;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxVal = Math.max(1e-6, model.summary.max);
  const count = model.points.length;
  const slotW = plotW / Math.max(1, count);
  const barW = Math.max(6, Math.min(44, slotW * 0.68));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-full select-none"
      role="img"
      aria-label={`Bar chart of ${model.metricColumn} by ${model.labelColumn}`}
      onMouseLeave={() => onHover(null)}
    >
      <defs>
        <linearGradient id="nexusBarCyan" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.28" />
        </linearGradient>
        <linearGradient id="nexusBarSignal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-signal)" stopOpacity="0.98" />
          <stop offset="100%" stopColor="var(--accent-signal)" stopOpacity="0.32" />
        </linearGradient>
      </defs>

      {/* Horizontal Hairline Gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
        const y = padT + plotH * (1 - tick);
        const tickVal = maxVal * tick;
        return (
          <g key={tick}>
            <line
              x1={padL}
              y1={y}
              x2={width - padR}
              y2={y}
              stroke="var(--border-hairline)"
              strokeDasharray={tick === 0 ? undefined : '2 3'}
            />
            <text
              x={padL - 6}
              y={y + 3}
              textAnchor="end"
              fill="var(--text-muted)"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
            >
              {formatChartMetricValue(model.metricColumn, tickVal)}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {model.points.map((pt, idx) => {
        const ratio = Math.max(0, pt.value) / maxVal;
        const h = Math.max(2, ratio * plotH);
        const cx = padL + slotW * idx + slotW / 2;
        const x = cx - barW / 2;
        const y = padT + plotH - h;
        const isHovered = hoveredIdx === idx;
        const labelStep = count > 12 ? Math.ceil(count / 8) : 1;
        const showLabel = idx % labelStep === 0 || isHovered;
        const shortLbl = pt.label.length > 12 ? `${pt.label.slice(0, 11)}..` : pt.label;

        return (
          <g
            key={`${pt.label}-${idx}`}
            onMouseEnter={() => onHover(idx)}
            className="cursor-pointer"
          >
            <rect
              x={padL + slotW * idx}
              y={padT}
              width={slotW}
              height={plotH}
              fill={isHovered ? 'var(--bg-elevated)' : 'transparent'}
              opacity={isHovered ? 0.55 : 0}
            />
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={2}
              fill={pt.isHighlighted ? 'url(#nexusBarSignal)' : 'url(#nexusBarCyan)'}
              opacity={hoveredIdx !== null && !isHovered ? 0.55 : 1}
              stroke={isHovered ? 'var(--text-primary)' : 'none'}
              strokeWidth={isHovered ? 1 : 0}
            />
            {(count <= 8 || isHovered) && (
              <text
                x={cx}
                y={Math.max(padT + 8, y - 4)}
                textAnchor="middle"
                fill={pt.isHighlighted ? 'var(--accent-signal)' : 'var(--text-secondary)'}
                fontSize="8.5"
                fontFamily="JetBrains Mono, monospace"
                fontWeight={isHovered ? '600' : '500'}
              >
                {formatChartMetricValue(model.metricColumn, pt.value)}
              </text>
            )}
            {showLabel && (
              <text
                x={cx}
                y={height - 12}
                textAnchor="middle"
                fill={isHovered ? 'var(--text-primary)' : 'var(--text-muted)'}
                fontSize="8.5"
                fontFamily="JetBrains Mono, monospace"
              >
                {shortLbl}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

const AreaTrendSvg: React.FC<ChartSvgProps> = ({ model, hoveredIdx, onHover }) => {
  const width = 640;
  const height = 168;
  const padL = 56;
  const padR = 26;
  const padT = 14;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const secondaryMax = model.points.reduce(
    (m, p) => (p.secondaryValue !== undefined ? Math.max(m, p.secondaryValue) : m),
    0,
  );
  const maxVal = Math.max(1e-6, model.summary.max, secondaryMax);
  const minVal = Math.min(0, model.summary.min);
  const span = Math.max(1e-6, maxVal - minVal);
  const count = model.points.length;

  const coords = model.points.map((pt, idx) => {
    const x = padL + (count <= 1 ? plotW / 2 : (idx / (count - 1)) * plotW);
    const y = padT + plotH - ((pt.value - minVal) / span) * plotH;
    const secY =
      pt.secondaryValue !== undefined
        ? padT + plotH - ((pt.secondaryValue - minVal) / span) * plotH
        : undefined;
    return { x, y, secY, pt };
  });

  const linePath = coords
    .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  const hasSecondary = coords.some((c) => c.secY !== undefined);
  const secPath = hasSecondary
    ? coords
        .filter((c) => c.secY !== undefined)
        .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.secY!.toFixed(1)}`)
        .join(' ')
    : '';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-full select-none"
      role="img"
      aria-label={`Area trend chart of ${model.metricColumn}`}
      onMouseLeave={() => onHover(null)}
    >
      <defs>
        <linearGradient id="nexusAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {[0, 0.33, 0.66, 1].map((tick) => {
        const y = padT + plotH * (1 - tick);
        const tickVal = minVal + span * tick;
        return (
          <g key={tick}>
            <line
              x1={padL}
              y1={y}
              x2={width - padR}
              y2={y}
              stroke="var(--border-hairline)"
              strokeDasharray={tick === 0 ? undefined : '2 3'}
            />
            <text
              x={padL - 6}
              y={y + 3}
              textAnchor="end"
              fill="var(--text-muted)"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
            >
              {formatChartMetricValue(model.metricColumn, tickVal)}
            </text>
          </g>
        );
      })}

      <path d={areaPath} fill="url(#nexusAreaFill)" />
      <path d={linePath} fill="none" stroke="var(--accent-cyan)" strokeWidth="2" />

      {hasSecondary && (
        <path
          d={secPath}
          fill="none"
          stroke="var(--accent-amber)"
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />
      )}

      {/* Interactive Hover Vertical Crosshair + Data Nodes */}
      {coords.map((c, idx) => {
        const isHovered = hoveredIdx === idx;
        const labelStep = count > 8 ? Math.ceil(count / 6) : 1;
        const hitW = plotW / Math.max(1, count);
        const shortLbl =
          c.pt.label.length > 11 ? c.pt.label.slice(-11) : c.pt.label;

        return (
          <g key={idx} onMouseEnter={() => onHover(idx)} className="cursor-crosshair">
            <rect
              x={c.x - hitW / 2}
              y={padT}
              width={hitW}
              height={plotH}
              fill="transparent"
            />
            {isHovered && (
              <line
                x1={c.x}
                y1={padT}
                x2={c.x}
                y2={padT + plotH}
                stroke="var(--border-strong)"
                strokeDasharray="2 2"
              />
            )}
            {(isHovered || count <= 14 || c.pt.isHighlighted) && (
              <circle
                cx={c.x}
                cy={c.y}
                r={isHovered ? 4 : c.pt.isHighlighted ? 3 : 2}
                fill={c.pt.isHighlighted ? 'var(--accent-signal)' : 'var(--accent-cyan)'}
                stroke="var(--bg-inset)"
                strokeWidth="1.2"
              />
            )}
            {(idx === count - 1 ||
              (idx % labelStep === 0 && count - 1 - idx >= labelStep)) && (
              <text
                x={c.x}
                y={height - 10}
                textAnchor={idx === 0 ? 'start' : idx === count - 1 ? 'end' : 'middle'}
                fill="var(--text-muted)"
                fontSize="8.5"
                fontFamily="JetBrains Mono, monospace"
              >
                {shortLbl}
              </text>
            )}
          </g>
        );
      })}

      {/* Subtle Secondary Series Legend */}
      {hasSecondary && model.secondaryMetricColumn && (
        <g transform={`translate(${width - 175}, 12)`}>
          <line x1="0" y1="0" x2="14" y2="0" stroke="var(--accent-amber)" strokeWidth="1.5" strokeDasharray="4 2" />
          <text
            x="18"
            y="3"
            fill="var(--text-muted)"
            fontSize="8.5"
            fontFamily="JetBrains Mono, monospace"
          >
            {model.secondaryMetricColumn}
          </text>
        </g>
      )}
    </svg>
  );
};

const MetricBreakdownView: React.FC<{
  model: NonNullable<ReturnType<typeof extractAutoChart>>;
}> = ({ model }) => {
  const total = Math.max(1e-6, model.summary.sum);
  const topFive = [...model.points].sort((a, b) => b.value - a.value).slice(0, 5);
  const palette = [
    'var(--accent-signal)',
    'var(--accent-cyan)',
    'var(--accent-emerald)',
    'var(--accent-amber)',
    'var(--text-muted)',
  ];

  return (
    <div className="h-full flex flex-col justify-between gap-2 overflow-y-auto pr-1">
      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'TOTAL SUM', value: formatChartMetricValue(model.metricColumn, model.summary.sum), tone: 'text-[var(--accent-cyan)]' },
          { label: 'PEAK MAX', value: formatChartMetricValue(model.metricColumn, model.summary.max), tone: 'text-[var(--accent-signal)]' },
          { label: 'MEAN AVG', value: formatChartMetricValue(model.metricColumn, model.summary.avg), tone: 'text-[var(--text-primary)]' },
          { label: 'SERIES N', value: `${model.summary.count} groups`, tone: 'text-[var(--accent-emerald)]' },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]"
          >
            <div className="font-mono-tech text-[9px] text-[var(--text-muted)] tracking-wider">
              {kpi.label}
            </div>
            <div className={`font-mono-tech text-xs font-semibold mt-0.5 ${kpi.tone}`}>
              {kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* Stacked Share Bar */}
      <div>
        <div className="h-2.5 w-full rounded overflow-hidden flex bg-[var(--bg-elevated)] border border-[var(--border-hairline)]">
          {topFive.map((pt, idx) => {
            const pct = Math.max(2, (pt.value / total) * 100);
            return (
              <div
                key={`${pt.label}-${idx}`}
                style={{ width: `${pct}%`, backgroundColor: palette[idx % palette.length] }}
                title={`${pt.label}: ${pct.toFixed(1)}%`}
              />
            );
          })}
        </div>
      </div>

      {/* Ranked Contributor Breakdown */}
      <div className="space-y-1">
        {topFive.map((pt, idx) => {
          const sharePct = (pt.value / total) * 100;
          return (
            <div
              key={`${pt.label}-${idx}`}
              className="flex items-center justify-between gap-2 font-mono-tech text-[10px]"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="w-2 h-2 rounded-[2px] shrink-0"
                  style={{ backgroundColor: palette[idx % palette.length] }}
                />
                <span className="text-[var(--text-primary)] truncate">{pt.label}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[var(--text-secondary)]">
                  {formatChartMetricValue(model.metricColumn, pt.value)}
                </span>
                <span className="w-11 text-right text-[var(--text-muted)]">
                  {sharePct.toFixed(1)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
