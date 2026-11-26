import { REGIONS } from './dataGenerator';
import type {
  BrushedClusterMetrics,
  BrushSelectionBounds,
  ColumnarTransactions,
  GpuFilterState,
  RegionCode,
} from '../types/lakehouse';

export const LOG_MAX_AMOUNT = Math.log10(6500);
export const MAX_LATENCY_MS = 850;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Projects normalized scatter coordinates (xNorm, yVal in [0, 1]) into
 * canvas UV coordinates [0, 1] matching WebGPU WGSL & WebGL2 shaders:
 *   clipX = xNorm * 1.88 - 0.94  => u = (clipX + 1) / 2 = xNorm * 0.94 + 0.03
 *   clipY = yVal  * 1.84 - 0.92  => v = 1 - (clipY + 1) / 2 = 0.96 - yVal * 0.92
 */
export function scatterToCanvasUv(xNorm: number, yVal: number): { u: number; v: number } {
  return {
    u: xNorm * 0.94 + 0.03,
    v: 0.96 - yVal * 0.92,
  };
}

/**
 * Inverts a canvas UV bounding rectangle (uMin..uMax, vMin..vMax) into
 * exact domain bounds (amount_usd, risk_score, latency_ms) + active regions.
 */
export function screenRectToBrushBounds(
  u1: number,
  v1: number,
  u2: number,
  v2: number,
  filter: GpuFilterState,
): BrushSelectionBounds {
  const uMin = clamp(Math.min(u1, u2), 0, 1);
  const uMax = clamp(Math.max(u1, u2), 0, 1);
  const vMin = clamp(Math.min(v1, v2), 0, 1);
  const vMax = clamp(Math.max(v1, v2), 0, 1);

  const xNormMin = clamp((uMin - 0.03) / 0.94, 0, 1);
  const xNormMax = clamp((uMax - 0.03) / 0.94, 0, 1);

  // Top of canvas (smaller v) corresponds to higher Y value
  const yValMax = clamp((0.96 - vMin) / 0.92, 0, 1);
  const yValMin = clamp((0.96 - vMax) / 0.92, 0, 1);

  const minAmountUsd = Number(Math.pow(10, xNormMin * LOG_MAX_AMOUNT).toFixed(2));
  const maxAmountUsd = Number(Math.pow(10, xNormMax * LOG_MAX_AMOUNT).toFixed(2));

  const minRiskScore =
    filter.yAxisMode === 'risk_score'
      ? Number(Math.max(filter.riskThreshold, yValMin).toFixed(4))
      : Number(filter.riskThreshold.toFixed(4));
  const maxRiskScore =
    filter.yAxisMode === 'risk_score' ? Number(Math.max(minRiskScore, yValMax).toFixed(4)) : 1.0;

  const minLatencyMs =
    filter.yAxisMode === 'latency_ms' ? Math.round(yValMin * MAX_LATENCY_MS) : 0;
  const maxLatencyMs =
    filter.yAxisMode === 'latency_ms'
      ? Math.max(minLatencyMs, Math.round(yValMax * MAX_LATENCY_MS))
      : MAX_LATENCY_MS;

  const activeRegions: RegionCode[] = [];
  for (let i = 0; i < REGIONS.length; i += 1) {
    if ((filter.regionMask & (1 << i)) !== 0) {
      activeRegions.push(REGIONS[i]);
    }
  }

  return {
    uMin,
    uMax,
    vMin,
    vMax,
    minAmountUsd,
    maxAmountUsd,
    minRiskScore,
    maxRiskScore,
    minLatencyMs,
    maxLatencyMs,
    yAxisMode: filter.yAxisMode,
    activeRegions,
  };
}

/**
 * Evaluates a brushed lasso rectangle against 100K-500K columnar rows in <2ms,
 * returning exact cluster metrics (point count, mean amount, anomaly rate, risk).
 */
