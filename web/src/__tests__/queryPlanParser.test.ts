import { describe, expect, it } from 'vitest';
import {
  buildQueryPlanAnalysis,
  computeArrowBufferBreakdown,
  formatByteSize,
} from '../engine/queryPlanParser';
import { generateColumnarTransactions } from '../engine/dataGenerator';
import { runFallbackSql } from '../engine/duckdbEngine';
import { SQL_PRESETS } from '../engine/sqlPresets';

describe('Query Plan EXPLAIN Parser & Arrow IPC Breakdown', () => {
  const ds = generateColumnarTransactions(10_000, 909);

  it('parses real DuckDB EXPLAIN physical tree into leaf-to-root pipeline stages', () => {
    const res = runFallbackSql(SQL_PRESETS[1].sql, ds, new Map());
    const sampleExplain = [
      '┌───────────────────────────┐',
      '│           TOP_N           │',
      '├───────────────────────────┤',
      '│       HASH_GROUP_BY       │',
      '├───────────────────────────┤',
      '│          FILTER           │',
      '├───────────────────────────┤',
      '│         SEQ_SCAN          │',
      '└───────────────────────────┘',
    ].join('\n');

    const analysis = buildQueryPlanAnalysis(res, sampleExplain);
    expect(analysis).not.toBeNull();
    expect(analysis!.source).toBe('DUCKDB_EXPLAIN');
    expect(analysis!.stages.map((s) => s.operator)).toEqual([
      'ARROW_SCAN',
      'FILTER',
      'HASH_AGG',
      'TOP_N',
    ]);

    const totalShare = analysis!.stages.reduce((acc, s) => acc + s.sharePct, 0);
    expect(totalShare).toBeGreaterThan(99);
    expect(totalShare).toBeLessThanOrEqual(101);
  });

  it('synthesizes vectorized stages cleanly when EXPLAIN text is unavailable', () => {
    const rollingPreset = SQL_PRESETS.find((p) => p.id === 'rolling-24h-moving-avg')!;
    const res = runFallbackSql(rollingPreset.sql, ds, new Map());
    const analysis = buildQueryPlanAnalysis(res, null);

    expect(analysis).not.toBeNull();
    expect(analysis!.source).toBe('VECTORIZED_ANALYZER');
    const ops = analysis!.stages.map((s) => s.operator);
    expect(ops).toContain('ARROW_SCAN');
    expect(ops).toContain('HASH_AGG');
    expect(ops).toContain('WINDOW');
    expect(ops).toContain('TOP_N');
  });

  it('computes accurate Arrow IPC columnar memory layout for 100K rows', () => {
    const breakdown = computeArrowBufferBreakdown(100_000);
    expect(breakdown.totalBytes).toBeGreaterThan(9_000_000);
    expect(breakdown.buffers.length).toBe(12);
    expect(breakdown.buffers[0].bytes).toBeGreaterThanOrEqual(breakdown.buffers[1].bytes);
    expect(formatByteSize(breakdown.totalBytes)).toContain('MB');
  });
});
