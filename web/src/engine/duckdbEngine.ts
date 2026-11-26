import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import ehWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import mvpWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

import {
  buildArrowIpcFromTransactions,
  CATEGORIES,
  REGIONS,
  VOUCHER_CODES,
} from './dataGenerator';
import type {
  ColumnarTransactions,
  EngineBackend,
  SqlQueryResult,
  TableSchemaInfo,
} from '../types/lakehouse';

const LOCAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: mvpWasmUrl,
    mainWorker: mvpWorkerUrl,
  },
  eh: {
    mainModule: ehWasmUrl,
    mainWorker: ehWorkerUrl,
  },
};

function normalizeCellValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') {
    const num = Number(val);
    return Number.isSafeInteger(num) ? num : val.toString();
  }
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint32Array || val instanceof Int32Array) {
    // DuckDB HUGEINT / DECIMAL128 low-word conversion for safe JS integers
    const num = Number(val[0]);
    return Number.isFinite(num) ? num : String(val[0]);
  }
  if (
    typeof val === 'object' &&
    'toJSON' in val &&
    typeof (val as { toJSON: () => unknown }).toJSON === 'function'
  ) {
    const inner = (val as { toJSON: () => unknown }).toJSON();
    return normalizeCellValue(inner);
  }
  if (typeof val === 'string') {
    const stripped = val.replace(/^"(.*)"$/, '$1');
    if (/^-?\d+(?:\.\d+)?$/.test(stripped) && stripped.length <= 15) {
      return Number(stripped);
    }
    return stripped;
  }
  return val;
}

function sanitizeTableName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').toLowerCase();
  const clean = base.replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '');
  if (!clean) return 'uploaded_table';
  return /^[0-9]/.test(clean) ? `t_${clean}` : clean;
}

