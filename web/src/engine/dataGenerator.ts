import { tableFromArrays, tableToIPC } from 'apache-arrow';
import type { CategoryCode, ColumnarTransactions, RegionCode } from '../types/lakehouse';

export const REGIONS: readonly RegionCode[] = [
  'APAC-VN',
  'APAC-SG',
  'NA-WEST',
  'NA-EAST',
  'EU-CENTRAL',
] as const;

export const CATEGORIES: readonly CategoryCode[] = [
  'RETAIL_POS',
  'VOUCHER_REDEEM',
  'FLASH_SALE',
  'SUBSCRIPTION',
  'B2B_SETTLEMENT',
] as const;

export const VOUCHER_CODES: readonly string[] = [
  'VIP-TET-50',
  'FLASH-99',
  'LOYALTY-20',
  'PARTNER-X',
  'CORP-Q4',
  'REDEEM-BOT-7',
] as const;

// Regional base profile weights to produce rich, realistic cluster shapes in SQL & WebGPU
const REGION_RISK_BIAS = [0.06, 0.02, 0.04, 0.03, 0.015];
const REGION_LATENCY_BASE = [24, 18, 32, 29, 27];

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

/**
 * Generates realistic retail/fintech transaction dataset in columnar TypedArrays
 * plus a zero-copy GPU interleaved vertex buffer [x, y, risk, regionIdx, timeNorm, isAnomaly].
 * Runs 100,000 rows in ~50-90ms and 500,000 rows in ~280-450ms in V8.
 */
export function generateColumnarTransactions(
  rowCount: number,
  seed = 20261126,
): ColumnarTransactions {
  const start = performance.now();
  const rand = mulberry32(seed);
  const nowMs = Date.parse('2026-11-26T12:00:00.000Z');
  const horizonMs = 7 * 24 * 3600 * 1000; // 7 days

  const txId = new Array<string>(rowCount);
  const tsMs = new Float64Array(rowCount);
  const storeId = new Uint16Array(rowCount);
  const regionIdx = new Uint8Array(rowCount);
  const categoryIdx = new Uint8Array(rowCount);
  const amountUsd = new Float32Array(rowCount);
  const riskScore = new Float32Array(rowCount);
  const latencyMs = new Uint16Array(rowCount);
  const voucherIdx = new Int8Array(rowCount);
  const isAnomaly = new Uint8Array(rowCount);
  const xCoord = new Float32Array(rowCount);
  const yCoord = new Float32Array(rowCount);
  const gpuVertexBuffer = new Float32Array(rowCount * 6);

  const logMaxAmount = Math.log10(6500);

  // Fast Box-Muller Gaussian helper for realistic organic scatter clouds
  const randNormal = (): number => {
    const u1 = Math.max(1e-7, rand());
    const u2 = rand();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  };

  for (let i = 0; i < rowCount; i += 1) {
    // Weighted region distribution (APAC-VN highest retail density, realistic multi-region spread)
    const rPick = rand();
    let rIdx = 0;
    if (rPick < 0.28) rIdx = 0;
    else if (rPick < 0.46) rIdx = 1;
    else if (rPick < 0.66) rIdx = 2;
    else if (rPick < 0.84) rIdx = 3;
    else rIdx = 4;

    const cPick = rand();
    let cIdx = 0;
    if (cPick < 0.44) cIdx = 0;
    else if (cPick < 0.66) cIdx = 1;
    else if (cPick < 0.81) cIdx = 2;
    else if (cPick < 0.92) cIdx = 3;
    else cIdx = 4;

    // Multi-modal realistic distribution: 84% nominal, 11.6% elevated watch-zone, 4.4% fraud bursts
    const burstRoll = rand();
    const isFraudBurst = burstRoll < 0.044;
    const isWatchZone = !isFraudBurst && burstRoll < 0.16;
    const isVoucherAttack = isFraudBurst && (cIdx === 1 || rand() < 0.52);

    // Time offset: anomalies slightly denser in recent 36h window for realistic burst monitoring
    const timeNorm = isFraudBurst
      ? Math.min(0.999, Math.max(0.05, 0.78 + randNormal() * 0.16))
      : Math.pow(rand(), 0.92);
    const ts = nowMs - (1 - timeNorm) * horizonMs;

    const store = isVoucherAttack
      ? 100 + Math.floor(rand() * 24) // concentrated store cluster during voucher abuse
      : 100 + Math.floor(rand() * 720);

    let amt: number;
    let risk: number;
    let lat: number;

    if (isFraudBurst) {
      // Two distinct high-risk anomaly clusters (voucher bot burst + high-ticket carding)
      const logMean = isVoucherAttack ? 2.65 : 3.22;
      amt = Math.pow(10, Math.min(3.8, Math.max(1.6, logMean + randNormal() * 0.28)));
      risk = Math.min(0.985, Math.max(0.752, 0.84 + REGION_RISK_BIAS[rIdx] + randNormal() * 0.055));
      lat = Math.round(Math.max(70, 260 + randNormal() * 140));
    } else if (isWatchZone) {
      // Transitional amber watch-zone cluster bridging nominal & anomaly
      const logMean = 2.35 + (cIdx === 4 ? 0.45 : 0);
      amt = Math.pow(10, Math.min(3.75, Math.max(1.1, logMean + randNormal() * 0.36)));
      risk = Math.min(0.745, Math.max(0.46, 0.59 + randNormal() * 0.075));
      lat = Math.round(Math.max(20, 95 + randNormal() * 55));
    } else {
      // Smooth log-normal nominal retail distribution
      const catMean = cIdx === 4 ? 2.65 : cIdx === 2 ? 2.05 : 1.72;
      amt = Math.pow(10, Math.min(3.55, Math.max(0.75, catMean + randNormal() * 0.42)));
      risk = Math.min(0.56, Math.max(0.02, 0.21 + REGION_RISK_BIAS[rIdx] * 0.8 + randNormal() * 0.11));
      lat = Math.round(Math.max(6, REGION_LATENCY_BASE[rIdx] + Math.abs(randNormal()) * 34));
    }

    amt = Math.round(amt * 100) / 100;
    risk = Math.round(risk * 10000) / 10000;

    let vIdx = -1;
    if (isVoucherAttack) {
      vIdx = rand() < 0.65 ? 5 : 1; // REDEEM-BOT-7 or FLASH-99 concentrated abuse
    } else if (cIdx === 1 || rand() < 0.22) {
      vIdx = Math.floor(rand() * 5);
    }

    const anom = risk >= 0.75 ? 1 : 0;

    // Normalized GPU scatter coordinates in [0.02, 0.98]
    const xNorm = Math.max(0.02, Math.min(0.98, Math.log10(Math.max(1, amt)) / logMaxAmount));
    const yNorm = Math.max(0.02, Math.min(0.98, risk));
    const latNorm = Math.max(0.02, Math.min(0.98, Math.min(lat, 850) / 850));

    txId[i] = `TX-${String(i + 1).padStart(7, '0')}`;
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
    gpuVertexBuffer[base + 4] = timeNorm;
    gpuVertexBuffer[base + 5] = anom;
  }

  return {
    rowCount,
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
  };
}

