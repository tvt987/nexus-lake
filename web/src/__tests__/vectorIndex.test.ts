import { describe, expect, it } from 'vitest';
import { SQL_PRESETS } from '../engine/sqlPresets';
import { cosineSimilarity, embedText128d, LocalSemanticVectorIndex } from '../engine/vectorIndex';

describe('128-d Local Semantic Vector Index', () => {
  it('produces L2-normalized 128-d vectors with self-similarity of 1.0', () => {
    const v = embedText128d('fraud spikes by region');
    expect(v.length).toBe(128);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 4);
  });

  it('ranks relevant presets and columns for "fraud spikes by region"', () => {
    const idx = new LocalSemanticVectorIndex();
    idx.rebuild(
      [
        {
          name: 'transactions',
          rowCount: 100_000,
          source: 'synthetic',
          columns: [
            { name: 'region', type: 'VARCHAR' },
            { name: 'risk_score', type: 'FLOAT' },
            { name: 'is_anomaly', type: 'BOOLEAN' },
            { name: 'voucher_code', type: 'VARCHAR' },
            { name: 'latency_ms', type: 'INTEGER' },
          ],
        },
      ],
      SQL_PRESETS,
      [],
    );

    const hits = idx.search('fraud spikes by region', 5);
    expect(hits.length).toBeGreaterThan(0);
    const titles = hits.map((h) => h.title.toLowerCase());
    expect(
      titles.some((t) => t.includes('fraud') || t.includes('region') || t.includes('anomaly')),
    ).toBe(true);
    expect(hits[0].score).toBeGreaterThan(0.2);
  });
});