function parseSimpleCsv(text: string): Record<string, unknown>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c += 1) {
      const raw = parts[c] ?? '';
      const num = Number(raw);
      obj[headers[c]] = raw !== '' && !Number.isNaN(num) ? num : raw;
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Pure TypeScript OLAP fallback engine when WebAssembly Workers are unavailable
 * (e.g., jsdom test environments or restricted browser contexts).
 */
export function runFallbackSql(
  sql: string,
  dataset: ColumnarTransactions,
  uploadedTables: Map<string, Record<string, unknown>[]>,
): SqlQueryResult {
  const start = performance.now();
  const clean = sql.trim().replace(/;\s*$/, '');
  const upper = clean.toUpperCase();

  // Check if querying an uploaded custom table
  const fromMatch = clean.match(/\bFROM\s+([a-zA-Z0-9_]+)/i);
  const tableName = fromMatch ? fromMatch[1].toLowerCase() : 'transactions';

  if (tableName !== 'transactions' && uploadedTables.has(tableName)) {
    const rows = uploadedTables.get(tableName) ?? [];
    const limitMatch = clean.match(/\bLIMIT\s+(\d+)/i);
    const limit = limitMatch ? Number(limitMatch[1]) : 200;
    const sliced = rows.slice(0, limit);
    const columns = sliced[0] ? Object.keys(sliced[0]) : [];
    const elapsed = Math.max(0.2, performance.now() - start);
    return {
      columns,
      rows: sliced,
      rowCount: sliced.length,
      scannedRows: rows.length,
      executionMs: Number(elapsed.toFixed(2)),
      rowsPerSec: Math.round((rows.length / elapsed) * 1000),
      engine: 'FALLBACK-OLAP',
      sql,
    };
  }

  const n = dataset.rowCount;

  // Regional revenue rollup / GROUP BY region
  if (upper.includes('GROUP BY REGION') && !upper.includes('CATEGORY')) {
    const stats = REGIONS.map((region) => ({
      region,
      tx_count: 0,
      gross_volume_usd: 0,
      risk_sum: 0,
      anomaly_count: 0,
    }));
    for (let i = 0; i < n; i += 1) {
      const r = stats[dataset.regionIdx[i]];
      r.tx_count += 1;
      r.gross_volume_usd += dataset.amountUsd[i];
      r.risk_sum += dataset.riskScore[i];
      r.anomaly_count += dataset.isAnomaly[i];
    }
    const rows = stats
      .map((s) => ({
        region: s.region,
        tx_count: s.tx_count,
        gross_volume_usd: Number(s.gross_volume_usd.toFixed(2)),
        avg_ticket_usd: Number((s.gross_volume_usd / Math.max(1, s.tx_count)).toFixed(2)),
        avg_risk_score: Number((s.risk_sum / Math.max(1, s.tx_count)).toFixed(4)),
        anomaly_count: s.anomaly_count,
        anomaly_rate_pct: Number(((s.anomaly_count / Math.max(1, s.tx_count)) * 100).toFixed(2)),
      }))
      .sort((a, b) => b.gross_volume_usd - a.gross_volume_usd);

    const elapsed = Math.max(0.2, performance.now() - start);
    return {
      columns: Object.keys(rows[0]),
      rows,
      rowCount: rows.length,
      scannedRows: n,
      executionMs: Number(elapsed.toFixed(2)),
      rowsPerSec: Math.round((n / elapsed) * 1000),
      engine: 'FALLBACK-OLAP',
      sql,
    };
  }

  // Voucher abuse detection
  if (upper.includes('GROUP BY VOUCHER_CODE')) {
    const map = new Map<
      string,
      { redemptions: number; stores: Set<number>; usd: number; risk: number; anomalies: number }
    >();
    for (let i = 0; i < n; i += 1) {
      const vIdx = dataset.voucherIdx[i];
      if (vIdx < 0) continue;
      const code = VOUCHER_CODES[vIdx];
      let agg = map.get(code);
      if (!agg) {
        agg = { redemptions: 0, stores: new Set<number>(), usd: 0, risk: 0, anomalies: 0 };
        map.set(code, agg);
      }
      agg.redemptions += 1;
      agg.stores.add(dataset.storeId[i]);
      agg.usd += dataset.amountUsd[i];
      agg.risk += dataset.riskScore[i];
      agg.anomalies += dataset.isAnomaly[i];
    }
    const rows = [...map.entries()]
      .map(([voucher_code, a]) => ({
        voucher_code,
        redemptions: a.redemptions,
        unique_stores: a.stores.size,
        redeemed_usd: Number(a.usd.toFixed(2)),
        mean_risk: Number((a.risk / a.redemptions).toFixed(4)),
        flagged_anomalies: a.anomalies,
      }))
      .sort((a, b) => b.flagged_anomalies - a.flagged_anomalies);
    const elapsed = Math.max(0.2, performance.now() - start);
    return {
      columns: Object.keys(rows[0] ?? {}),
      rows,
      rowCount: rows.length,
      scannedRows: n,
      executionMs: Number(elapsed.toFixed(2)),
      rowsPerSec: Math.round((n / elapsed) * 1000),
      engine: 'FALLBACK-OLAP',
      sql,
    };
  }

  // Fraud burst by store
  if (upper.includes('GROUP BY STORE_ID')) {
    const minRiskMatch = clean.match(/risk_score\s*>=\s*(\d+(?:\.\d+)?)/i);
    const minRisk = minRiskMatch ? Number(minRiskMatch[1]) : 0.8;
    const map = new Map<
      string,
      { store_id: string; region: string; count: number; usd: number; maxRisk: number; latSum: number }
    >();
    for (let i = 0; i < n; i += 1) {
      if (dataset.riskScore[i] < minRisk) continue;
      const store = `STR-${dataset.storeId[i]}`;
      const region = REGIONS[dataset.regionIdx[i]];
      const key = `${store}|${region}`;
      let agg = map.get(key);
      if (!agg) {
        agg = { store_id: store, region, count: 0, usd: 0, maxRisk: 0, latSum: 0 };
        map.set(key, agg);
      }
      agg.count += 1;
      agg.usd += dataset.amountUsd[i];
      if (dataset.riskScore[i] > agg.maxRisk) agg.maxRisk = dataset.riskScore[i];
      agg.latSum += dataset.latencyMs[i];
    }
    const rows = [...map.values()]
      .map((a) => ({
        store_id: a.store_id,
        region: a.region,
        burst_txs: a.count,
        exposed_usd: Number(a.usd.toFixed(2)),
        peak_risk: Number(a.maxRisk.toFixed(4)),
        avg_latency_ms: Number((a.latSum / a.count).toFixed(1)),
      }))
      .sort((a, b) => b.exposed_usd - a.exposed_usd)
      .slice(0, 40);
    const elapsed = Math.max(0.2, performance.now() - start);
    return {
      columns: Object.keys(rows[0] ?? {}),
      rows,
      rowCount: rows.length,
      scannedRows: n,
      executionMs: Number(elapsed.toFixed(2)),
      rowsPerSec: Math.round((n / elapsed) * 1000),
      engine: 'FALLBACK-OLAP',
      sql,
    };
  }

  // P99 Latency percentiles by region & category
  if (upper.includes('QUANTILE_CONT') || upper.includes('GROUP BY REGION, CATEGORY')) {
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < n; i += 1) {
      const key = `${REGIONS[dataset.regionIdx[i]]}|${CATEGORIES[dataset.categoryIdx[i]]}`;
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push(dataset.latencyMs[i]);
    }
    const rows = [...buckets.entries()]
      .map(([key, arr]) => {
        arr.sort((a, b) => a - b);
        const [region, category] = key.split('|');
        return {
          region,
          category,
          sample_size: arr.length,
          p50_ms: arr[Math.floor(arr.length * 0.5)] ?? 0,
          p95_ms: arr[Math.floor(arr.length * 0.95)] ?? 0,
          p99_ms: arr[Math.floor(arr.length * 0.99)] ?? 0,
        };
      })
      .sort((a, b) => b.p99_ms - a.p99_ms)
      .slice(0, 25);
    const elapsed = Math.max(0.2, performance.now() - start);
    return {
      columns: Object.keys(rows[0] ?? {}),
      rows,
      rowCount: rows.length,
      scannedRows: n,
      executionMs: Number(elapsed.toFixed(2)),
      rowsPerSec: Math.round((n / elapsed) * 1000),
      engine: 'FALLBACK-OLAP',
      sql,
    };
  }

  // Rolling 24h moving average
  if (upper.includes('DATE_TRUNC') || upper.includes('ROLLING_24H')) {
    const hourly = new Map<number, { tx_count: number; usd: number; anomalies: number }>();
    for (let i = 0; i < n; i += 1) {
      const hourKey = Math.floor(dataset.tsMs[i] / 3600000) * 3600000;
      let agg = hourly.get(hourKey);
      if (!agg) {
        agg = { tx_count: 0, usd: 0, anomalies: 0 };
        hourly.set(hourKey, agg);
      }
      agg.tx_count += 1;
      agg.usd += dataset.amountUsd[i];
      agg.anomalies += dataset.isAnomaly[i];
    }
    const sorted = [...hourly.entries()].sort((a, b) => a[0] - b[0]);
    const rows = sorted.map(([hourMs, agg], idx) => {
      const winStart = Math.max(0, idx - 23);
      let winSum = 0;
      for (let j = winStart; j <= idx; j += 1) winSum += sorted[j][1].usd;
      const dt = new Date(hourMs).toISOString().slice(0, 13).replace('T', ' ') + ':00';
      return {
        hour_utc: dt,
        tx_count: agg.tx_count,
        hourly_usd: Number(agg.usd.toFixed(2)),
        anomalies: agg.anomalies,
        rolling_24h_avg_usd: Number((winSum / (idx - winStart + 1)).toFixed(2)),
      };
    });
    const out = rows.reverse().slice(0, 48);
    const elapsed = Math.max(0.2, performance.now() - start);
    return {
      columns: Object.keys(out[0] ?? {}),
      rows: out,
      rowCount: out.length,
      scannedRows: n,
      executionMs: Number(elapsed.toFixed(2)),
      rowsPerSec: Math.round((n / elapsed) * 1000),
      engine: 'FALLBACK-OLAP',
      sql,
    };
  }

  // Default row-level scan with WHERE filters + ORDER BY + LIMIT
  const onlyAnomaly = /is_anomaly\s*=\s*true/i.test(clean);
  const regionMatch = clean.match(/region\s*=\s*'([^']+)'/i);
  const riskMatch = clean.match(/risk_score\s*>=\s*(\d+(?:\.\d+)?)/i);
  const limitMatch = clean.match(/\bLIMIT\s+(\d+)/i);
  const limit = Math.min(500, limitMatch ? Number(limitMatch[1]) : 150);
  const minRisk = riskMatch ? Number(riskMatch[1]) : -1;

  const matchedIndices: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (onlyAnomaly && dataset.isAnomaly[i] !== 1) continue;
    if (regionMatch && REGIONS[dataset.regionIdx[i]] !== regionMatch[1]) continue;
    if (minRisk >= 0 && dataset.riskScore[i] < minRisk) continue;
    matchedIndices.push(i);
  }

  if (upper.includes('ORDER BY RISK_SCORE DESC')) {
    matchedIndices.sort((a, b) => dataset.riskScore[b] - dataset.riskScore[a]);
  } else if (upper.includes('ORDER BY AMOUNT_USD DESC')) {
    matchedIndices.sort((a, b) => dataset.amountUsd[b] - dataset.amountUsd[a]);
  }

  const rows = matchedIndices.slice(0, limit).map((i) => ({
    tx_id: dataset.txId[i],
    timestamp_utc: new Date(dataset.tsMs[i]).toISOString().replace('T', ' ').slice(0, 19),
    store_id: `STR-${dataset.storeId[i]}`,
    region: REGIONS[dataset.regionIdx[i]],
    category: CATEGORIES[dataset.categoryIdx[i]],
    amount_usd: Number(dataset.amountUsd[i].toFixed(2)),
    risk_score: Number(dataset.riskScore[i].toFixed(4)),
    latency_ms: dataset.latencyMs[i],
    voucher_code: dataset.voucherIdx[i] >= 0 ? VOUCHER_CODES[dataset.voucherIdx[i]] : 'NONE',
  }));

  const elapsed = Math.max(0.2, performance.now() - start);
  return {
    columns: Object.keys(rows[0] ?? { tx_id: '', region: '', amount_usd: 0 }),
    rows,
    rowCount: rows.length,
    scannedRows: n,
    executionMs: Number(elapsed.toFixed(2)),
    rowsPerSec: Math.round((n / elapsed) * 1000),
    engine: 'FALLBACK-OLAP',
    sql,
  };
}

