import { SQL_PRESETS } from './sqlPresets';
import type { QueryHistoryEntry, QueryHistorySource } from '../types/lakehouse';

export function summarizeSqlLabel(sql: string, source: QueryHistorySource = 'manual'): string {
  const normalized = sql.trim();

  const matchingPreset = SQL_PRESETS.find((p) => p.sql.trim() === normalized);
  if (matchingPreset) {
    return matchingPreset.label;
  }

  if (source === 'brush' || /Brush-to-SQL/i.test(normalized)) {
    const amtMatch = normalized.match(/amount_usd\s+BETWEEN\s+([\d.]+)\s+AND\s+([\d.]+)/i);
    if (amtMatch) {
      return `Brush Cluster ($${Number(amtMatch[1]).toFixed(0)}-$${Number(amtMatch[2]).toFixed(0)})`;
    }
    return 'Brush Cluster Filter';
  }

  const groupMatch = normalized.match(/\bGROUP\s+BY\s+([a-zA-Z0-9_,\s]+)/i);
  if (groupMatch) {
    const cols = groupMatch[1].trim().split(/\s+/).slice(0, 3).join(' ');
    return `Rollup · GROUP BY ${cols}`;
  }

  const fromMatch = normalized.match(/\bFROM\s+"?([a-zA-Z0-9_]+)"?/i);
  if (fromMatch && fromMatch[1].toLowerCase() !== 'transactions') {
    return `Inspect ${fromMatch[1]}`;
  }

  const singleLine = normalized
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return singleLine.length > 42 ? `${singleLine.slice(0, 42)}...` : singleLine || 'SQL Query';
}

export function sortHistoryEntries(entries: QueryHistoryEntry[]): QueryHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.executedAt.localeCompare(a.executedAt);
  });
}

export function recordQueryHistory(
  current: QueryHistoryEntry[],
  incoming: Omit<QueryHistoryEntry, 'id' | 'label' | 'pinned'>,
  maxUnpinned = 25,
): QueryHistoryEntry[] {
  const trimmedSql = incoming.sql.trim();
  if (!trimmedSql) return current;

  const existingIdx = current.findIndex((item) => item.sql.trim() === trimmedSql);
  if (existingIdx >= 0) {
    const existing = current[existingIdx];
    const updated: QueryHistoryEntry = {
      ...existing,
      executedAt: incoming.executedAt,
      executionMs: incoming.executionMs,
      rowCount: incoming.rowCount,
      scannedRows: incoming.scannedRows,
      engine: incoming.engine,
      source: incoming.source,
      error: incoming.error,
    };
    const next = [...current];
    next[existingIdx] = updated;
    return sortHistoryEntries(next);
  }

  const created: QueryHistoryEntry = {
    ...incoming,
    id: `qh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: summarizeSqlLabel(trimmedSql, incoming.source),
    pinned: false,
  };

  const combined = [created, ...current];
  const pinned = combined.filter((e) => e.pinned);
  const unpinned = combined.filter((e) => !e.pinned).slice(0, maxUnpinned);
  return sortHistoryEntries([...pinned, ...unpinned]);
}

export function togglePinHistoryEntry(
  current: QueryHistoryEntry[],
  id: string,
): QueryHistoryEntry[] {
  const next = current.map((item) =>
    item.id === id ? { ...item, pinned: !item.pinned } : item,
  );
  return sortHistoryEntries(next);
}
