/**
 * NEXUS LAKE v6.0 — Deterministic 100K-Row OLAP Spatial Index,
 * Safe Parameterized Brush-to-SQL Compiler (with Read-Only SQL AST Guard),
 * 3D OLAP Cube Perspective Projection, and Live Streaming Medallion CDC Simulator.
 */

export const OLAP_REGIONS = [
  'APAC-VN',
  'APAC-SG',
  'NA-WEST',
  'NA-EAST',
  'EU-CENTRAL',
] as const;

export type OlapRegionCode = (typeof OLAP_REGIONS)[number];

export const OLAP_TIERS = ['Enterprise', 'Mid-Market', 'Growth'] as const;
export type OlapTierCode = (typeof OLAP_TIERS)[number];

export type OlapStageMode = 'scatter2d' | 'cube3d' | 'medallion';

export const MAX_OLAP_LATENCY_MS = 1000;
export const MAX_OLAP_REVENUE_USD = 6500;
export const OLAP_SPATIAL_GRID_DIM = 32;
export const OLAP_STREAM_RESERVE = 32_000;

export interface OlapLassoBox {
  minLatencyMs: number;
  maxLatencyMs: number;
  minRevenueUsd: number;
  maxRevenueUsd: number;
  label?: string;
}

export interface OlapPolygonPoint {
  latencyMs: number;
  revenueUsd: number;
}

export interface OlapBrushPreset {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  box: OlapLassoBox;
}

export const OLAP_BRUSH_PRESETS: readonly OlapBrushPreset[] = [
  {
    id: 'whale_anomalies',
    label: 'Select High-Latency Whale Anomalies',
    shortLabel: 'Whale Anomalies',
    description: 'Isolates high-ticket transactions (>$2,600) exhibiting severe settlement latency (430–960ms).',
    box: {
      minLatencyMs: 430,
      maxLatencyMs: 960,
      minRevenueUsd: 2600,
      maxRevenueUsd: 6450,
      label: 'High-Latency Whale Anomalies',
    },
  },
  {
    id: 'voucher_bot_burst',
    label: 'Select Voucher Bot Micro-Bursts',
    shortLabel: 'Voucher Bots',
    description: 'Captures coordinated promo-redemption bursts (440–810ms, $200–$1,750).',
    box: {
      minLatencyMs: 440,
      maxLatencyMs: 810,
      minRevenueUsd: 200,
      maxRevenueUsd: 1750,
      label: 'Voucher Bot Micro-Bursts',
    },
  },
  {
    id: 'watch_corridor',
    label: 'Select Mid-Latency Watch Band',
    shortLabel: 'Watch Band',
    description: 'Inspects transitional watch-zone traffic (170–420ms, $700–$3,600) prior to SLA breach.',
    box: {
      minLatencyMs: 170,
      maxLatencyMs: 420,
      minRevenueUsd: 700,
      maxRevenueUsd: 3600,
      label: 'Mid-Latency Watch Band',
    },
  },
] as const;

export interface OlapPointCloudIndex {
  baseCount: number;
  count: number;
  capacity: number;
  streamWriteCursor: number;
  revenueUsd: Float32Array;
  latencyMs: Float32Array;
  riskScore: Float32Array;
  regionIdx: Uint8Array;
  tierIdx: Uint8Array;
  isAnomaly: Uint8Array;
  isStreamingLive: Uint8Array;
  streamBatchId: Uint16Array;
  normX: Float32Array; // latencyMs / MAX_OLAP_LATENCY_MS
  normY: Float32Array; // revenueUsd / MAX_OLAP_REVENUE_USD
  normZ: Float32Array; // riskScore
  gridDim: number;
  bucketOffsets: Int32Array; // length gridDim*gridDim + 1
  bucketPointIndices: Int32Array; // length >= count
  selectedMask: Uint8Array; // length capacity
  totalAnomalies: number;
  streamingLiveCount: number;
  generationMs: number;
}

export interface OlapRegionCohortRow {
  region: OlapRegionCode;
  txCount: number;
  sharePct: number;
  avgRevenueUsd: number;
  p99LatencyMs: number;
  anomalyCount: number;
  anomalyPct: number;
}

export interface OlapTierCohortRow {
  tier: OlapTierCode;
  txCount: number;
  sharePct: number;
  avgRevenueUsd: number;
  anomalyPct: number;
}

export interface OlapLassoSelectionResult {
  box: OlapLassoBox;
  selectedCount: number;
  totalCount: number;
  selectionSharePct: number;
  anomalyCount: number;
  anomalyPct: number;
  totalRevenueUsd: number;
  avgRevenueUsd: number;
  avgRiskScore: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  regionBreakdown: OlapRegionCohortRow[];
  tierBreakdown: OlapTierCohortRow[];
  queryTimeMs: number;
  selectionMode: 'box' | 'polygon';
}

export interface OlapSqlGuardrailResult {
  allowed: boolean;
  statementType: string;
  normalizedSql: string;
  detectedTables: string[];
  reason?: string;
  blockedKeyword?: string;
}

export interface CompiledBrushSql {
  sql: string;
  compactSql: string;
  params: {
    minLatencyMs: number;
    maxLatencyMs: number;
    minRevenueUsd: number;
    maxRevenueUsd: number;
    regions: OlapRegionCode[];
  };
  guardrail: OlapSqlGuardrailResult;
}

export interface MedallionDriftAlert {
  id: string;
  rule: string;
  column: string;
  dbtTest: string;
  interceptedCount: number;
  severity: 'CRITICAL' | 'WARN';
  samplePayload: string;
  detectedAt: string;
}

export interface MedallionPipelineState {
  streamingMode: 'STEADY' | 'SURGE';
  schemaDriftActive: boolean;
  kafkaRateRowsSec: number;
  batchSeq: number;
  watermarkMs: number;
  watermarkIso: string;
  bronzeRawRows: number;
  silverCleanedRows: number;
  silverDedupedRows: number;
  dbtGatePassedRows: number;
  quarantineDlqRows: number;
  goldMartRows: number;
  goldCorruptedRows: number;
  dbtGateStatus: 'PASSING' | 'INTERCEPTING_DRIFT';
  lastBatchBronze: number;
  lastBatchSilver: number;
  lastBatchQuarantined: number;
  lastBatchGold: number;
  latencyBronzeToGoldMs: number;
  rateSparkline: number[];
  activeDriftAlerts: MedallionDriftAlert[];
}

export interface MedallionStepResult {
  nextState: MedallionPipelineState;
  appendedGoldPoints: number;
  quarantinedBatchRows: number;
  injectedDriftThisTick: boolean;
}

export interface Cube3dCamera {
  yaw: number; // radians
  pitch: number; // radians
  zoom: number; // 0.65..1.65
}

export interface Projected3dPoint {
  sx: number;
  sy: number;
  depth: number;
  scale: number;
  visible: boolean;
}