export class NexusDuckDbEngine {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;
  private worker: Worker | null = null;
  private backend: EngineBackend = 'FALLBACK-OLAP';
  private dataset: ColumnarTransactions | null = null;
  private uploadedTables = new Map<string, Record<string, unknown>[]>();
  private tables: TableSchemaInfo[] = [];

  public getBackend(): EngineBackend {
    return this.backend;
  }

  public getTables(): TableSchemaInfo[] {
    return [...this.tables];
  }

  public async initialize(initialDataset: ColumnarTransactions): Promise<{
    backend: EngineBackend;
    loadMs: number;
  }> {
    this.dataset = initialDataset;
    const start = performance.now();

    try {
      if (typeof Worker === 'undefined') {
        throw new Error('Web Worker API unavailable in current runtime');
      }

      const bundle = await duckdb.selectBundle(LOCAL_BUNDLES);
      if (!bundle.mainWorker || !bundle.mainModule) {
        throw new Error('DuckDB-WASM local bundle resolution returned empty URLs');
      }

      const worker = new Worker(bundle.mainWorker);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      const conn = await db.connect();

      this.worker = worker;
      this.db = db;
      this.conn = conn;
      this.backend = 'DUCKDB-WASM';

      await this.loadTransactions(initialDataset);
      return {
        backend: this.backend,
        loadMs: Number((performance.now() - start).toFixed(1)),
      };
    } catch (err) {
      console.warn('[NexusLake] DuckDB-WASM worker unavailable, switching to FALLBACK-OLAP:', err);
      this.backend = 'FALLBACK-OLAP';
      this.syncSyntheticSchema(initialDataset.rowCount);
      return {
        backend: this.backend,
        loadMs: Number((performance.now() - start).toFixed(1)),
      };
    }
  }

