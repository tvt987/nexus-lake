import type {
  AutoChartModel,
  AutoChartPoint,
  AutoChartType,
  SqlQueryResult,
} from '../types/lakehouse';

const TEMPORAL_HINTS = ['hour', 'time', 'date', 'day', 'bucket', 'ts', 'timestamp', 'minute', 'month'];
const METRIC_PRIORITY = [
  'gross_volume_usd',
  'gross_margin_vnd',
  'revenue_vnd',
  'net_mrr_vnd',
  'lost_mrr_vnd',
  'total_freight_vnd',
  'exposed_usd',
  'hourly_usd',
  'redeemed_usd',
  'p99_ms',
  'amount_usd',
  'rolling_24h_avg_usd',
  'mom_growth_pct',
  'margin_pct',
  'tx_count',
  'burst_txs',
  'flagged_anomalies',
  'anomaly_rate_pct',
  'risk_score',
  'avg_risk_score',
  'latency_ms',
];

function isNumericValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isTemporalColumn(col: string): boolean {
  const lower = col.toLowerCase();
  return TEMPORAL_HINTS.some((hint) => lower.includes(hint));
}

function pickBestNumericColumn(numericCols: string[], preferred?: string): string {
  if (preferred && numericCols.includes(preferred)) {
    return preferred;
  }
  for (const candidate of METRIC_PRIORITY) {
    const exact = numericCols.find((c) => c.toLowerCase() === candidate);
    if (exact) return exact;
  }
  return numericCols[0];
}

function pickSecondaryMetricColumn(
  numericCols: string[],
  primary: string,
  recommendedType: AutoChartType,
): string | undefined {
  if (recommendedType === 'area') {
    const rolling = numericCols.find(
      (c) => c !== primary && (c.toLowerCase().includes('rolling') || c.toLowerCase().includes('avg')),
    );
    if (rolling) return rolling;
  }
  if (primary.toLowerCase().includes('p99')) {
    const p50 = numericCols.find((c) => c.toLowerCase().includes('p50'));
    if (p50) return p50;
  }
  return undefined;
}

/**
 * Inspects any live DuckDB-WASM / Fallback-OLAP SqlQueryResult and derives
 * an intelligent chart model supporting Bar Chart, Area Trend, and Metric Breakdown.
 */
