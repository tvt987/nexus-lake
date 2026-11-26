import type { QueryExecutionResult, TransactionRow } from './types.js';

const REGIONS: TransactionRow['region'][] = [
  'APAC-VN',
  'APAC-SG',
  'NA-WEST',
  'NA-EAST',
  'EU-CENTRAL',
];

const CATEGORIES: TransactionRow['category'][] = [
  'RETAIL_POS',
  'VOUCHER_REDEEM',
  'FLASH_SALE',
  'SUBSCRIPTION',
  'B2B_SETTLEMENT',
];

const VOUCHERS = ['VIP-TET-50', 'FLASH-99', 'LOYALTY-20', 'PARTNER-X', 'CORP-Q4'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class InMemoryLakehouseEngine {
  private readonly rows: TransactionRow[];

  constructor(rowCount = 5000, seed = 20261126) {
    this.rows = this.generateTransactions(rowCount, seed);
  }

  private generateTransactions(count: number, seed: number): TransactionRow[] {
    const rand = mulberry32(seed);
    const baseMs = Date.parse('2026-11-26T00:00:00.000Z');
    const out: TransactionRow[] = new Array(count);

    for (let i = 0; i < count; i += 1) {
      const region = REGIONS[Math.floor(rand() * REGIONS.length)];
      const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)];
      const storeNum = 100 + Math.floor(rand() * 720);
      const isBurst = rand() < 0.042;

      const amount = isBurst
        ? Number((850 + rand() * 4150).toFixed(2))
        : Number((12 + Math.pow(rand(), 2.2) * 640).toFixed(2));

      const riskScore = isBurst
        ? Number((0.76 + rand() * 0.23).toFixed(4))
        : Number((0.02 + Math.pow(rand(), 2.5) * 0.58).toFixed(4));

      const latencyMs = isBurst
        ? Math.round(140 + rand() * 680)
        : Math.round(8 + Math.pow(rand(), 2) * 95);

      const voucherCode =
        category === 'VOUCHER_REDEEM' || rand() < 0.24
          ? VOUCHERS[Math.floor(rand() * VOUCHERS.length)]
          : null;

      const offsetSec = Math.floor(rand() * 86400 * 7);
      const ts = new Date(baseMs - offsetSec * 1000).toISOString();

      out[i] = {
        tx_id: `TX-${String(i + 1).padStart(7, '0')}`,
        ts,
        store_id: `STR-${storeNum}`,
        region,
        category,
        amount_usd: amount,
        risk_score: riskScore,
        latency_ms: latencyMs,
        voucher_code: voucherCode,
        is_anomaly: riskScore >= 0.75,
      };
    }
    return out;
  }

  public getRowCount(): number {
    return this.rows.length;
  }

  public getSchema() {
    return {
      database: 'nexus_lakehouse',
      tables: [
        {
          name: 'transactions',
          rowCount: this.rows.length,
          engine: 'columnar-memory',
          columns: [
            { name: 'tx_id', type: 'VARCHAR', nullable: false },
            { name: 'ts', type: 'TIMESTAMP', nullable: false },
            { name: 'store_id', type: 'VARCHAR', nullable: false },
            { name: 'region', type: 'VARCHAR', nullable: false },
            { name: 'category', type: 'VARCHAR', nullable: false },
            { name: 'amount_usd', type: 'DOUBLE', nullable: false },
            { name: 'risk_score', type: 'DOUBLE', nullable: false },
            { name: 'latency_ms', type: 'INTEGER', nullable: false },
            { name: 'voucher_code', type: 'VARCHAR', nullable: true },
            { name: 'is_anomaly', type: 'BOOLEAN', nullable: false },
          ],
        },
      ],
    };
  }

  public getSummaryMetrics() {
    let totalVolume = 0;
    let anomalyCount = 0;
    const latencies: number[] = [];

    for (const r of this.rows) {
      totalVolume += r.amount_usd;
      if (r.is_anomaly) anomalyCount += 1;
      latencies.push(r.latency_ms);
    }
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
    const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;

    return {
      rowCount: this.rows.length,
      totalVolumeUsd: Number(totalVolume.toFixed(2)),
      anomalyCount,
      anomalyRatePct: Number(((anomalyCount / Math.max(1, this.rows.length)) * 100).toFixed(2)),
      p50LatencyMs: p50,
      p99LatencyMs: p99,
    };
  }

  public detectAnomalies(options: {
    riskThreshold: number;
    region?: string;
    limit: number;
  }) {
    const start = performance.now();
    const filtered = this.rows.filter((r) => {
      if (r.risk_score < options.riskThreshold) return false;
      if (options.region && r.region !== options.region) return false;
      return true;
    });

    filtered.sort((a, b) => b.risk_score - a.risk_score);

    const byRegion = new Map<string, { count: number; volumeUsd: number; avgRisk: number }>();
    for (const r of filtered) {
      const entry = byRegion.get(r.region) ?? { count: 0, volumeUsd: 0, avgRisk: 0 };
      entry.count += 1;
      entry.volumeUsd += r.amount_usd;
      entry.avgRisk += r.risk_score;
      byRegion.set(r.region, entry);
    }

    const regionBreakdown = [...byRegion.entries()].map(([region, stats]) => ({
      region,
      anomalyCount: stats.count,
      volumeUsd: Number(stats.volumeUsd.toFixed(2)),
      avgRiskScore: Number((stats.avgRisk / stats.count).toFixed(4)),
    }));

    return {
      threshold: options.riskThreshold,
      regionFilter: options.region ?? 'ALL',
      matchedAnomalies: filtered.length,
      scannedRows: this.rows.length,
      executionMs: Number((performance.now() - start).toFixed(2)),
      regionBreakdown,
      topAnomalies: filtered.slice(0, options.limit),
    };
  }

  /**
   * Executes validated read-only SQL queries against the in-memory transactions dataset.
   * Handles SHOW TABLES, DESCRIBE, WHERE predicates, GROUP BY aggregations, ORDER BY, and LIMIT.
   */
  public executeReadOnlySql(normalizedSql: string, maxRows = 200): QueryExecutionResult {
    const start = performance.now();
    const upper = normalizedSql.toUpperCase().trim();

    if (upper.startsWith('SHOW TABLES')) {
      return {
        columns: ['table_name', 'row_count', 'engine'],
        rows: [{ table_name: 'transactions', row_count: this.rows.length, engine: 'nexus-olap' }],
        rowCount: 1,
        scannedRows: 0,
        executionMs: Number((performance.now() - start).toFixed(2)),
      };
    }

    if (upper.startsWith('DESCRIBE')) {
      const cols = this.getSchema().tables[0].columns;
      return {
        columns: ['column_name', 'data_type', 'nullable'],
        rows: cols.map((c) => ({
          column_name: c.name,
          data_type: c.type,
          nullable: c.nullable ? 'YES' : 'NO',
        })),
        rowCount: cols.length,
        scannedRows: 0,
        executionMs: Number((performance.now() - start).toFixed(2)),
      };
    }

    // Apply WHERE filters if present
    let filtered = this.rows;
    const whereMatch = normalizedSql.match(
      /\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i,
    );
    if (whereMatch) {
      const clause = whereMatch[1].trim();
      filtered = this.applyWhereClause(filtered, clause);
    }

    // Check LIMIT
    const limitMatch = normalizedSql.match(/\bLIMIT\s+(\d+)/i);
    const limit = Math.min(maxRows, limitMatch ? Number(limitMatch[1]) : maxRows);

    // Check GROUP BY
    const groupMatch = normalizedSql.match(
      /\bGROUP\s+BY\s+([a-zA-Z0-9_,\s]+?)(?:\bORDER\s+BY\b|\bLIMIT\b|$)/i,
    );
    if (groupMatch) {
      const groupCol = groupMatch[1].trim().split(',')[0].trim().toLowerCase() as keyof TransactionRow;
      const groups = new Map<string, TransactionRow[]>();
      for (const row of filtered) {
        const key = String(row[groupCol] ?? 'NULL');
        const list = groups.get(key);
        if (list) list.push(row);
        else groups.set(key, [row]);
      }

      const aggregated: Record<string, unknown>[] = [];
      for (const [key, list] of groups.entries()) {
        const totalAmt = list.reduce((s, r) => s + r.amount_usd, 0);
        const avgRisk = list.reduce((s, r) => s + r.risk_score, 0) / list.length;
        const avgLat = list.reduce((s, r) => s + r.latency_ms, 0) / list.length;
        const anomalies = list.filter((r) => r.is_anomaly).length;
        aggregated.push({
          [groupCol]: key,
          tx_count: list.length,
          total_amount_usd: Number(totalAmt.toFixed(2)),
          avg_risk_score: Number(avgRisk.toFixed(4)),
          avg_latency_ms: Number(avgLat.toFixed(1)),
          anomaly_count: anomalies,
        });
      }

      aggregated.sort((a, b) => Number(b.total_amount_usd) - Number(a.total_amount_usd));
      const sliced = aggregated.slice(0, limit);
      return {
        columns: Object.keys(sliced[0] ?? { [groupCol]: null, tx_count: 0 }),
        rows: sliced,
        rowCount: sliced.length,
        scannedRows: this.rows.length,
        executionMs: Number((performance.now() - start).toFixed(2)),
      };
    }

    // Aggregate without GROUP BY (e.g., SELECT COUNT(*) FROM transactions)
    if (/\b(COUNT|SUM|AVG|MAX|MIN)\s*\(/i.test(normalizedSql) && !groupMatch) {
      const totalAmt = filtered.reduce((s, r) => s + r.amount_usd, 0);
      const avgRisk = filtered.length
        ? filtered.reduce((s, r) => s + r.risk_score, 0) / filtered.length
        : 0;
      const anomalies = filtered.filter((r) => r.is_anomaly).length;
      const row = {
        tx_count: filtered.length,
        total_amount_usd: Number(totalAmt.toFixed(2)),
        avg_risk_score: Number(avgRisk.toFixed(4)),
        anomaly_count: anomalies,
      };
      return {
        columns: Object.keys(row),
        rows: [row],
        rowCount: 1,
        scannedRows: this.rows.length,
        executionMs: Number((performance.now() - start).toFixed(2)),
      };
    }

    // ORDER BY support
    const orderMatch = normalizedSql.match(/\bORDER\s+BY\s+([a-zA-Z0-9_]+)(?:\s+(ASC|DESC))?/i);
    const resultRows = [...filtered];
    if (orderMatch) {
      const col = orderMatch[1].toLowerCase() as keyof TransactionRow;
      const dir = (orderMatch[2] ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
      resultRows.sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      });
    }

    const sliced = resultRows.slice(0, limit).map((r) => ({ ...r }));
    const columns =
      sliced.length > 0
        ? Object.keys(sliced[0])
        : ['tx_id', 'ts', 'store_id', 'region', 'category', 'amount_usd', 'risk_score', 'latency_ms'];

    return {
      columns,
      rows: sliced,
      rowCount: sliced.length,
      scannedRows: this.rows.length,
      executionMs: Number((performance.now() - start).toFixed(2)),
    };
  }

  private applyWhereClause(rows: TransactionRow[], clause: string): TransactionRow[] {
    const conditions = clause.split(/\s+AND\s+/i).map((c) => c.trim());
    return rows.filter((row) => {
      for (const cond of conditions) {
        const eqStr = cond.match(/^([a-z_]+)\s*=\s*'([^']+)'$/i);
        if (eqStr) {
          const col = eqStr[1].toLowerCase() as keyof TransactionRow;
          if (String(row[col]) !== eqStr[2]) return false;
          continue;
        }
        const eqBool = cond.match(/^([a-z_]+)\s*=\s*(true|false)$/i);
        if (eqBool) {
          const col = eqBool[1].toLowerCase() as keyof TransactionRow;
          if (Boolean(row[col]) !== (eqBool[2].toLowerCase() === 'true')) return false;
          continue;
        }
        const numCmp = cond.match(/^([a-z_]+)\s*(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?)$/i);
        if (numCmp) {
          const col = numCmp[1].toLowerCase() as keyof TransactionRow;
          const val = Number(row[col]);
          const target = Number(numCmp[3]);
          const op = numCmp[2];
          if (op === '>=' && !(val >= target)) return false;
          if (op === '<=' && !(val <= target)) return false;
          if (op === '>' && !(val > target)) return false;
          if (op === '<' && !(val < target)) return false;
          if (op === '=' && !(val === target)) return false;
        }
      }
      return true;
    });
  }
}
