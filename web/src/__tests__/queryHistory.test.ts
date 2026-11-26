import { describe, expect, it } from 'vitest';
import {
  recordQueryHistory,
  summarizeSqlLabel,
  togglePinHistoryEntry,
} from '../engine/queryHistory';
import { SQL_PRESETS } from '../engine/sqlPresets';
import type { QueryHistoryEntry } from '../types/lakehouse';

describe('SQL Query History & Pinning Manager', () => {
  it('auto-labels presets and Brush-to-SQL filters and deduplicates repeated queries', () => {
    expect(summarizeSqlLabel(SQL_PRESETS[0].sql, 'preset')).toBe('Regional Revenue Rollup');
    expect(
      summarizeSqlLabel(
        '-- Brush-to-SQL\nSELECT * FROM transactions WHERE amount_usd BETWEEN 250.00 AND 1850.50;',
        'brush',
      ),
    ).toBe('Brush Cluster ($250-$1851)');

    let history: QueryHistoryEntry[] = [];
    history = recordQueryHistory(history, {
      sql: SQL_PRESETS[0].sql,
      executedAt: '2026-11-26T10:00:00.000Z',
      executionMs: 22.4,
      rowCount: 5,
      scannedRows: 100_000,
      engine: 'DUCKDB-WASM',
      source: 'preset',
    });
    history = recordQueryHistory(history, {
      sql: SQL_PRESETS[0].sql,
      executedAt: '2026-11-26T10:01:00.000Z',
      executionMs: 11.2,
      rowCount: 5,
      scannedRows: 100_000,
      engine: 'DUCKDB-WASM',
      source: 'preset',
    });

    expect(history.length).toBe(1);
    expect(history[0].executionMs).toBe(11.2);
  });

  it('pins entries strictly to the top ahead of newer unpinned queries', () => {
    let history: QueryHistoryEntry[] = [];
    history = recordQueryHistory(history, {
      sql: 'SELECT * FROM transactions LIMIT 5;',
      executedAt: '2026-11-26T10:00:00.000Z',
      executionMs: 8.1,
      rowCount: 5,
      scannedRows: 100_000,
      engine: 'DUCKDB-WASM',
      source: 'manual',
    });
    const firstId = history[0].id;
    history = togglePinHistoryEntry(history, firstId);
    expect(history[0].pinned).toBe(true);

    history = recordQueryHistory(history, {
      sql: SQL_PRESETS[2].sql,
      executedAt: '2026-11-26T10:05:00.000Z',
      executionMs: 31.5,
      rowCount: 25,
      scannedRows: 100_000,
      engine: 'DUCKDB-WASM',
      source: 'preset',
    });

    expect(history.length).toBe(2);
    expect(history[0].id).toBe(firstId);
    expect(history[0].pinned).toBe(true);
    expect(history[1].pinned).toBe(false);
  });
});