export function extractAutoChart(
  result: SqlQueryResult | null,
  preferredMetric?: string,
): AutoChartModel | null {
  if (!result || result.error || result.rows.length === 0 || result.columns.length === 0) {
    return null;
  }

  const sampleRows = result.rows.slice(0, 64);
  const numericColumns: string[] = [];
  const labelCandidates: string[] = [];

  for (const col of result.columns) {
    let numCount = 0;
    let nonNullCount = 0;
    for (const row of sampleRows) {
      const val = row[col];
      if (val === null || val === undefined) continue;
      nonNullCount += 1;
      if (isNumericValue(val)) {
        numCount += 1;
      }
    }
    if (nonNullCount > 0 && numCount / nonNullCount >= 0.75) {
      numericColumns.push(col);
    } else {
      labelCandidates.push(col);
    }
  }

  if (numericColumns.length === 0) {
    return null;
  }

  // Prefer temporal or primary categorical column as label axis
  const temporalCol = labelCandidates.find(isTemporalColumn);
  const labelColumn = temporalCol ?? labelCandidates[0] ?? result.columns[0];

  const recommendedType: AutoChartType =
    result.rows.length <= 1
      ? 'metric'
      : temporalCol
        ? 'area'
        : 'bar';

  const metricColumn = pickBestNumericColumn(numericColumns, preferredMetric);
  const secondaryMetricColumn = pickSecondaryMetricColumn(
    numericColumns,
    metricColumn,
    recommendedType,
  );

  // Cap plotted points to preserve crisp readability while keeping chronological order for time series
  const maxPoints = recommendedType === 'area' ? 48 : 24;
  let workingRows = result.rows.slice(0, maxPoints);

  // If temporal series arrived in DESC order (e.g., Rolling 24h query), reverse for left-to-right trend
  if (temporalCol && workingRows.length >= 2) {
    const firstLabel = String(workingRows[0][labelColumn] ?? '');
    const lastLabel = String(workingRows[workingRows.length - 1][labelColumn] ?? '');
    if (firstLabel > lastLabel) {
      workingRows = [...workingRows].reverse();
    }
  }

  // Build composite label if duplicate primary labels exist (e.g., region + category)
  const secondaryLabelCol =
    labelCandidates.length >= 2 && !temporalCol ? labelCandidates[1] : undefined;
  const primaryLabelSet = new Set(workingRows.map((r) => String(r[labelColumn] ?? '')));
  const useCompositeLabel =
    Boolean(secondaryLabelCol) && primaryLabelSet.size < workingRows.length;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  const rawPoints: AutoChartPoint[] = workingRows.map((row, idx) => {
    const primaryStr = String(row[labelColumn] ?? `#${idx + 1}`);
    const label =
      useCompositeLabel && secondaryLabelCol
        ? `${primaryStr} · ${String(row[secondaryLabelCol] ?? '')}`
        : primaryStr;
    const rawVal = row[metricColumn];
    const value = isNumericValue(rawVal) ? rawVal : Number(rawVal ?? 0) || 0;
    const secRaw = secondaryMetricColumn ? row[secondaryMetricColumn] : undefined;
    const secondaryValue = isNumericValue(secRaw) ? secRaw : undefined;

    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;

    const anomalyFlag =
      row.is_anomaly === true ||
      (isNumericValue(row.risk_score) && row.risk_score >= 0.75) ||
      (isNumericValue(row.anomaly_rate_pct) && row.anomaly_rate_pct >= 5.0);

    return {
      label,
      value,
      secondaryValue,
      isHighlighted: anomalyFlag,
    };
  });

  if (rawPoints.length === 0) return null;

  // Highlight the peak bar if no anomaly highlight already exists
  if (!rawPoints.some((p) => p.isHighlighted) && rawPoints.length > 1) {
    let peakIdx = 0;
    for (let i = 1; i < rawPoints.length; i += 1) {
      if (rawPoints[i].value > rawPoints[peakIdx].value) peakIdx = i;
    }
    rawPoints[peakIdx] = { ...rawPoints[peakIdx], isHighlighted: true };
  }

  return {
    recommendedType,
    labelColumn,
    numericColumns,
    metricColumn,
    secondaryMetricColumn,
    points: rawPoints,
    summary: {
      min: Number(min.toFixed(2)),
      max: Number(max.toFixed(2)),
      avg: Number((sum / rawPoints.length).toFixed(2)),
      sum: Number(sum.toFixed(2)),
      count: rawPoints.length,
    },
  };
}

export function formatChartMetricValue(col: string, val: number): string {
  const lower = col.toLowerCase();
  if (lower.includes('vnd')) {
    if (Math.abs(val) >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B ₫`;
    if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M ₫`;
    if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(0)}K ₫`;
    return `${val.toFixed(0)} ₫`;
  }
  if (lower.includes('usd') || lower.includes('amount') || lower.includes('volume')) {
    if (Math.abs(val) >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
    if (Math.abs(val) >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
    return `$${val.toFixed(2)}`;
  }
  if (lower.includes('pct') || lower.includes('rate')) {
    return `${val.toFixed(2)}%`;
  }
  if (lower.includes('risk')) {
    return val.toFixed(4);
  }
  if (lower.includes('ms') || lower.includes('latency') || lower.includes('p99') || lower.includes('p95') || lower.includes('p50')) {
    return `${val.toFixed(1)}ms`;
  }
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return Number.isInteger(val) ? val.toLocaleString('en-US') : val.toFixed(2);
}
