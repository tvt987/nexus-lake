import type {
  PivotAggregation,
  PivotCellValue,
  PivotConfig,
  PivotMatrixResult,
  SqlQueryResult,
} from '../types/lakehouse';

const MAX_PIVOT_COLS = 16;

function isNumericVal(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Classifies columns in a query result into categorical dimensions vs numeric metrics.
 */
export function classifyPivotColumns(
  columns: string[],
  rows: Record<string, unknown>[],
): { dimensions: string[]; metrics: string[] } {
  const sample = rows.slice(0, 64);
  const dimensions: string[] = [];
  const metrics: string[] = [];

  for (const col of columns) {
    let numCount = 0;
    let nonNull = 0;
    for (const r of sample) {
      const val = r[col];
      if (val === null || val === undefined) continue;
      nonNull += 1;
      if (isNumericVal(val)) numCount += 1;
    }
    if (nonNull > 0 && numCount / nonNull >= 0.75) {
      metrics.push(col);
    } else {
      dimensions.push(col);
    }
  }

  return { dimensions, metrics };
}

const PIVOT_METRIC_PRIORITY = [
  'p99_ms',
  'gross_margin_vnd',
  'revenue_vnd',
  'gross_volume_usd',
  'net_mrr_vnd',
  'exposed_usd',
  'total_freight_vnd',
  'amount_usd',
  'margin_pct',
  'anomaly_rate_pct',
  'avg_delay_hrs',
];

/**
 * Suggests a sensible default PivotConfig for any SqlQueryResult.
 */
export function suggestPivotConfig(result: SqlQueryResult | null): PivotConfig | null {
  if (!result || result.error || result.rows.length === 0 || result.columns.length === 0) {
    return null;
  }

  const { dimensions, metrics } = classifyPivotColumns(result.columns, result.rows);
  const allCols = result.columns;

  const rowDim = dimensions[0] ?? allCols[0];
  const colDim =
    dimensions[1] ??
    (dimensions.length === 1
      ? allCols.find((c) => c !== rowDim) ?? rowDim
      : allCols[1] ?? rowDim);
  const prioritizedMetric = PIVOT_METRIC_PRIORITY.find((cand) =>
    metrics.some((m) => m.toLowerCase() === cand),
  );
  const metricCol =
    (prioritizedMetric
      ? metrics.find((m) => m.toLowerCase() === prioritizedMetric)
      : undefined) ??
    metrics[0] ??
    allCols[allCols.length - 1];

  const lowerMetric = metricCol.toLowerCase();
  const aggregation: PivotAggregation =
    lowerMetric.includes('avg') || lowerMetric.includes('pct') || lowerMetric.includes('rate') || lowerMetric.includes('risk')
      ? 'AVG'
      : lowerMetric.includes('p99') || lowerMetric.includes('peak') || lowerMetric.includes('max')
        ? 'MAX'
        : metrics.length === 0
          ? 'COUNT'
          : 'SUM';

  return {
    rowDim,
    colDim,
    metricCol,
    aggregation,
  };
}

interface BucketAcc {
  sum: number;
  count: number;
  max: number;
}

function finalizeBucket(acc: BucketAcc | undefined, aggregation: PivotAggregation): number {
  if (!acc || acc.count === 0) return 0;
  switch (aggregation) {
    case 'COUNT':
      return acc.count;
    case 'AVG':
      return Number((acc.sum / acc.count).toFixed(2));
    case 'MAX':
      return Number(acc.max.toFixed(2));
    case 'SUM':
    default:
      return Number(acc.sum.toFixed(2));
  }
}

/**
 * Computes a Cross-Tab Pivot Matrix over arbitrary SQL result rows with
 * SUM, AVG, COUNT, or MAX aggregation plus row/column/grand totals.
 */
export function computePivotMatrix(
  rows: Record<string, unknown>[],
  config: PivotConfig,
): PivotMatrixResult {
  const { rowDim, colDim, metricCol, aggregation } = config;
  const bucketMap = new Map<string, Map<string, BucketAcc>>();
  const colTotalAcc = new Map<string, BucketAcc>();
  const rowTotalAcc = new Map<string, BucketAcc>();
  const grandAcc: BucketAcc = { sum: 0, count: 0, max: -Infinity };

  const updateAcc = (acc: BucketAcc, num: number) => {
    acc.sum += num;
    acc.count += 1;
    if (num > acc.max) acc.max = num;
  };

  for (const row of rows) {
    const rKey = row[rowDim] === null || row[rowDim] === undefined ? 'NULL' : String(row[rowDim]);
    const cKey = row[colDim] === null || row[colDim] === undefined ? 'NULL' : String(row[colDim]);
    const rawMetric = row[metricCol];
    const num =
      typeof rawMetric === 'number' && Number.isFinite(rawMetric)
        ? rawMetric
        : Number(rawMetric ?? 0) || 0;

    let rMap = bucketMap.get(rKey);
    if (!rMap) {
      rMap = new Map<string, BucketAcc>();
      bucketMap.set(rKey, rMap);
    }
    let cell = rMap.get(cKey);
    if (!cell) {
      cell = { sum: 0, count: 0, max: -Infinity };
      rMap.set(cKey, cell);
    }
    updateAcc(cell, num);

    let rTot = rowTotalAcc.get(rKey);
    if (!rTot) {
      rTot = { sum: 0, count: 0, max: -Infinity };
      rowTotalAcc.set(rKey, rTot);
    }
    updateAcc(rTot, num);

    let cTot = colTotalAcc.get(cKey);
    if (!cTot) {
      cTot = { sum: 0, count: 0, max: -Infinity };
      colTotalAcc.set(cKey, cTot);
    }
    updateAcc(cTot, num);

    updateAcc(grandAcc, num);
  }

  // Sort columns by aggregate descending, cap at MAX_PIVOT_COLS for clean readability
  const allColKeys = [...colTotalAcc.keys()].sort(
    (a, b) => finalizeBucket(colTotalAcc.get(b), aggregation) - finalizeBucket(colTotalAcc.get(a), aggregation),
  );
  const truncatedCols = Math.max(0, allColKeys.length - MAX_PIVOT_COLS);
  const colKeys = allColKeys.slice(0, MAX_PIVOT_COLS);

  const rowKeys = [...rowTotalAcc.keys()].sort(
    (a, b) => finalizeBucket(rowTotalAcc.get(b), aggregation) - finalizeBucket(rowTotalAcc.get(a), aggregation),
  );

  const matrix: Record<string, Record<string, PivotCellValue>> = {};
  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = {};

  let minCellValue = Infinity;
  let maxCellValue = -Infinity;

  for (const rKey of rowKeys) {
    matrix[rKey] = {};
    rowTotals[rKey] = finalizeBucket(rowTotalAcc.get(rKey), aggregation);
    const rMap = bucketMap.get(rKey);
    for (const cKey of colKeys) {
      const acc = rMap?.get(cKey);
      const val = finalizeBucket(acc, aggregation);
      const count = acc?.count ?? 0;
      matrix[rKey][cKey] = { value: val, count };
      if (count > 0) {
        if (val < minCellValue) minCellValue = val;
        if (val > maxCellValue) maxCellValue = val;
      }
    }
  }

  for (const cKey of colKeys) {
    colTotals[cKey] = finalizeBucket(colTotalAcc.get(cKey), aggregation);
  }

  if (!Number.isFinite(minCellValue)) minCellValue = 0;
  if (!Number.isFinite(maxCellValue)) maxCellValue = 0;

  return {
    config,
    rowKeys,
    colKeys,
    matrix,
    rowTotals,
    colTotals,
    grandTotal: finalizeBucket(grandAcc, aggregation),
    minCellValue,
    maxCellValue,
    truncatedCols,
  };
}

export function formatPivotValue(metricCol: string, aggregation: PivotAggregation, val: number): string {
  if (aggregation === 'COUNT') {
    return Math.round(val).toLocaleString('en-US');
  }
  const lower = metricCol.toLowerCase();
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
  if (lower.includes('ms') || lower.includes('latency') || lower.includes('p99') || lower.includes('p95') || lower.includes('p50')) {
    return `${val.toFixed(1)}ms`;
  }
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return Number.isInteger(val) ? val.toLocaleString('en-US') : val.toFixed(2);
}
