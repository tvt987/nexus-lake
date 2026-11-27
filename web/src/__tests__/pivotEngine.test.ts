import { describe, expect, it } from 'vitest';
import {
  classifyPivotColumns,
  computePivotMatrix,
  formatPivotValue,
  suggestPivotConfig,
} from '../engines/pivotEngine';
import type { SqlQueryResult } from '../types/lakehouse';

const SAMPLE_ROWS: Record<string, unknown>[] = [
  { region: 'APAC-VN', category: 'POS', revenue_vnd: 1_000_000, p99_ms: 42 },
  { region: 'APAC-VN', category: 'POS', revenue_vnd: 500_000, p99_ms: 58 },
  { region: 'APAC-VN', category: 'APP', revenue_vnd: 800_000, p99_ms: 30 },
  { region: 'NA-EAST', category: 'POS', revenue_vnd: 2_000_000, p99_ms: 95 },
  { region: 'NA-EAST', category: 'APP', revenue_vnd: 400_000, p99_ms: 60 },
];

describe('v3.0 Cross-Tab Visual Pivot Matrix Engine', () => {
  it('classifies categorical dimensions and numeric metric columns accurately', () => {
    const { dimensions, metrics } = classifyPivotColumns(
      ['region', 'category', 'revenue_vnd', 'p99_ms'],
      SAMPLE_ROWS,
    );
    expect(dimensions).toEqual(['region', 'category']);
    expect(metrics).toEqual(['revenue_vnd', 'p99_ms']);
  });

  it('suggests sensible default pivot config and returns null on empty/error results', () => {
    expect(suggestPivotConfig(null)).toBeNull();
    const res: SqlQueryResult = {
      columns: ['region', 'category', 'p99_ms'],
      rows: SAMPLE_ROWS,
      rowCount: SAMPLE_ROWS.length,
      scannedRows: 5,
      executionMs: 1.2,
      rowsPerSec: 1000,
      engine: 'DUCKDB-WASM',
      sql: 'SELECT 1',
    };
    const cfg = suggestPivotConfig(res);
    expect(cfg).toEqual({
      rowDim: 'region',
      colDim: 'category',
      metricCol: 'p99_ms',
      aggregation: 'MAX',
    });
  });

  it('computes exact SUM cross-tab matrix with row, column, and grand totals', () => {
    const mat = computePivotMatrix(SAMPLE_ROWS, {
      rowDim: 'region',
      colDim: 'category',
      metricCol: 'revenue_vnd',
      aggregation: 'SUM',
    });
    expect(mat.matrix['APAC-VN']['POS'].value).toBe(1_500_000);
    expect(mat.matrix['APAC-VN']['POS'].count).toBe(2);
    expect(mat.matrix['NA-EAST']['APP'].value).toBe(400_000);
    expect(mat.rowTotals['APAC-VN']).toBe(2_300_000);
    expect(mat.colTotals['POS']).toBe(3_500_000);
    expect(mat.grandTotal).toBe(4_700_000);
    expect(mat.minCellValue).toBe(400_000);
    expect(mat.maxCellValue).toBe(2_000_000);
  });

  it('computes exact AVG aggregation per cell and totals', () => {
    const mat = computePivotMatrix(SAMPLE_ROWS, {
      rowDim: 'region',
      colDim: 'category',
      metricCol: 'p99_ms',
      aggregation: 'AVG',
    });
    expect(mat.matrix['APAC-VN']['POS'].value).toBe(50);
    expect(mat.matrix['NA-EAST']['POS'].value).toBe(95);
    expect(mat.grandTotal).toBe(57);
  });

  it('computes exact COUNT aggregation per cell and totals', () => {
    const mat = computePivotMatrix(SAMPLE_ROWS, {
      rowDim: 'region',
      colDim: 'category',
      metricCol: 'revenue_vnd',
      aggregation: 'COUNT',
    });
    expect(mat.matrix['APAC-VN']['POS'].value).toBe(2);
    expect(mat.matrix['NA-EAST']['POS'].value).toBe(1);
    expect(mat.grandTotal).toBe(5);
  });

  it('computes exact MAX aggregation per cell and totals', () => {
    const mat = computePivotMatrix(SAMPLE_ROWS, {
      rowDim: 'region',
      colDim: 'category',
      metricCol: 'p99_ms',
      aggregation: 'MAX',
    });
    expect(mat.matrix['APAC-VN']['POS'].value).toBe(58);
    expect(mat.rowTotals['NA-EAST']).toBe(95);
    expect(mat.grandTotal).toBe(95);
  });

  it('handles sparse cells, null dimension keys, and caps wide column matrices cleanly', () => {
    const wideRows = Array.from({ length: 20 }, (_, i) => ({
      rowKey: i === 0 ? null : `R-${i % 3}`,
      colKey: `C-${i}`,
      val: (i + 1) * 10,
    }));
    const mat = computePivotMatrix(wideRows, {
      rowDim: 'rowKey',
      colDim: 'colKey',
      metricCol: 'val',
      aggregation: 'SUM',
    });
    expect(mat.colKeys.length).toBe(16);
    expect(mat.truncatedCols).toBe(4);
    expect(mat.rowKeys).toContain('NULL');
  });

  it('formats VND, USD, percentages, latency ms, and counts properly', () => {
    expect(formatPivotValue('revenue_vnd', 'SUM', 1_250_000_000)).toBe('1.25B ₫');
    expect(formatPivotValue('gross_volume_usd', 'SUM', 425_000)).toBe('$425.0K');
    expect(formatPivotValue('margin_pct', 'AVG', 31.45)).toBe('31.45%');
    expect(formatPivotValue('p99_ms', 'MAX', 124.6)).toBe('124.6ms');
    expect(formatPivotValue('revenue_vnd', 'COUNT', 1420)).toBe('1,420');
  });
});
