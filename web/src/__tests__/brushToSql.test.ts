import { describe, expect, it } from 'vitest';
import {
  buildBrushSql,
  evaluateBrushedCluster,
  scatterToCanvasUv,
  screenRectToBrushBounds,
} from '../engine/brushToSql';
import { generateColumnarTransactions } from '../engine/dataGenerator';
import { runFallbackSql } from '../engine/duckdbEngine';
import type { GpuFilterState } from '../types/lakehouse';

const DEFAULT_FILTER: GpuFilterState = {
  riskThreshold: 0,
  regionMask: 0b11111,
  timeWindowPct: 100,
  yAxisMode: 'risk_score',
  pointSize: 3,
};

describe('Brush-to-SQL Lasso Selection Engine', () => {
  const ds = generateColumnarTransactions(20_000, 20261126);

  it('round-trips scatter coordinates to canvas UV and inverts into domain bounds', () => {
    const topLeft = scatterToCanvasUv(0.55, 0.96);
    const botRight = scatterToCanvasUv(0.92, 0.76);
    const bounds = screenRectToBrushBounds(
      topLeft.u,
      topLeft.v,
      botRight.u,
      botRight.v,
      DEFAULT_FILTER,
    );

    expect(bounds.minAmountUsd).toBeGreaterThan(100);
    expect(bounds.maxAmountUsd).toBeGreaterThan(bounds.minAmountUsd);
    expect(bounds.minRiskScore).toBeCloseTo(0.76, 2);
    expect(bounds.maxRiskScore).toBeCloseTo(0.96, 2);
    expect(bounds.activeRegions.length).toBe(5);
  });

  it('evaluates brushed high-risk anomaly cluster metrics accurately', () => {
    const topLeft = scatterToCanvasUv(0.45, 0.99);
    const botRight = scatterToCanvasUv(0.98, 0.75);
    const bounds = screenRectToBrushBounds(
      topLeft.u,
      topLeft.v,
      botRight.u,
      botRight.v,
      DEFAULT_FILTER,
    );
    const metrics = evaluateBrushedCluster(ds, bounds, DEFAULT_FILTER);

    expect(metrics.selectedPoints).toBeGreaterThan(200);
    expect(metrics.totalVisiblePoints).toBe(20_000);
    expect(metrics.avgAmountUsd).toBeGreaterThan(100);
    expect(metrics.anomalyRatePct).toBeGreaterThan(95);
    expect(metrics.avgRiskScore).toBeGreaterThan(0.75);
  });

  it('generates executable DuckDB BETWEEN SQL that returns only in-bounds cluster rows', () => {
    const regionSubsetFilter: GpuFilterState = {
      ...DEFAULT_FILTER,
      regionMask: 0b00011, // APAC-VN + APAC-SG
    };
    const bounds = screenRectToBrushBounds(0.5, 0.04, 0.96, 0.28, regionSubsetFilter);
    const sql = buildBrushSql(bounds, { limit: 100 });

    expect(sql).toContain('amount_usd BETWEEN');
    expect(sql).toContain('risk_score BETWEEN');
    expect(sql).toContain("region IN ('APAC-VN', 'APAC-SG')");

    const res = runFallbackSql(sql, ds, new Map());
    expect(res.error).toBeUndefined();
    expect(res.rowCount).toBeGreaterThan(0);

    for (const row of res.rows) {
      const amt = Number(row.amount_usd);
      const risk = Number(row.risk_score);
      expect(amt).toBeGreaterThanOrEqual(bounds.minAmountUsd - 0.02);
      expect(amt).toBeLessThanOrEqual(bounds.maxAmountUsd + 0.02);
      expect(risk).toBeGreaterThanOrEqual(bounds.minRiskScore - 0.001);
      expect(risk).toBeLessThanOrEqual(bounds.maxRiskScore + 0.001);
      expect(['APAC-VN', 'APAC-SG']).toContain(row.region);
    }
  });
});
