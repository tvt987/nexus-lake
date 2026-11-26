import { LOG_MAX_AMOUNT, MAX_LATENCY_MS } from './brushToSql';
import type {
  BrushSelectionBounds,
  CdcTelemetryState,
  ColumnarTransactions,
  EngineBackend,
  LakehouseSnapshotPayload,
  QueryHistoryEntry,
  SqlQueryResult,
} from '../types/lakehouse';

const REGION_RISK_BIAS = [0.06, 0.02, 0.04, 0.03, 0.015];
const REGION_LATENCY_BASE = [24, 18, 32, 29, 27];

export const DEFAULT_CDC_TELEMETRY: CdcTelemetryState = {
  isStreaming: false,
  topicName: 'kafka://retail-pos-tx.v2',
  currentRateTxSec: 0,
  totalIngestedRows: 0,
  totalBurstAnomalies: 0,
  batchCount: 0,
  lastIngestMs: 0,
  lastBatchAnomalies: 0,
  burstAlertActive: false,
  rateHistory: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

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

export interface GeneratedCdcBatch {
  batch: ColumnarTransactions;
  anomalyCount: number;
  simulatedRateTxSec: number;
  burstSpike: boolean;
}

/**
 * Generates a real-time Kafka CDC micro-batch (~4,500 tx per 900ms tick => ~5,000 tx/sec)
 * in columnar TypedArrays + interleaved GPU vertex layout ready for zero-copy append.
 */
export function generateCdcBatch(
  batchSize: number,
  startSeq: number,
  batchIndex: number,
  nowMs = Date.now(),
  tickIntervalMs = 900,
): GeneratedCdcBatch {
  const start = performance.now();
  const rand = mulberry32((20261126 ^ (batchIndex * 2654435761)) >>> 0);

  // Periodic realistic fraud burst wave every 3rd batch for crisp live monitoring
  const burstSpike = batchIndex % 3 === 1;
  const anomalyProb = burstSpike ? 0.088 : 0.042;

  const txId = new Array<string>(batchSize);
  const tsMs = new Float64Array(batchSize);
  const storeId = new Uint16Array(batchSize);
  const regionIdx = new Uint8Array(batchSize);
  const categoryIdx = new Uint8Array(batchSize);
  const amountUsd = new Float32Array(batchSize);
  const riskScore = new Float32Array(batchSize);
  const latencyMs = new Uint16Array(batchSize);
  const voucherIdx = new Int8Array(batchSize);
  const isAnomaly = new Uint8Array(batchSize);
  const xCoord = new Float32Array(batchSize);
  const yCoord = new Float32Array(batchSize);
  const gpuVertexBuffer = new Float32Array(batchSize * 6);

  const randNormal = (): number => {
    const u1 = Math.max(1e-7, rand());
    const u2 = rand();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  };

  let anomalyCount = 0;

  for (let i = 0; i < batchSize; i += 1) {
    const rPick = rand();
    let rIdx = 0;
    if (rPick < 0.30) rIdx = 0;
    else if (rPick < 0.48) rIdx = 1;
    else if (rPick < 0.67) rIdx = 2;
    else if (rPick < 0.85) rIdx = 3;
    else rIdx = 4;

    const cPick = rand();
    let cIdx = 0;
    if (cPick < 0.42) cIdx = 0;
    else if (cPick < 0.66) cIdx = 1;
    else if (cPick < 0.82) cIdx = 2;
    else if (cPick < 0.92) cIdx = 3;
    else cIdx = 4;

    const roll = rand();
    const isFraud = roll < anomalyProb;
    const isWatch = !isFraud && roll < anomalyProb + 0.12;
    const isVoucherAttack = isFraud && (cIdx === 1 || rand() < 0.55);

    const ts = nowMs - Math.floor(rand() * tickIntervalMs);
    const store = isVoucherAttack
      ? 100 + Math.floor(rand() * 20)
      : 100 + Math.floor(rand() * 720);

    let amt: number;
    let risk: number;
    let lat: number;

    if (isFraud) {
      const logMean = isVoucherAttack ? 2.75 : 3.28;
      amt = Math.pow(10, Math.min(3.8, Math.max(1.6, logMean + randNormal() * 0.25)));
      risk = Math.min(0.992, Math.max(0.755, 0.86 + REGION_RISK_BIAS[rIdx] + randNormal() * 0.05));
      lat = Math.round(Math.max(80, 290 + randNormal() * 135));
    } else if (isWatch) {
      amt = Math.pow(10, Math.min(3.7, Math.max(1.1, 2.38 + randNormal() * 0.35)));
      risk = Math.min(0.745, Math.max(0.47, 0.6 + randNormal() * 0.07));
      lat = Math.round(Math.max(20, 98 + randNormal() * 52));
    } else {
      const catMean = cIdx === 4 ? 2.65 : cIdx === 2 ? 2.08 : 1.74;
      amt = Math.pow(10, Math.min(3.55, Math.max(0.75, catMean + randNormal() * 0.4)));
      risk = Math.min(0.55, Math.max(0.02, 0.21 + REGION_RISK_BIAS[rIdx] * 0.8 + randNormal() * 0.1));
      lat = Math.round(Math.max(6, REGION_LATENCY_BASE[rIdx] + Math.abs(randNormal()) * 32));
    }

    amt = Math.round(amt * 100) / 100;
    risk = Math.round(risk * 10000) / 10000;

    let vIdx = -1;
    if (isVoucherAttack) {
      vIdx = rand() < 0.7 ? 5 : 1;
    } else if (cIdx === 1 || rand() < 0.22) {
      vIdx = Math.floor(rand() * 5);
    }

    const anom = risk >= 0.75 ? 1 : 0;
    if (anom === 1) anomalyCount += 1;

    const xNorm = Math.max(0.02, Math.min(0.98, Math.log10(Math.max(1, amt)) / LOG_MAX_AMOUNT));
    const yNorm = Math.max(0.02, Math.min(0.98, risk));
    const latNorm = Math.max(0.02, Math.min(0.98, Math.min(lat, MAX_LATENCY_MS) / MAX_LATENCY_MS));

    txId[i] = `CDC-${String(startSeq + i + 1).padStart(7, '0')}`;
    tsMs[i] = ts;
    storeId[i] = store;
    regionIdx[i] = rIdx;
    categoryIdx[i] = cIdx;
    amountUsd[i] = amt;
    riskScore[i] = risk;
    latencyMs[i] = lat;
    voucherIdx[i] = vIdx;
    isAnomaly[i] = anom;
    xCoord[i] = xNorm;
    yCoord[i] = yNorm;

    const base = i * 6;
    gpuVertexBuffer[base] = xNorm;
    gpuVertexBuffer[base + 1] = yNorm;
    gpuVertexBuffer[base + 2] = latNorm;
    gpuVertexBuffer[base + 3] = rIdx;
    gpuVertexBuffer[base + 4] = 0.995; // latest edge of time window
    gpuVertexBuffer[base + 5] = anom;
  }

  const simulatedRateTxSec = Math.round((batchSize / tickIntervalMs) * 1000);

  return {
    batch: {
      rowCount: batchSize,
      generationMs: Number((performance.now() - start).toFixed(1)),
      txId,
      tsMs,
      storeId,
      regionIdx,
      categoryIdx,
      amountUsd,
      riskScore,
      latencyMs,
      voucherIdx,
      isAnomaly,
      xCoord,
      yCoord,
      gpuVertexBuffer,
    },
    anomalyCount,
    simulatedRateTxSec,
    burstSpike,
  };
}

/**
 * Appends a CDC micro-batch to an existing ColumnarTransactions dataset using
 * fast TypedArray.set() memcpy while enforcing a sliding memory window cap.
 */
export function appendCdcBatch(
  current: ColumnarTransactions,
  batch: ColumnarTransactions,
  maxWindowRows = 500_000,
): ColumnarTransactions {
  const combinedCount = current.rowCount + batch.rowCount;
  const dropCount = Math.max(0, combinedCount - maxWindowRows);
  const keepCurrent = current.rowCount - dropCount;
  const totalCount = keepCurrent + batch.rowCount;

  const txId = new Array<string>(totalCount);
  for (let i = 0; i < keepCurrent; i += 1) {
    txId[i] = current.txId[dropCount + i];
  }
  for (let i = 0; i < batch.rowCount; i += 1) {
    txId[keepCurrent + i] = batch.txId[i];
  }

  const tsMs = new Float64Array(totalCount);
  tsMs.set(current.tsMs.subarray(dropCount), 0);
  tsMs.set(batch.tsMs, keepCurrent);

  const storeId = new Uint16Array(totalCount);
  storeId.set(current.storeId.subarray(dropCount), 0);
  storeId.set(batch.storeId, keepCurrent);

  const regionIdx = new Uint8Array(totalCount);
  regionIdx.set(current.regionIdx.subarray(dropCount), 0);
  regionIdx.set(batch.regionIdx, keepCurrent);

  const categoryIdx = new Uint8Array(totalCount);
  categoryIdx.set(current.categoryIdx.subarray(dropCount), 0);
  categoryIdx.set(batch.categoryIdx, keepCurrent);

  const amountUsd = new Float32Array(totalCount);
  amountUsd.set(current.amountUsd.subarray(dropCount), 0);
  amountUsd.set(batch.amountUsd, keepCurrent);

  const riskScore = new Float32Array(totalCount);
  riskScore.set(current.riskScore.subarray(dropCount), 0);
  riskScore.set(batch.riskScore, keepCurrent);

  const latencyMs = new Uint16Array(totalCount);
  latencyMs.set(current.latencyMs.subarray(dropCount), 0);
  latencyMs.set(batch.latencyMs, keepCurrent);

  const voucherIdx = new Int8Array(totalCount);
  voucherIdx.set(current.voucherIdx.subarray(dropCount), 0);
  voucherIdx.set(batch.voucherIdx, keepCurrent);

  const isAnomaly = new Uint8Array(totalCount);
  isAnomaly.set(current.isAnomaly.subarray(dropCount), 0);
  isAnomaly.set(batch.isAnomaly, keepCurrent);

  const xCoord = new Float32Array(totalCount);
  xCoord.set(current.xCoord.subarray(dropCount), 0);
  xCoord.set(batch.xCoord, keepCurrent);

  const yCoord = new Float32Array(totalCount);
  yCoord.set(current.yCoord.subarray(dropCount), 0);
  yCoord.set(batch.yCoord, keepCurrent);

  const gpuVertexBuffer = new Float32Array(totalCount * 6);
  gpuVertexBuffer.set(current.gpuVertexBuffer.subarray(dropCount * 6), 0);
  gpuVertexBuffer.set(batch.gpuVertexBuffer, keepCurrent * 6);

  return {
    rowCount: totalCount,
    generationMs: batch.generationMs,
    txId,
    tsMs,
    storeId,
    regionIdx,
    categoryIdx,
    amountUsd,
    riskScore,
    latencyMs,
    voucherIdx,
    isAnomaly,
    xCoord,
    yCoord,
    gpuVertexBuffer,
  };
}

export function nextCdcTelemetry(
  prev: CdcTelemetryState,
  generated: GeneratedCdcBatch,
  ingestMs: number,
  maxHistory = 24,
): CdcTelemetryState {
  const rateHistory = [...prev.rateHistory, generated.simulatedRateTxSec].slice(-maxHistory);
  const anomalyRate = generated.anomalyCount / Math.max(1, generated.batch.rowCount);
  return {
    ...prev,
    isStreaming: true,
    currentRateTxSec: generated.simulatedRateTxSec,
    totalIngestedRows: prev.totalIngestedRows + generated.batch.rowCount,
    totalBurstAnomalies: prev.totalBurstAnomalies + generated.anomalyCount,
    batchCount: prev.batchCount + 1,
    lastIngestMs: Number(ingestMs.toFixed(1)),
    lastBatchAnomalies: generated.anomalyCount,
    burstAlertActive: generated.burstSpike || anomalyRate >= 0.055,
    rateHistory,
  };
}

export function buildLakehouseSnapshotPayload(params: {
  engine: EngineBackend;
  totalRows: number;
  activeSql: string;
  cdcTelemetry: CdcTelemetryState;
  activeBrushBounds: BrushSelectionBounds | null;
  queryResult: SqlQueryResult | null;
  queryHistory: QueryHistoryEntry[];
}): LakehouseSnapshotPayload {
  return {
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    engine: params.engine,
    totalRows: params.totalRows,
    activeSql: params.activeSql,
    cdcTelemetry: params.cdcTelemetry,
    activeBrushBounds: params.activeBrushBounds,
    queryResult: params.queryResult
      ? {
          columns: params.queryResult.columns,
          rowCount: params.queryResult.rowCount,
          scannedRows: params.queryResult.scannedRows,
          executionMs: params.queryResult.executionMs,
          rowsPerSec: params.queryResult.rowsPerSec,
          rows: params.queryResult.rows.slice(0, 250),
        }
      : null,
    queryHistory: params.queryHistory.slice(0, 25),
  };
}