/**
 * Packs ColumnarTransactions into an Apache Arrow IPC stream for ultra-fast
 * zero-parse ingestion into DuckDB-WASM (`insertArrowFromIPCStream`).
 */
export function buildArrowIpcFromTransactions(data: ColumnarTransactions): Uint8Array {
  const n = data.rowCount;
  const tsIso = new Array<string>(n);
  const storeStr = new Array<string>(n);
  const regionStr = new Array<string>(n);
  const categoryStr = new Array<string>(n);
  const voucherStr = new Array<string | null>(n);
  const anomalyBool = new Array<boolean>(n);

  for (let i = 0; i < n; i += 1) {
    tsIso[i] = new Date(data.tsMs[i]).toISOString();
    storeStr[i] = `STR-${data.storeId[i]}`;
    regionStr[i] = REGIONS[data.regionIdx[i]];
    categoryStr[i] = CATEGORIES[data.categoryIdx[i]];
    const v = data.voucherIdx[i];
    voucherStr[i] = v >= 0 ? VOUCHER_CODES[v] : null;
    anomalyBool[i] = data.isAnomaly[i] === 1;
  }

  const arrowTable = tableFromArrays({
    tx_id: data.txId,
    ts: tsIso,
    store_id: storeStr,
    region: regionStr,
    category: categoryStr,
    amount_usd: data.amountUsd,
    risk_score: data.riskScore,
    latency_ms: Int32Array.from(data.latencyMs),
    voucher_code: voucherStr,
    is_anomaly: anomalyBool,
    x_coord: data.xCoord,
    y_coord: data.yCoord,
  });

  return tableToIPC(arrowTable, 'stream');
}