  private syncSyntheticSchema(rowCount: number): void {
    const baseTable: TableSchemaInfo = {
      name: 'transactions',
      rowCount,
      source: 'synthetic',
      columns: [
        { name: 'tx_id', type: 'VARCHAR' },
        { name: 'ts', type: 'TIMESTAMP' },
        { name: 'store_id', type: 'VARCHAR' },
        { name: 'region', type: 'VARCHAR' },
        { name: 'category', type: 'VARCHAR' },
        { name: 'amount_usd', type: 'FLOAT' },
        { name: 'risk_score', type: 'FLOAT' },
        { name: 'latency_ms', type: 'INTEGER' },
        { name: 'voucher_code', type: 'VARCHAR' },
        { name: 'is_anomaly', type: 'BOOLEAN' },
        { name: 'x_coord', type: 'FLOAT' },
        { name: 'y_coord', type: 'FLOAT' },
      ],
    };
    this.tables = [baseTable, ...this.tables.filter((t) => t.name !== 'transactions')];
  }

  public async loadTransactions(data: ColumnarTransactions): Promise<number> {
    const start = performance.now();
    this.dataset = data;

    if (this.backend === 'DUCKDB-WASM' && this.conn) {
      const ipcBytes = buildArrowIpcFromTransactions(data);
      await this.conn.query('DROP TABLE IF EXISTS transactions_raw; DROP TABLE IF EXISTS transactions;');
      await this.conn.insertArrowFromIPCStream(ipcBytes, {
        name: 'transactions_raw',
        create: true,
      });
      await this.conn.query(`
        CREATE TABLE transactions AS
        SELECT
          tx_id,
          CAST(ts AS TIMESTAMP) AS ts,
          store_id,
          region,
          category,
          CAST(amount_usd AS DOUBLE) AS amount_usd,
          CAST(risk_score AS DOUBLE) AS risk_score,
          latency_ms,
          voucher_code,
          is_anomaly,
          x_coord,
          y_coord
        FROM transactions_raw;
        DROP TABLE transactions_raw;
      `);
    }

    this.syncSyntheticSchema(data.rowCount);
    return Number((performance.now() - start).toFixed(1));
  }

