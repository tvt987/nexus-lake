import { describe, expect, it } from 'vitest';
import {
  appendCdcBatch,
  buildLakehouseSnapshotPayload,
  DEFAULT_CDC_TELEMETRY,
  generateCdcBatch,
  nextCdcTelemetry,
} from '../engine/cdcStream';
import { generateColumnarTransactions } from '../engine/dataGenerator';

describe('Live Streaming CDC Engine & Snapshot Export', () => {
  it('generates realistic ~5,000 tx/sec Kafka CDC batches with periodic burst waves', () => {
    const gen1 = generateCdcBatch(4_500, 100_000, 1, 1764158400000, 900);
    expect(gen1.batch.rowCount).toBe(4_500);
    expect(gen1.simulatedRateTxSec).toBe(5_000);
    expect(gen1.burstSpike).toBe(true);
    expect(gen1.anomalyCount).toBeGreaterThan(250);
    expect(gen1.batch.txId[0]).toBe('CDC-0100001');
    expect(gen1.batch.gpuVertexBuffer.length).toBe(4_500 * 6);
  });

  it('appends CDC micro-batches into columnar TypedArrays while respecting sliding window cap', () => {
    const base = generateColumnarTransactions(2_000, 11);
    const { batch } = generateCdcBatch(500, 2_000, 2);

    const appended = appendCdcBatch(base, batch, 10_000);
    expect(appended.rowCount).toBe(2_500);
    expect(appended.txId[2_000]).toBe('CDC-0002001');
    expect(appended.gpuVertexBuffer.length).toBe(2_500 * 6);

    // Sliding window eviction test when cap is smaller than sum
    const capped = appendCdcBatch(base, batch, 2_200);
    expect(capped.rowCount).toBe(2_200);
    expect(capped.txId[capped.rowCount - 1]).toBe('CDC-0002500');
  });

  it('tracks CDC sparkline telemetry, burst alerts, and builds v2.0 snapshot payload', () => {
    const gen = generateCdcBatch(4_500, 100_000, 1);
    const tel = nextCdcTelemetry(DEFAULT_CDC_TELEMETRY, gen, 14.2);

    expect(tel.isStreaming).toBe(true);
    expect(tel.batchCount).toBe(1);
    expect(tel.totalIngestedRows).toBe(4_500);
    expect(tel.burstAlertActive).toBe(true);
    expect(tel.rateHistory[tel.rateHistory.length - 1]).toBe(5_000);

    const snapshot = buildLakehouseSnapshotPayload({
      engine: 'DUCKDB-WASM',
      totalRows: 104_500,
      activeSql: 'SELECT region, COUNT(*) FROM transactions GROUP BY region;',
      cdcTelemetry: tel,
      activeBrushBounds: null,
      queryResult: null,
      queryHistory: [],
    });
    expect(snapshot.version).toBe('2.0.0');
    expect(snapshot.totalRows).toBe(104_500);
    expect(snapshot.cdcTelemetry.totalIngestedRows).toBe(4_500);
    expect(snapshot.activeSql).toContain('GROUP BY region');
  });
});