export interface OlapClusterBeacon {
  id: string;
  label: string;
  subtitle: string;
  regionTop: OlapRegionCode;
  cx: number; // normalized [0,1] X (latency)
  cy: number; // normalized [0,1] Y (revenue)
  cz: number; // normalized [0,1] Z (risk)
  count: number;
  avgRevenueUsd: number;
  p99LatencyMs: number;
  anomalyPct: number;
  severity: 'critical' | 'watch' | 'nominal';
  presetBox: OlapLassoBox;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rand: () => number): number {
  const u1 = Math.max(1e-7, rand());
  const u2 = rand();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Rebuilds the 32x32 CSR spatial bucket grid in-place for O(k) sub-5ms Lasso box queries.
 */
export function rebuildOlapSpatialGrid(index: OlapPointCloudIndex): void {
  const dim = index.gridDim;
  const totalBuckets = dim * dim;
  const n = index.count;
  const offsets = index.bucketOffsets;

  const counts = new Int32Array(totalBuckets);
  const normX = index.normX;
  const normY = index.normY;

  for (let i = 0; i < n; i += 1) {
    const gx = Math.min(dim - 1, Math.max(0, (normX[i] * dim) | 0));
    const gy = Math.min(dim - 1, Math.max(0, (normY[i] * dim) | 0));
    counts[gy * dim + gx] += 1;
  }

  let running = 0;
  for (let b = 0; b < totalBuckets; b += 1) {
    offsets[b] = running;
    running += counts[b];
  }
  offsets[totalBuckets] = running;

  if (index.bucketPointIndices.length < n) {
    index.bucketPointIndices = new Int32Array(index.capacity);
  }
  const writePos = new Int32Array(totalBuckets);
  writePos.set(offsets.subarray(0, totalBuckets));
  const indices = index.bucketPointIndices;

  for (let i = 0; i < n; i += 1) {
    const gx = Math.min(dim - 1, Math.max(0, (normX[i] * dim) | 0));
    const gy = Math.min(dim - 1, Math.max(0, (normY[i] * dim) | 0));
    const bucket = gy * dim + gx;
    indices[writePos[bucket]] = i;
    writePos[bucket] += 1;
  }
}

/**
 * Deterministically synthesizes 100,000 (default) enterprise lakehouse telemetry points
 * structured into 4 unmistakable OLAP strata (Nominal Edge Mesh, Mid-Latency Watch Band,
 * High-Latency Whale Anomalies, and Voucher Bot Micro-Bursts) and builds a 32x32 CSR spatial index.
 */
export function createOlapPointCloudIndex(
  rowCount = 100_000,
  seed = 20261128,
): OlapPointCloudIndex {
  const start = performance.now();
  const safeCount = Math.max(1_000, Math.min(500_000, Math.floor(rowCount)));
  const capacity = safeCount + OLAP_STREAM_RESERVE;
  const rand = mulberry32(seed);

  const revenueUsd = new Float32Array(capacity);
  const latencyMs = new Float32Array(capacity);
  const riskScore = new Float32Array(capacity);
  const regionIdx = new Uint8Array(capacity);
  const tierIdx = new Uint8Array(capacity);
  const isAnomaly = new Uint8Array(capacity);
  const isStreamingLive = new Uint8Array(capacity);
  const streamBatchId = new Uint16Array(capacity);
  const normX = new Float32Array(capacity);
  const normY = new Float32Array(capacity);
  const normZ = new Float32Array(capacity);
  const selectedMask = new Uint8Array(capacity);

  let totalAnomalies = 0;

  for (let i = 0; i < safeCount; i += 1) {
    const clusterRoll = rand();

    let lat: number;
    let rev: number;
    let risk: number;
    let rIdx: number;
    let tIdx: number;

    if (clusterRoll < 0.056) {
      // Cluster C: High-Latency Whale Anomalies (organic high-density glowing upper-right hotspot)
      lat = clamp(685 + boxMuller(rand) * 102, 420, 982);
      rev = clamp(4680 + boxMuller(rand) * 640, 2600, 6460);
      risk = clamp(0.89 + boxMuller(rand) * 0.046, 0.77, 0.994);
      const rRoll = rand();
      rIdx = rRoll < 0.36 ? 0 : rRoll < 0.56 ? 3 : rRoll < 0.75 ? 1 : rRoll < 0.89 ? 2 : 4;
      tIdx = rand() < 0.74 ? 0 : 1; // predominantly Enterprise whales
    } else if (clusterRoll < 0.088) {
      // Cluster D: Voucher Bot Micro-Bursts (high latency >440ms, lower/mid ticket, high fraud risk)
      lat = clamp(605 + boxMuller(rand) * 72, 435, 845);
      rev = clamp(920 + boxMuller(rand) * 245, 220, 1780);
      risk = clamp(0.84 + boxMuller(rand) * 0.052, 0.755, 0.975);
      const rRoll = rand();
      rIdx = rRoll < 0.44 ? 0 : rRoll < 0.68 ? 1 : rRoll < 0.82 ? 2 : rRoll < 0.92 ? 3 : 4;
      tIdx = rand() < 0.65 ? 2 : 1;
    } else if (clusterRoll < 0.245) {
      // Cluster B: Mid-Latency Watch Band (amber corridor bridging nominal -> critical)
      lat = clamp(275 + boxMuller(rand) * 68, 135, 465);
      rev = clamp(1880 + boxMuller(rand) * 690, 320, 4100);
      risk = clamp(0.56 + boxMuller(rand) * 0.085, 0.38, 0.742);
      const rRoll = rand();
      rIdx = rRoll < 0.28 ? 0 : rRoll < 0.48 ? 1 : rRoll < 0.68 ? 2 : rRoll < 0.85 ? 3 : 4;
      tIdx = rand() < 0.34 ? 0 : rand() < 0.76 ? 1 : 2;
    } else {
      // Cluster A: Nominal High-Throughput Edge Mesh (crisp low-latency core)
      lat = clamp(68 + Math.abs(boxMuller(rand)) * 46 + rand() * 38, 8, 250);
      const revBase = rand() < 0.14 ? 2250 + boxMuller(rand) * 620 : 540 + Math.abs(boxMuller(rand)) * 480;
      rev = clamp(revBase, 14, 3950);
      risk = clamp(0.18 + Math.abs(boxMuller(rand)) * 0.095, 0.02, 0.44);
      const rRoll = rand();
      rIdx = rRoll < 0.26 ? 0 : rRoll < 0.45 ? 1 : rRoll < 0.66 ? 2 : rRoll < 0.84 ? 3 : 4;
      tIdx = rev > 2100 ? 0 : rev > 850 ? 1 : 2;
    }

    const anom = risk >= 0.75 ? 1 : 0;
    if (anom === 1) totalAnomalies += 1;

    latencyMs[i] = Math.round(lat * 10) / 10;
    revenueUsd[i] = Math.round(rev * 100) / 100;
    riskScore[i] = Math.round(risk * 10000) / 10000;
    regionIdx[i] = rIdx;
    tierIdx[i] = tIdx;
    isAnomaly[i] = anom;
    isStreamingLive[i] = 0;
    streamBatchId[i] = 0;

    normX[i] = clamp(latencyMs[i] / MAX_OLAP_LATENCY_MS, 0.005, 0.995);
    normY[i] = clamp(revenueUsd[i] / MAX_OLAP_REVENUE_USD, 0.005, 0.995);
    normZ[i] = clamp(riskScore[i], 0.005, 0.995);
  }

  const index: OlapPointCloudIndex = {
    baseCount: safeCount,
    count: safeCount,
    capacity,
    streamWriteCursor: safeCount,
    revenueUsd,
    latencyMs,
    riskScore,
    regionIdx,
    tierIdx,
    isAnomaly,
    isStreamingLive,
    streamBatchId,
    normX,
    normY,
    normZ,
    gridDim: OLAP_SPATIAL_GRID_DIM,
    bucketOffsets: new Int32Array(OLAP_SPATIAL_GRID_DIM * OLAP_SPATIAL_GRID_DIM + 1),
    bucketPointIndices: new Int32Array(capacity),
    selectedMask,
    totalAnomalies,
    streamingLiveCount: 0,
    generationMs: 0,
  };

  rebuildOlapSpatialGrid(index);
  index.generationMs = Number((performance.now() - start).toFixed(2));
  return index;
}

/**
 * Appends live golden streaming CDC points directly into the OLAP index & refreshes spatial buckets.
 * Uses bounded ring-wrap over the streaming reserve zone so memory never grows unbounded.
 */
export function appendStreamingPointsToIndex(
  index: OlapPointCloudIndex,
  batchCount: number,
  batchSeq: number,
  isSurge: boolean,
): number {
  const safeAppend = Math.max(0, Math.min(2_500, Math.floor(batchCount)));
  if (safeAppend === 0) return 0;

  const rand = mulberry32((20269991 ^ (batchSeq * 2654435761)) >>> 0);
  const reserveSize = Math.max(1, index.capacity - index.baseCount);

  for (let k = 0; k < safeAppend; k += 1) {
    let slot: number;
    if (index.count < index.capacity) {
      slot = index.count;
      index.count += 1;
      index.streamingLiveCount += 1;
    } else {
      const offsetInReserve = (index.streamWriteCursor - index.baseCount) % reserveSize;
      slot = index.baseCount + offsetInReserve;
      if (index.isAnomaly[slot] === 1) {
        index.totalAnomalies = Math.max(0, index.totalAnomalies - 1);
      }
    }
    index.streamWriteCursor =
      index.baseCount + ((index.streamWriteCursor - index.baseCount + 1) % reserveSize);

    const surgeWhaleProb = isSurge ? 0.34 : 0.14;
    const roll = rand();
    let lat: number;
    let rev: number;
    let risk: number;
    let rIdx: number;
    let tIdx: number;

    if (roll < surgeWhaleProb) {
      // Fresh golden/crimson surge anomalies landing into the Whale cluster
      lat = clamp(690 + boxMuller(rand) * 105, 450, 965);
      rev = clamp(4780 + boxMuller(rand) * 760, 2750, 6450);
      risk = clamp(0.89 + boxMuller(rand) * 0.045, 0.77, 0.992);
      rIdx = rand() < 0.4 ? 0 : rand() < 0.65 ? 3 : rand() < 0.85 ? 1 : 2;
      tIdx = 0;
    } else if (roll < surgeWhaleProb + 0.24) {
      lat = clamp(290 + boxMuller(rand) * 72, 145, 460);
      rev = clamp(2100 + boxMuller(rand) * 650, 500, 4100);
      risk = clamp(0.57 + boxMuller(rand) * 0.08, 0.40, 0.74);
      rIdx = Math.floor(rand() * OLAP_REGIONS.length);
      tIdx = 1;
    } else {
      lat = clamp(72 + Math.abs(boxMuller(rand)) * 45, 10, 240);
      rev = clamp(620 + Math.abs(boxMuller(rand)) * 520, 20, 3400);
      risk = clamp(0.19 + Math.abs(boxMuller(rand)) * 0.09, 0.02, 0.44);
      rIdx = Math.floor(rand() * OLAP_REGIONS.length);
      tIdx = rev > 1800 ? 0 : rev > 800 ? 1 : 2;
    }

    const anom = risk >= 0.75 ? 1 : 0;
    if (anom === 1) index.totalAnomalies += 1;

    index.latencyMs[slot] = Math.round(lat * 10) / 10;
    index.revenueUsd[slot] = Math.round(rev * 100) / 100;
    index.riskScore[slot] = Math.round(risk * 10000) / 10000;
    index.regionIdx[slot] = rIdx;
    index.tierIdx[slot] = tIdx;
    index.isAnomaly[slot] = anom;
    index.isStreamingLive[slot] = 1;
    index.streamBatchId[slot] = batchSeq & 0xffff;
    index.normX[slot] = clamp(index.latencyMs[slot] / MAX_OLAP_LATENCY_MS, 0.005, 0.995);
    index.normY[slot] = clamp(index.revenueUsd[slot] / MAX_OLAP_REVENUE_USD, 0.005, 0.995);
    index.normZ[slot] = clamp(index.riskScore[slot], 0.005, 0.995);
  }

  rebuildOlapSpatialGrid(index);
  return safeAppend;
}

function percentileFromHistogram(hist: Uint32Array, total: number, q: number): number {
  if (total <= 0) return 0;
  const target = Math.max(1, Math.ceil(total * q));
  let acc = 0;
  for (let ms = 0; ms < hist.length; ms += 1) {
    acc += hist[ms];
    if (acc >= target) return ms;
  }
  return hist.length - 1;
}

export function normalizeLassoBox(raw: OlapLassoBox): OlapLassoBox {
  const latA = clamp(Number.isFinite(raw.minLatencyMs) ? raw.minLatencyMs : 0, 0, MAX_OLAP_LATENCY_MS);
  const latB = clamp(Number.isFinite(raw.maxLatencyMs) ? raw.maxLatencyMs : MAX_OLAP_LATENCY_MS, 0, MAX_OLAP_LATENCY_MS);
  const revA = clamp(Number.isFinite(raw.minRevenueUsd) ? raw.minRevenueUsd : 0, 0, MAX_OLAP_REVENUE_USD);
  const revB = clamp(Number.isFinite(raw.maxRevenueUsd) ? raw.maxRevenueUsd : MAX_OLAP_REVENUE_USD, 0, MAX_OLAP_REVENUE_USD);
  return {
    minLatencyMs: Math.round(Math.min(latA, latB)),
    maxLatencyMs: Math.round(Math.max(latA, latB)),
    minRevenueUsd: Number(Math.min(revA, revB).toFixed(2)),
    maxRevenueUsd: Number(Math.max(revA, revB).toFixed(2)),
    label: raw.label,
  };
}

/**
 * Clears the in-place selectedMask on the point cloud index.
 */
export function clearOlapSelectionMask(index: OlapPointCloudIndex): void {
  index.selectedMask.fill(0, 0, index.count);
}

/**
 * Sub-5ms spatial-bucketed Lasso Box query over 100,000+ points.
 * Updates index.selectedMask in-place so the 60fps canvas highlights selected points in electric gold.
 */
export function queryOlapLassoBox(
  index: OlapPointCloudIndex,
  rawBox: OlapLassoBox,
  options?: { regionFilterMask?: number; updateMask?: boolean },
): OlapLassoSelectionResult {
  const start = performance.now();
  const box = normalizeLassoBox(rawBox);
  const regionMask = options?.regionFilterMask ?? 0b11111;
  const updateMask = options?.updateMask ?? true;

  if (updateMask) {
    index.selectedMask.fill(0, 0, index.count);
  }

  const dim = index.gridDim;
  const xMinNorm = clamp(box.minLatencyMs / MAX_OLAP_LATENCY_MS, 0, 1);
  const xMaxNorm = clamp(box.maxLatencyMs / MAX_OLAP_LATENCY_MS, 0, 1);
  const yMinNorm = clamp(box.minRevenueUsd / MAX_OLAP_REVENUE_USD, 0, 1);
  const yMaxNorm = clamp(box.maxRevenueUsd / MAX_OLAP_REVENUE_USD, 0, 1);

  const gxMin = Math.max(0, Math.min(dim - 1, Math.floor(xMinNorm * dim)));
  const gxMax = Math.max(0, Math.min(dim - 1, Math.floor(xMaxNorm * dim)));
  const gyMin = Math.max(0, Math.min(dim - 1, Math.floor(yMinNorm * dim)));
  const gyMax = Math.max(0, Math.min(dim - 1, Math.floor(yMaxNorm * dim)));

  const offsets = index.bucketOffsets;
  const pts = index.bucketPointIndices;
  const latArr = index.latencyMs;
  const revArr = index.revenueUsd;
  const riskArr = index.riskScore;
  const regArr = index.regionIdx;
  const tierArr = index.tierIdx;
  const anomArr = index.isAnomaly;
  const maskArr = index.selectedMask;

  const latHist = new Uint32Array(MAX_OLAP_LATENCY_MS + 1);
  const regCounts = new Int32Array(OLAP_REGIONS.length);
  const regRevSum = new Float64Array(OLAP_REGIONS.length);
  const regAnom = new Int32Array(OLAP_REGIONS.length);
  const regLatHist = OLAP_REGIONS.map(() => new Uint32Array(MAX_OLAP_LATENCY_MS + 1));

  const tierCounts = new Int32Array(OLAP_TIERS.length);
  const tierRevSum = new Float64Array(OLAP_TIERS.length);
  const tierAnom = new Int32Array(OLAP_TIERS.length);

  let selectedCount = 0;
  let anomalyCount = 0;
  let totalRevenueUsd = 0;
  let totalRisk = 0;

  const allRegionsActive = (regionMask & 0b11111) === 0b11111;

  for (let gy = gyMin; gy <= gyMax; gy += 1) {
    const rowOffset = gy * dim;
    const isInteriorY = gy > gyMin && gy < gyMax;
    for (let gx = gxMin; gx <= gxMax; gx += 1) {
      const b = rowOffset + gx;
      const bStart = offsets[b];
      const bEnd = offsets[b + 1];
      if (bStart === bEnd) continue;

      const isInteriorBucket = isInteriorY && gx > gxMin && gx < gxMax && allRegionsActive;

      if (isInteriorBucket) {
        // Every point in this spatial bucket is strictly guaranteed inside the Lasso box!
        for (let p = bStart; p < bEnd; p += 1) {
          const i = pts[p];
          if (updateMask) maskArr[i] = 1;
          selectedCount += 1;

          const latBin = Math.min(MAX_OLAP_LATENCY_MS, Math.max(0, Math.round(latArr[i])));
          const rev = revArr[i];
          const r = regArr[i];
          const t = tierArr[i];
          const a = anomArr[i];

          latHist[latBin] += 1;
          totalRevenueUsd += rev;
          totalRisk += riskArr[i];
          anomalyCount += a;

          regCounts[r] += 1;
          regRevSum[r] += rev;
          regAnom[r] += a;
          regLatHist[r][latBin] += 1;

          tierCounts[t] += 1;
          tierRevSum[t] += rev;
          tierAnom[t] += a;
        }
      } else {
        for (let p = bStart; p < bEnd; p += 1) {
          const i = pts[p];
          const r = regArr[i];
          if (!allRegionsActive && (regionMask & (1 << r)) === 0) continue;

          const lat = latArr[i];
          if (lat < box.minLatencyMs || lat > box.maxLatencyMs) continue;
          const rev = revArr[i];
          if (rev < box.minRevenueUsd || rev > box.maxRevenueUsd) continue;

          if (updateMask) maskArr[i] = 1;
          selectedCount += 1;

          const latBin = Math.min(MAX_OLAP_LATENCY_MS, Math.max(0, Math.round(lat)));
          const t = tierArr[i];
          const a = anomArr[i];

          latHist[latBin] += 1;
          totalRevenueUsd += rev;
          totalRisk += riskArr[i];
          anomalyCount += a;

          regCounts[r] += 1;
          regRevSum[r] += rev;
          regAnom[r] += a;
          regLatHist[r][latBin] += 1;

          tierCounts[t] += 1;
          tierRevSum[t] += rev;
          tierAnom[t] += a;
        }
      }
    }
  }

  return finalizeSelectionResult({
    box,
    selectedCount,
    totalCount: index.count,
    anomalyCount,
    totalRevenueUsd,
    totalRisk,
    latHist,
    regCounts,
    regRevSum,
    regAnom,
    regLatHist,
    tierCounts,
    tierRevSum,
    tierAnom,
    elapsedMs: performance.now() - start,
    selectionMode: 'box',
  });
}

function pointInPolygon(x: number, y: number, poly: readonly OlapPolygonPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].latencyMs;
    const yi = poly[i].revenueUsd;
    const xj = poly[j].latencyMs;
    const yj = poly[j].revenueUsd;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Spatial-bucketed Freehand Polygon Lasso selection over 100,000+ points.
 */
export function queryOlapPolygonLasso(
  index: OlapPointCloudIndex,
  polygon: readonly OlapPolygonPoint[],
  options?: { regionFilterMask?: number; updateMask?: boolean },
): OlapLassoSelectionResult {
  const start = performance.now();
  if (polygon.length < 3) {
    return queryOlapLassoBox(
      index,
      { minLatencyMs: 0, maxLatencyMs: 0, minRevenueUsd: 0, maxRevenueUsd: 0 },
      options,
    );
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minRev = Infinity;
  let maxRev = -Infinity;
  for (const pt of polygon) {
    if (pt.latencyMs < minLat) minLat = pt.latencyMs;
    if (pt.latencyMs > maxLat) maxLat = pt.latencyMs;
    if (pt.revenueUsd < minRev) minRev = pt.revenueUsd;
    if (pt.revenueUsd > maxRev) maxRev = pt.revenueUsd;
  }

  const box = normalizeLassoBox({
    minLatencyMs: minLat,
    maxLatencyMs: maxLat,
    minRevenueUsd: minRev,
    maxRevenueUsd: maxRev,
    label: 'Freehand Lasso Polygon',
  });

  const regionMask = options?.regionFilterMask ?? 0b11111;
  const updateMask = options?.updateMask ?? true;
  if (updateMask) index.selectedMask.fill(0, 0, index.count);

  const dim = index.gridDim;
  const gxMin = Math.max(0, Math.min(dim - 1, Math.floor((box.minLatencyMs / MAX_OLAP_LATENCY_MS) * dim)));
  const gxMax = Math.max(0, Math.min(dim - 1, Math.floor((box.maxLatencyMs / MAX_OLAP_LATENCY_MS) * dim)));
  const gyMin = Math.max(0, Math.min(dim - 1, Math.floor((box.minRevenueUsd / MAX_OLAP_REVENUE_USD) * dim)));
  const gyMax = Math.max(0, Math.min(dim - 1, Math.floor((box.maxRevenueUsd / MAX_OLAP_REVENUE_USD) * dim)));

  const offsets = index.bucketOffsets;
  const pts = index.bucketPointIndices;
  const latArr = index.latencyMs;
  const revArr = index.revenueUsd;
  const riskArr = index.riskScore;
  const regArr = index.regionIdx;
  const tierArr = index.tierIdx;
  const anomArr = index.isAnomaly;
  const maskArr = index.selectedMask;

  const latHist = new Uint32Array(MAX_OLAP_LATENCY_MS + 1);
  const regCounts = new Int32Array(OLAP_REGIONS.length);
  const regRevSum = new Float64Array(OLAP_REGIONS.length);
  const regAnom = new Int32Array(OLAP_REGIONS.length);
  const regLatHist = OLAP_REGIONS.map(() => new Uint32Array(MAX_OLAP_LATENCY_MS + 1));

  const tierCounts = new Int32Array(OLAP_TIERS.length);
  const tierRevSum = new Float64Array(OLAP_TIERS.length);
  const tierAnom = new Int32Array(OLAP_TIERS.length);

  let selectedCount = 0;
  let anomalyCount = 0;
  let totalRevenueUsd = 0;
  let totalRisk = 0;
  const allRegionsActive = (regionMask & 0b11111) === 0b11111;

  for (let gy = gyMin; gy <= gyMax; gy += 1) {
    const rowOffset = gy * dim;
    for (let gx = gxMin; gx <= gxMax; gx += 1) {
      const b = rowOffset + gx;
      const bStart = offsets[b];
      const bEnd = offsets[b + 1];
      for (let p = bStart; p < bEnd; p += 1) {
        const i = pts[p];
        const r = regArr[i];
        if (!allRegionsActive && (regionMask & (1 << r)) === 0) continue;

        const lat = latArr[i];
        const rev = revArr[i];
        if (lat < box.minLatencyMs || lat > box.maxLatencyMs || rev < box.minRevenueUsd || rev > box.maxRevenueUsd) {
          continue;
        }
        if (!pointInPolygon(lat, rev, polygon)) continue;

        if (updateMask) maskArr[i] = 1;
        selectedCount += 1;

        const latBin = Math.min(MAX_OLAP_LATENCY_MS, Math.max(0, Math.round(lat)));
        const t = tierArr[i];
        const a = anomArr[i];

        latHist[latBin] += 1;
        totalRevenueUsd += rev;
        totalRisk += riskArr[i];
        anomalyCount += a;

        regCounts[r] += 1;
        regRevSum[r] += rev;
        regAnom[r] += a;
        regLatHist[r][latBin] += 1;

        tierCounts[t] += 1;
        tierRevSum[t] += rev;
        tierAnom[t] += a;
      }
    }
  }

  return finalizeSelectionResult({
    box,
    selectedCount,
    totalCount: index.count,
    anomalyCount,
    totalRevenueUsd,
    totalRisk,
    latHist,
    regCounts,
    regRevSum,
    regAnom,
    regLatHist,
    tierCounts,
    tierRevSum,
    tierAnom,
    elapsedMs: performance.now() - start,
    selectionMode: 'polygon',
  });
}

function finalizeSelectionResult(args: {
  box: OlapLassoBox;
  selectedCount: number;
  totalCount: number;
  anomalyCount: number;
  totalRevenueUsd: number;
  totalRisk: number;
  latHist: Uint32Array;
  regCounts: Int32Array;
  regRevSum: Float64Array;
  regAnom: Int32Array;
  regLatHist: Uint32Array[];
  tierCounts: Int32Array;
  tierRevSum: Float64Array;
  tierAnom: Int32Array;
  elapsedMs: number;
  selectionMode: 'box' | 'polygon';
}): OlapLassoSelectionResult {
  const {
    box,
    selectedCount,
    totalCount,
    anomalyCount,
    totalRevenueUsd,
    totalRisk,
    latHist,
    regCounts,
    regRevSum,
    regAnom,
    regLatHist,
    tierCounts,
    tierRevSum,
    tierAnom,
    elapsedMs,
    selectionMode,
  } = args;

  const regionBreakdown: OlapRegionCohortRow[] = OLAP_REGIONS.map((region, idx) => {
    const txCount = regCounts[idx];
    return {
      region,
      txCount,
      sharePct: selectedCount > 0 ? Number(((txCount / selectedCount) * 100).toFixed(1)) : 0,
      avgRevenueUsd: txCount > 0 ? Number((regRevSum[idx] / txCount).toFixed(2)) : 0,
      p99LatencyMs: percentileFromHistogram(regLatHist[idx], txCount, 0.99),
      anomalyCount: regAnom[idx],
      anomalyPct: txCount > 0 ? Number(((regAnom[idx] / txCount) * 100).toFixed(1)) : 0,
    };
  })
    .filter((row) => row.txCount > 0)
    .sort((a, b) => b.txCount - a.txCount);

  const tierBreakdown: OlapTierCohortRow[] = OLAP_TIERS.map((tier, idx) => {
    const txCount = tierCounts[idx];
    return {
      tier,
      txCount,
      sharePct: selectedCount > 0 ? Number(((txCount / selectedCount) * 100).toFixed(1)) : 0,
      avgRevenueUsd: txCount > 0 ? Number((tierRevSum[idx] / txCount).toFixed(2)) : 0,
      anomalyPct: txCount > 0 ? Number(((tierAnom[idx] / txCount) * 100).toFixed(1)) : 0,
    };
  }).sort((a, b) => b.txCount - a.txCount);

  return {
    box,
    selectedCount,
    totalCount,
    selectionSharePct: totalCount > 0 ? Number(((selectedCount / totalCount) * 100).toFixed(2)) : 0,
    anomalyCount,
    anomalyPct: selectedCount > 0 ? Number(((anomalyCount / selectedCount) * 100).toFixed(1)) : 0,
    totalRevenueUsd: Number(totalRevenueUsd.toFixed(2)),
    avgRevenueUsd: selectedCount > 0 ? Number((totalRevenueUsd / selectedCount).toFixed(2)) : 0,
    avgRiskScore: selectedCount > 0 ? Number((totalRisk / selectedCount).toFixed(4)) : 0,
    p50LatencyMs: percentileFromHistogram(latHist, selectedCount, 0.5),
    p95LatencyMs: percentileFromHistogram(latHist, selectedCount, 0.95),
    p99LatencyMs: percentileFromHistogram(latHist, selectedCount, 0.99),
    regionBreakdown,
    tierBreakdown,
    queryTimeMs: Number(Math.max(0.1, elapsedMs).toFixed(2)),
    selectionMode,
  };
}

// ============================================================================
// READ-ONLY SQL AST GUARD & PARAMETERIZED BRUSH-TO-SQL COMPILER
// ============================================================================

const ALLOWED_SQL_LEAD = new Set(['SELECT', 'WITH', 'EXPLAIN', 'DESCRIBE', 'SHOW']);
const FORBIDDEN_SQL_KEYWORDS = new Set([
  'DROP',
  'DELETE',
  'UPDATE',
  'INSERT',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'REPLACE',
  'MERGE',
  'ATTACH',
  'DETACH',
  'COPY',
  'EXPORT',
  'IMPORT',
  'INSTALL',
  'LOAD',
  'PRAGMA',
  'CALL',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'REVOKE',
  'VACUUM',
  'SET',
  'COMMIT',
  'ROLLBACK',
  'BEGIN',
  'TRANSACTION',
  'OUTFILE',
  'DUMPFILE',
]);

interface SqlToken {
  type: 'word' | 'string' | 'semicolon' | 'symbol';
  value: string;
}

function tokenizeReadOnlySql(sql: string): { tokens: SqlToken[]; unterminatedError?: string } {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      let closed = false;
      while (i + 1 < n) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return { tokens, unterminatedError: 'Unterminated block comment.' };
      continue;
    }
    if (ch === "'") {
      let lit = "'";
      i += 1;
      let closed = false;
      while (i < n) {
        lit += sql[i];
        if (sql[i] === "'") {
          if (i + 1 < n && sql[i + 1] === "'") {
            lit += "'";
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return { tokens, unterminatedError: 'Unterminated string literal.' };
      tokens.push({ type: 'string', value: lit });
      continue;
    }
    if (ch === '"') {
      let ident = '';
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (i + 1 < n && sql[i + 1] === '"') {
            ident += '"';
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        ident += sql[i];
        i += 1;
      }
      if (!closed) return { tokens, unterminatedError: 'Unterminated quoted identifier.' };
      tokens.push({ type: 'word', value: ident });
      continue;
    }
    if (ch === ';') {
      tokens.push({ type: 'semicolon', value: ';' });
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let word = '';
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) {
        word += sql[i];
        i += 1;
      }
      tokens.push({ type: 'word', value: word });
      continue;
    }
    tokens.push({ type: 'symbol', value: ch });
    i += 1;
  }

  return { tokens };
}

/**
 * Lexical Read-Only SQL AST Guardrail matching MCP Lakehouse Server policy.
 */
export function validateOlapReadOnlySql(rawSql: string, maxLength = 8000): OlapSqlGuardrailResult {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    return {
      allowed: false,
      statementType: 'EMPTY',
      normalizedSql: '',
      detectedTables: [],
      reason: 'SQL query cannot be empty.',
    };
  }
  if (trimmed.length > maxLength) {
    return {
      allowed: false,
      statementType: 'OVERSIZED',
      normalizedSql: '',
      detectedTables: [],
      reason: `SQL exceeds maximum length (${maxLength}).`,
    };
  }

  const { tokens, unterminatedError } = tokenizeReadOnlySql(trimmed);
  if (unterminatedError) {
    return {
      allowed: false,
      statementType: 'MALFORMED',
      normalizedSql: '',
      detectedTables: [],
      reason: unterminatedError,
    };
  }
  if (tokens.length === 0) {
    return {
      allowed: false,
      statementType: 'EMPTY',
      normalizedSql: '',
      detectedTables: [],
      reason: 'SQL contains only comments/whitespace.',
    };
  }

  const semiIndices = tokens
    .map((t, idx) => (t.type === 'semicolon' ? idx : -1))
    .filter((idx) => idx !== -1);
  if (semiIndices.length > 1 || (semiIndices.length === 1 && semiIndices[0] !== tokens.length - 1)) {
    return {
      allowed: false,
      statementType: 'MULTI_STATEMENT',
      normalizedSql: trimmed,
      detectedTables: [],
      reason: 'Stacked multi-statement SQL execution is forbidden.',
      blockedKeyword: ';',
    };
  }

  const meaningful = semiIndices.length === 1 ? tokens.slice(0, tokens.length - 1) : tokens;
  const firstWord = meaningful.find((t) => t.type === 'word');
  const statementType = firstWord ? firstWord.value.toUpperCase() : 'UNKNOWN';

  if (!ALLOWED_SQL_LEAD.has(statementType)) {
    return {
      allowed: false,
      statementType,
      normalizedSql: trimmed,
      detectedTables: [],
      reason: `Statement "${statementType}" is disallowed in read-only OLAP mode.`,
      blockedKeyword: statementType,
    };
  }

  const detectedTables = new Set<string>();
  for (let i = 0; i < meaningful.length; i += 1) {
    const tok = meaningful[i];
    if (tok.type !== 'word') continue;
    const upper = tok.value.toUpperCase();

    if (FORBIDDEN_SQL_KEYWORDS.has(upper)) {
      return {
        allowed: false,
        statementType,
        normalizedSql: trimmed,
        detectedTables: [...detectedTables],
        reason: `Forbidden SQL keyword "${upper}" blocked by read-only AST guard.`,
        blockedKeyword: upper,
      };
    }

    if (
      upper.startsWith('READ_CSV') ||
      upper.startsWith('READ_PARQUET') ||
      upper.startsWith('READ_JSON') ||
      upper === 'HTTP_GET' ||
      upper === 'GLOB'
    ) {
      return {
        allowed: false,
        statementType,
        normalizedSql: trimmed,
        detectedTables: [...detectedTables],
        reason: `External I/O function "${upper}" is disabled in sandboxed OLAP queries.`,
        blockedKeyword: upper,
      };
    }

    if ((upper === 'FROM' || upper === 'JOIN') && i + 1 < meaningful.length) {
      const nextTok = meaningful[i + 1];
      if (nextTok.type === 'word' && nextTok.value.toUpperCase() !== 'SELECT') {
        detectedTables.add(nextTok.value.toLowerCase());
      }
    }
  }

  return {
    allowed: true,
    statementType,
    normalizedSql: trimmed.replace(/;\s*$/, ''),
    detectedTables: [...detectedTables],
  };
}

/**
 * Compiles any brushed Lasso region into a strictly validated, parameterized read-only SQL query
 * targeting `gold_transactions`.
 */
export function compileBrushToSql(
  rawBox: OlapLassoBox,
  options?: { regions?: readonly OlapRegionCode[] },
): CompiledBrushSql {
  const box = normalizeLassoBox(rawBox);
  const validRegions = (options?.regions ?? []).filter((r): r is OlapRegionCode =>
    (OLAP_REGIONS as readonly string[]).includes(r),
  );
  const uniqueRegions = [...new Set(validRegions)];
  const filterRegions =
    uniqueRegions.length > 0 && uniqueRegions.length < OLAP_REGIONS.length ? uniqueRegions : [];

  const predicates: string[] = [
    `latency_ms BETWEEN ${box.minLatencyMs} AND ${box.maxLatencyMs}`,
    `revenue_usd BETWEEN ${box.minRevenueUsd.toFixed(2)} AND ${box.maxRevenueUsd.toFixed(2)}`,
  ];

  if (filterRegions.length > 0) {
    predicates.push(`region IN (${filterRegions.map((r) => `'${r}'`).join(', ')})`);
  }

  const sql = [
    'SELECT region,',
    '  COUNT(*) AS tx_cnt,',
    '  ROUND(AVG(revenue_usd), 2) AS avg_rev,',
    '  ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms), 1) AS p99_ms',
    'FROM gold_transactions',
    `WHERE ${predicates.join('\n  AND ')}`,
    'GROUP BY region',
    'ORDER BY tx_cnt DESC;',
  ].join('\n');

  const compactSql =
    `SELECT region, COUNT(*) AS tx_cnt, ROUND(AVG(revenue_usd),2) AS avg_rev, ` +
    `ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms),1) AS p99_ms ` +
    `FROM gold_transactions WHERE ${predicates.join(' AND ')} GROUP BY region ORDER BY tx_cnt DESC;`;

  const guardrail = validateOlapReadOnlySql(sql);

  return {
    sql,
    compactSql,
    params: {
      minLatencyMs: box.minLatencyMs,
      maxLatencyMs: box.maxLatencyMs,
      minRevenueUsd: box.minRevenueUsd,
      maxRevenueUsd: box.maxRevenueUsd,
      regions: filterRegions.length > 0 ? filterRegions : [...OLAP_REGIONS],
    },
    guardrail,
  };
}

// ============================================================================
// LIVE STREAMING MEDALLION CDC PIPELINE SIMULATOR (Bronze -> Silver -> dbt Gate -> Gold)
// ============================================================================

export function createInitialMedallionPipelineState(baseRows = 100_000): MedallionPipelineState {
  const baseWatermark = Date.parse('2026-11-28T07:15:00.000Z');
  return {
    streamingMode: 'STEADY',
    schemaDriftActive: false,
    kafkaRateRowsSec: 2_480,
    batchSeq: 0,
    watermarkMs: baseWatermark,
    watermarkIso: new Date(baseWatermark).toISOString().slice(11, 19) + 'Z',
    bronzeRawRows: Math.round(baseRows * 1.032),
    silverCleanedRows: Math.round(baseRows * 1.004),
    silverDedupedRows: Math.round(baseRows * 0.028),
    dbtGatePassedRows: baseRows,
    quarantineDlqRows: 0,
    goldMartRows: baseRows,
    goldCorruptedRows: 0, // Strictly guaranteed 0 by dbt-test quarantine gate
    dbtGateStatus: 'PASSING',
    lastBatchBronze: 0,
    lastBatchSilver: 0,
    lastBatchQuarantined: 0,
    lastBatchGold: 0,
    latencyBronzeToGoldMs: 11.4,
    rateSparkline: [2150, 2320, 2410, 2290, 2490, 2380, 2510, 2440, 2560, 2480],
    activeDriftAlerts: [],
  };
}

const DRIFT_RULES = [
  {
    id: 'dbt_not_null_region',
    rule: 'not_null(region)',
    column: 'region',
    dbtTest: 'dbt_utils.not_null_proportion(at_least=1.0)',
    severity: 'CRITICAL' as const,
    samplePayload: '{"tx_id":"CDC-DRIFT-914","region":null,"revenue_usd":4120.0,"schema_v":"v7_breaking"}',
  },
  {
    id: 'dbt_range_revenue',
    rule: 'accepted_range(revenue_usd >= 0)',
    column: 'revenue_usd',
    dbtTest: 'dbt_expectations.expect_column_values_to_be_between(0, 50000)',
    severity: 'CRITICAL' as const,
    samplePayload: '{"tx_id":"CDC-DRIFT-918","region":"APAC-VN","revenue_usd":-842.50,"currency":"ERR"}',
  },
  {
    id: 'dbt_schema_contract_latency',
    rule: 'schema_type(latency_ms: INT32)',
    column: 'latency_ms',
    dbtTest: 'dbt_contract.enforce_column_types(strict=true)',
    severity: 'WARN' as const,
    samplePayload: '{"tx_id":"CDC-DRIFT-921","region":"NA-EAST","latency_ms":"NaN_STRING","extra_col":true}',
  },
] as const;

/**
 * Advances the Bronze -> Silver -> dbt-test Quarantine Gate -> Gold streaming Medallion pipeline
 * by one micro-batch tick, optionally appending clean Gold points into the live OLAP spatial index.
 */
export function stepMedallionCdcPipeline(
  prev: MedallionPipelineState,
  index?: OlapPointCloudIndex,
  options?: { tickMs?: number; maxPointsAppendedPerTick?: number },
): MedallionStepResult {
  const tickMs = Math.max(100, options?.tickMs ?? 600);
  const nextSeq = prev.batchSeq + 1;
  const rand = mulberry32((20261128 ^ (nextSeq * 1597334677)) >>> 0);

  const isSurge = prev.streamingMode === 'SURGE';
  const targetRate = isSurge
    ? Math.round(10_400 + rand() * 2_200) // +10.4K..12.6K rows/sec during SURGE
    : Math.round(2_200 + rand() * 680); // +2.2K..2.9K rows/sec ambient steady flow

  const bronzeBatch = Math.max(120, Math.round((targetRate * tickMs) / 1000));
  // Silver layer deduplicates ~2.6% duplicate Kafka at-least-once deliveries
  const dedupedBatch = Math.max(1, Math.round(bronzeBatch * (0.022 + rand() * 0.012)));
  const silverBatch = Math.max(0, bronzeBatch - dedupedBatch);

  // dbt-test Quality Gate catches 100% of malformed/schema-drift records before Gold!
  let quarantinedBatch = 0;
  let alerts = prev.activeDriftAlerts;

  if (prev.schemaDriftActive) {
    const driftRate = 0.085 + rand() * 0.045; // 8.5%..13% malformed records injected
    quarantinedBatch = Math.max(12, Math.round(silverBatch * driftRate));

    const detectedIso = new Date(prev.watermarkMs + tickMs).toISOString().slice(11, 19) + 'Z';
    const splitA = Math.round(quarantinedBatch * 0.48);
    const splitB = Math.round(quarantinedBatch * 0.34);
    const splitC = Math.max(1, quarantinedBatch - splitA - splitB);
    const splits = [splitA, splitB, splitC];

    alerts = DRIFT_RULES.map((def, idx) => {
      const existing = prev.activeDriftAlerts.find((a) => a.id === def.id);
      return {
        id: def.id,
        rule: def.rule,
        column: def.column,
        dbtTest: def.dbtTest,
        interceptedCount: (existing?.interceptedCount ?? 0) + splits[idx],
        severity: def.severity,
        samplePayload: def.samplePayload,
        detectedAt: detectedIso,
      };
    });
  }

  const goldBatch = Math.max(0, silverBatch - quarantinedBatch);
  const nextWatermarkMs = prev.watermarkMs + tickMs;
  const watermarkIso = new Date(nextWatermarkMs).toISOString().slice(11, 19) + 'Z';

  // Append a crisp visual burst of live Golden points directly into the GPU point cloud
  let appendedGoldPoints = 0;
  if (index && goldBatch > 0) {
    const cap = options?.maxPointsAppendedPerTick ?? (isSurge ? 420 : 65);
    const visualAppend = Math.min(cap, Math.max(18, Math.round(goldBatch * (isSurge ? 0.08 : 0.05))));
    appendedGoldPoints = appendStreamingPointsToIndex(index, visualAppend, nextSeq, isSurge);
  }

  const latencyMs = Number(
    (isSurge ? 12.6 + rand() * 3.8 : 8.4 + rand() * 2.4).toFixed(1),
  );

  const nextState: MedallionPipelineState = {
    ...prev,
    kafkaRateRowsSec: targetRate,
    batchSeq: nextSeq,
    watermarkMs: nextWatermarkMs,
    watermarkIso,
    bronzeRawRows: prev.bronzeRawRows + bronzeBatch,
    silverCleanedRows: prev.silverCleanedRows + silverBatch,
    silverDedupedRows: prev.silverDedupedRows + dedupedBatch,
    dbtGatePassedRows: prev.dbtGatePassedRows + goldBatch,
    quarantineDlqRows: prev.quarantineDlqRows + quarantinedBatch,
    goldMartRows: prev.goldMartRows + goldBatch,
    goldCorruptedRows: 0, // Strictly 0: dbt-test gate intercepts 100% of bad payloads into Quarantine DLQ
    dbtGateStatus: prev.schemaDriftActive ? 'INTERCEPTING_DRIFT' : 'PASSING',
    lastBatchBronze: bronzeBatch,
    lastBatchSilver: silverBatch,
    lastBatchQuarantined: quarantinedBatch,
    lastBatchGold: goldBatch,
    latencyBronzeToGoldMs: latencyMs,
    rateSparkline: [...prev.rateSparkline, targetRate].slice(-18),
    activeDriftAlerts: alerts,
  };

  return {
    nextState,
    appendedGoldPoints,
    quarantinedBatchRows: quarantinedBatch,
    injectedDriftThisTick: quarantinedBatch > 0,
  };
}

// ============================================================================
// 3D OLAP ANOMALY CUBE PROJECTION & CLUSTER BEACONS
// ============================================================================

export function createDefaultCubeCamera(): Cube3dCamera {
  return {
    yaw: -0.78, // crisp sculpted 3/4 isometric angle showing all 4 strata clearly
    pitch: 0.34, // elevated vantage highlighting Z-axis fraud elevation
    zoom: 1.32,
  };
}

/**
 * Projects a normalized 3D cube coordinate (nx, ny, nz in [0, 1]) into 2D viewport screen space
 * using a clean orbital perspective camera (X: Latency, Y: Revenue, Z: Risk Score).
 */
export function project3dCubePoint(
  nx: number,
  ny: number,
  nz: number,
  camera: Cube3dCamera,
  width: number,
  height: number,
): Projected3dPoint {
  // Center cube in [-1, 1]^3; map Z (risk) to vertical height, X (latency) right, Y (revenue) depth
  const cx = (nx - 0.5) * 2.05;
  const cy = (nz - 0.5) * 1.85; // vertical elevation = Risk Score (anomalies soar high!)
  const cz = (ny - 0.5) * 2.05; // depth axis = Revenue USD

  const cosY = Math.cos(camera.yaw);
  const sinY = Math.sin(camera.yaw);
  const cosP = Math.cos(camera.pitch);
  const sinP = Math.sin(camera.pitch);

  // Rotate around vertical Y axis (yaw)
  const rx = cx * cosY - cz * sinY;
  const rz0 = cx * sinY + cz * cosY;

  // Rotate around horizontal X axis (pitch)
  const ry = cy * cosP - rz0 * sinP;
  const rz = cy * sinP + rz0 * cosP;

  const camDist = 3.95;
  const zDepth = camDist - rz;
  if (zDepth <= 0.4) {
    return { sx: -9999, sy: -9999, depth: zDepth, scale: 0, visible: false };
  }

  const focal = Math.min(width, height) * 0.98 * clamp(camera.zoom, 0.65, 1.85);
  const scale = focal / zDepth;
  const centerX = width > 720 ? width * 0.56 : width * 0.5;
  const sx = centerX + rx * scale;
  const sy = height * 0.52 - ry * scale;

  return { sx, sy, depth: zDepth, scale: scale / Math.max(1, Math.min(width, height)), visible: true };
}

/**
 * Computes live 3D cluster beacons from the current OLAP index for interactive hover/click drilldown.
 */
export function computeOlapClusterBeacons(index: OlapPointCloudIndex): OlapClusterBeacon[] {
  const whale = queryOlapLassoBox(index, OLAP_BRUSH_PRESETS[0].box, { updateMask: false });
  const bots = queryOlapLassoBox(index, OLAP_BRUSH_PRESETS[1].box, { updateMask: false });
  const watch = queryOlapLassoBox(index, OLAP_BRUSH_PRESETS[2].box, { updateMask: false });
  const nominal = queryOlapLassoBox(
    index,
    { minLatencyMs: 8, maxLatencyMs: 220, minRevenueUsd: 10, maxRevenueUsd: 2600 },
    { updateMask: false },
  );

  return [
    {
      id: 'cluster-whale',
      label: 'High-Latency Whale Anomalies',
      subtitle: 'Enterprise high-ticket SLA breach cluster',
      regionTop: whale.regionBreakdown[0]?.region ?? 'APAC-VN',
      cx: 0.70,
      cy: 0.72,
      cz: 0.89,
      count: whale.selectedCount,
      avgRevenueUsd: whale.avgRevenueUsd,
      p99LatencyMs: whale.p99LatencyMs,
      anomalyPct: whale.anomalyPct,
      severity: 'critical',
      presetBox: OLAP_BRUSH_PRESETS[0].box,
    },
    {
      id: 'cluster-voucher-bots',
      label: 'Voucher Bot Micro-Bursts',
      subtitle: 'Coordinated promo redemption spikes',
      regionTop: bots.regionBreakdown[0]?.region ?? 'APAC-VN',
      cx: 0.60,
      cy: 0.14,
      cz: 0.84,
      count: bots.selectedCount,
      avgRevenueUsd: bots.avgRevenueUsd,
      p99LatencyMs: bots.p99LatencyMs,
      anomalyPct: bots.anomalyPct,
      severity: 'critical',
      presetBox: OLAP_BRUSH_PRESETS[1].box,
    },
    {
      id: 'cluster-watch-band',
      label: 'Mid-Latency Watch Corridor',
      subtitle: 'Elevated latency transitional cohort',
      regionTop: watch.regionBreakdown[0]?.region ?? 'APAC-SG',
      cx: 0.28,
      cy: 0.30,
      cz: 0.56,
      count: watch.selectedCount,
      avgRevenueUsd: watch.avgRevenueUsd,
      p99LatencyMs: watch.p99LatencyMs,
      anomalyPct: watch.anomalyPct,
      severity: 'watch',
      presetBox: OLAP_BRUSH_PRESETS[2].box,
    },
    {
      id: 'cluster-nominal-core',
      label: 'Nominal Edge Mesh',
      subtitle: 'Sub-100ms healthy POS settlement core',
      regionTop: nominal.regionBreakdown[0]?.region ?? 'APAC-VN',
      cx: 0.09,
      cy: 0.14,
      cz: 0.18,
      count: nominal.selectedCount,
      avgRevenueUsd: nominal.avgRevenueUsd,
      p99LatencyMs: nominal.p99LatencyMs,
      anomalyPct: nominal.anomalyPct,
      severity: 'nominal',
      presetBox: {
        minLatencyMs: 8,
        maxLatencyMs: 220,
        minRevenueUsd: 10,
        maxRevenueUsd: 2600,
        label: 'Nominal Edge Mesh',
      },
    },
  ];
}