  public async ingestFile(fileName: string, content: string): Promise<TableSchemaInfo> {
    const tableName = sanitizeTableName(fileName);
    const isJson = fileName.toLowerCase().endsWith('.json');

    if (this.backend === 'DUCKDB-WASM' && this.db && this.conn) {
      const virtualPath = `upload_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await this.db.registerFileText(virtualPath, content);
      if (isJson) {
        await this.conn.query(
          `CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${virtualPath}');`,
        );
      } else {
        await this.conn.query(
          `CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_csv_auto('${virtualPath}');`,
        );
      }

      const countRes = await this.conn.query(`SELECT COUNT(*) AS cnt FROM "${tableName}"`);
      const rowCount = Number(countRes.toArray()[0]?.cnt ?? 0);
      const descRes = await this.conn.query(`DESCRIBE "${tableName}"`);
      const columns = descRes.toArray().map((row) => {
        const r = row.toJSON() as Record<string, unknown>;
        return {
          name: String(r.column_name ?? ''),
          type: String(r.column_type ?? 'VARCHAR'),
        };
      });

      const info: TableSchemaInfo = {
        name: tableName,
        rowCount,
        source: 'uploaded',
        columns,
      };
      this.tables = [...this.tables.filter((t) => t.name !== tableName), info];
      return info;
    }

    // Fallback in-memory CSV / JSON ingestion
    let rows: Record<string, unknown>[] = [];
    if (isJson) {
      const parsed = JSON.parse(content);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      rows = parseSimpleCsv(content);
    }
    this.uploadedTables.set(tableName, rows);
    const sample = rows[0] ?? {};
    const columns = Object.keys(sample).map((key) => ({
      name: key,
      type: typeof sample[key] === 'number' ? 'DOUBLE' : 'VARCHAR',
    }));
    const info: TableSchemaInfo = {
      name: tableName,
      rowCount: rows.length,
      source: 'uploaded',
      columns,
    };
    this.tables = [...this.tables.filter((t) => t.name !== tableName), info];
    return info;
  }

  public async executeSql(sql: string): Promise<SqlQueryResult> {
    const start = performance.now();
    const scannedRows = this.dataset?.rowCount ?? 0;

    if (this.backend === 'DUCKDB-WASM' && this.conn) {
      try {
        const arrowResult = await this.conn.query(sql);
        const columns = arrowResult.schema.fields.map((f) => f.name);
        const rawRows = arrowResult.toArray();
        const rows: Record<string, unknown>[] = rawRows.map((item) => {
          const jsonObj = item.toJSON() as Record<string, unknown>;
          const normalized: Record<string, unknown> = {};
          for (const col of columns) {
            normalized[col] = normalizeCellValue(jsonObj[col]);
          }
          return normalized;
        });
        const elapsed = Math.max(0.2, performance.now() - start);
        return {
          columns,
          rows,
          rowCount: rows.length,
          scannedRows,
          executionMs: Number(elapsed.toFixed(2)),
          rowsPerSec: Math.round((scannedRows / elapsed) * 1000),
          engine: 'DUCKDB-WASM',
          sql,
        };
      } catch (err) {
        const elapsed = Math.max(0.2, performance.now() - start);
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          scannedRows,
          executionMs: Number(elapsed.toFixed(2)),
          rowsPerSec: 0,
          engine: 'DUCKDB-WASM',
          sql,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (!this.dataset) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        scannedRows: 0,
        executionMs: 0,
        rowsPerSec: 0,
        engine: 'FALLBACK-OLAP',
        sql,
        error: 'Dataset not initialized.',
      };
    }

    return runFallbackSql(sql, this.dataset, this.uploadedTables);
  }

  public async dispose(): Promise<void> {
    try {
      await this.conn?.close();
      await this.db?.terminate();
      this.worker?.terminate();
    } catch {
      // ignore teardown issues
    }
    this.conn = null;
    this.db = null;
    this.worker = null;
  }
}
