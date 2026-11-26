import { describe, expect, it } from 'vitest';
import { extractAutoChart, formatChartMetricValue } from '../engine/autoChart';
import { generateColumnarTransactions } from '../engine/dataGenerator';
import { runFallbackSql } from '../engine/duckdbEngine';
import { SQL_PRESETS } from '../engine/sqlPresets';

describe('Auto-Chart Series Extraction Engine', () => {
  const ds = generateColumnarTransactions(10_000, 404);

  it('extracts a bar chart model for categorical regional rollup and supports metric override', () => {
    const res = runFallbackSql(SQL_PRESETS[0].sql, ds, new Map());
    const model = extractAutoChart(res);

    expect(model).not.toBeNull();
    expect(model!.recommendedType).toBe('bar');
    expect(model!.labelColumn).toBe('region');
    expect(model!.metricColumn).toBe('gross_volume_usd');
    expect(model!.points.length).toBe(5);
    expect(model!.summary.sum).toBeGreaterThan(0);

    const switched = extractAutoChart(res, 'anomaly_rate_pct');
    expect(switched!.metricColumn).toBe('anomaly_rate_pct');
    expect(switched!.summary.max).toBeLessThan(100);
  });

  it('recommends area trend in chronological order with secondary moving-average overlay', () => {
    const rollingPreset = SQL_PRESETS.find((p) => p.id === 'rolling-24h-moving-avg')!;
    const res = runFallbackSql(rollingPreset.sql, ds, new Map());
    const model = extractAutoChart(res);

    expect(model).not.toBeNull();
    expect(model!.recommendedType).toBe('area');
    expect(model!.labelColumn).toBe('hour_utc');
    expect(model!.secondaryMetricColumn).toBe('rolling_24h_avg_usd');
    // Chronological ascending order left-to-right
    expect(model!.points[0].label < model!.points[model!.points.length - 1].label).toBe(true);
    expect(model!.points[0].secondaryValue).toBeDefined();
  });

  it('returns null on empty/errored results and formats metric labels cleanly', () => {
    expect(extractAutoChart(null)).toBeNull();
    expect(
      extractAutoChart({
        columns: [],
        rows: [],
        rowCount: 0,
        scannedRows: 0,
        executionMs: 1,
        rowsPerSec: 0,
        engine: 'FALLBACK-OLAP',
        sql: 'SELECT 1',
        error: 'syntax error',
      }),
    ).toBeNull();

    expect(formatChartMetricValue('gross_volume_usd', 2_450_000)).toBe('$2.45M');
    expect(formatChartMetricValue('anomaly_rate_pct', 4.48)).toBe('4.48%');
    expect(formatChartMetricValue('p99_ms', 312.4)).toBe('312.4ms');
    expect(formatChartMetricValue('avg_risk_score', 0.8123)).toBe('0.8123');
  });
});
