import { describe, expect, it } from 'vitest';
import { generateColumnarTransactions } from '../engine/dataGenerator';
import { runFallbackSql } from '../engine/duckdbEngine';
import { SQL_PRESETS } from '../engine/sqlPresets';

describe('OLAP Fallback SQL Evaluator', () => {
  const ds = generateColumnarTransactions(10_000, 777);

  it('executes all 6 curated OLAP presets cleanly', () => {
    for (const preset of SQL_PRESETS) {
      const res = runFallbackSql(preset.sql, ds, new Map());
      expect(res.error).toBeUndefined();
      expect(res.rowCount, `Preset ${preset.id} should return rows`).toBeGreaterThan(0);
      expect(res.scannedRows).toBe(10_000);
      expect(res.columns.length).toBeGreaterThan(0);
    }
  });

  it('queries custom uploaded tables cleanly', () => {
    const uploads = new Map<string, Record<string, unknown>[]>([
      [
        'merchant_tiers',
        [
          { merchant_id: 'MCH-001', region: 'APAC-VN', gmv: 482000 },
          { merchant_id: 'MCH-002', region: 'APAC-SG', gmv: 619500 },
        ],
      ],
    ]);
    const res = runFallbackSql('SELECT * FROM merchant_tiers LIMIT 10;', ds, uploads);
    expect(res.rowCount).toBe(2);
    expect(res.columns).toEqual(['merchant_id', 'region', 'gmv']);
  });
});