export function evaluateBrushedCluster(
  dataset: ColumnarTransactions,
  bounds: BrushSelectionBounds,
  filter: GpuFilterState,
): BrushedClusterMetrics {
  const buf = dataset.gpuVertexBuffer;
  const n = dataset.rowCount;
  const minTimeNorm = 1 - filter.timeWindowPct / 100;

  let totalVisiblePoints = 0;
  let selectedPoints = 0;
  let totalVolumeUsd = 0;
  let anomalyCount = 0;
  let riskSum = 0;
  let latencySum = 0;
  let obsMinRisk = 1;
  let obsMaxRisk = 0;

  for (let i = 0; i < n; i += 1) {
    const b = i * 6;
    const risk = buf[b + 1];
    const rBit = 1 << (buf[b + 3] | 0);
    const tNorm = buf[b + 4];
    if (risk < filter.riskThreshold || (filter.regionMask & rBit) === 0 || tNorm < minTimeNorm) {
      continue;
    }
    totalVisiblePoints += 1;

    const amt = dataset.amountUsd[i];
    if (amt < bounds.minAmountUsd || amt > bounds.maxAmountUsd) {
      continue;
    }

    if (bounds.yAxisMode === 'risk_score') {
      const rVal = dataset.riskScore[i];
      if (rVal < bounds.minRiskScore || rVal > bounds.maxRiskScore) continue;
    } else {
      const lat = dataset.latencyMs[i];
      if (lat < bounds.minLatencyMs || lat > bounds.maxLatencyMs) continue;
    }

    selectedPoints += 1;
    totalVolumeUsd += amt;
    const rScore = dataset.riskScore[i];
    riskSum += rScore;
    if (rScore < obsMinRisk) obsMinRisk = rScore;
    if (rScore > obsMaxRisk) obsMaxRisk = rScore;
    latencySum += dataset.latencyMs[i];
    if (dataset.isAnomaly[i] === 1) anomalyCount += 1;
  }

  const effectiveBounds: BrushSelectionBounds =
    bounds.yAxisMode === 'latency_ms' && selectedPoints > 0
      ? {
          ...bounds,
          minRiskScore: Number(obsMinRisk.toFixed(4)),
          maxRiskScore: Number(obsMaxRisk.toFixed(4)),
        }
      : bounds;

  return {
    selectedPoints,
    totalVisiblePoints,
    shareOfVisiblePct:
      totalVisiblePoints > 0
        ? Number(((selectedPoints / totalVisiblePoints) * 100).toFixed(2))
        : 0,
    avgAmountUsd: selectedPoints > 0 ? Number((totalVolumeUsd / selectedPoints).toFixed(2)) : 0,
    totalVolumeUsd: Number(totalVolumeUsd.toFixed(2)),
    anomalyCount,
    anomalyRatePct:
      selectedPoints > 0 ? Number(((anomalyCount / selectedPoints) * 100).toFixed(2)) : 0,
    avgRiskScore: selectedPoints > 0 ? Number((riskSum / selectedPoints).toFixed(4)) : 0,
    avgLatencyMs: selectedPoints > 0 ? Number((latencySum / selectedPoints).toFixed(1)) : 0,
    bounds: effectiveBounds,
  };
}

/**
 * Generates an exact read-only DuckDB-WASM SQL query for the brushed scatter cluster.
 */
export function buildBrushSql(
  bounds: BrushSelectionBounds,
  options?: { limit?: number },
): string {
  const limit = Math.max(10, Math.min(1000, options?.limit ?? 250));
  const predicates: string[] = [
    `amount_usd BETWEEN ${bounds.minAmountUsd.toFixed(2)} AND ${bounds.maxAmountUsd.toFixed(2)}`,
    `risk_score BETWEEN ${bounds.minRiskScore.toFixed(4)} AND ${bounds.maxRiskScore.toFixed(4)}`,
  ];

  if (bounds.yAxisMode === 'latency_ms') {
    predicates.push(`latency_ms BETWEEN ${bounds.minLatencyMs} AND ${bounds.maxLatencyMs}`);
  }

  if (bounds.activeRegions.length > 0 && bounds.activeRegions.length < REGIONS.length) {
    const quoted = bounds.activeRegions.map((r) => `'${r}'`).join(', ');
    predicates.push(`region IN (${quoted})`);
  }

  return [
    '-- Brush-to-SQL Lasso Cluster Filter',
    'SELECT',
    '  tx_id,',
    "  STRFTIME(ts, '%Y-%m-%d %H:%M:%S') AS timestamp_utc,",
    '  store_id,',
    '  region,',
    '  category,',
    '  ROUND(amount_usd, 2) AS amount_usd,',
    '  ROUND(risk_score, 4) AS risk_score,',
    '  latency_ms,',
    "  COALESCE(voucher_code, 'NONE') AS voucher_code,",
    '  is_anomaly',
    'FROM transactions',
    `WHERE ${predicates.join('\n  AND ')}`,
    'ORDER BY risk_score DESC, amount_usd DESC',
    `LIMIT ${limit};`,
  ].join('\n');
}
