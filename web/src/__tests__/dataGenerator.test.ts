import { describe, expect, it } from 'vitest';
import {
  buildArrowIpcFromTransactions,
  generateColumnarTransactions,
} from '../engine/dataGenerator';

describe('Columnar Transaction Generator & Arrow IPC', () => {
  it('generates 100,000 deterministic transactions with valid GPU vertex buffers', () => {
    const ds = generateColumnarTransactions(100_000, 20261126);
    expect(ds.rowCount).toBe(100_000);
    expect(ds.gpuVertexBuffer.length).toBe(100_000 * 6);

    let anomalyCount = 0;
    let outOfBounds = 0;
    for (let i = 0; i < ds.rowCount; i += 1) {
      if (ds.isAnomaly[i] === 1) anomalyCount += 1;
      if (ds.xCoord[i] < 0 || ds.xCoord[i] > 1 || ds.riskScore[i] < 0 || ds.riskScore[i] > 1) {
        outOfBounds += 1;
      }
    }
    expect(outOfBounds).toBe(0);

    // Realistic ~4.4% anomaly burst density
    expect(anomalyCount).toBeGreaterThan(2500);
    expect(anomalyCount).toBeLessThan(7000);
  });

  it('serializes columnar dataset cleanly into Apache Arrow IPC stream bytes', () => {
    const ds = generateColumnarTransactions(2_000, 42);
    const ipc = buildArrowIpcFromTransactions(ds);
    expect(ipc).toBeInstanceOf(Uint8Array);
    expect(ipc.byteLength).toBeGreaterThan(10_000);
  });
});
