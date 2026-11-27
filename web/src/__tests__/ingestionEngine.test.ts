import { describe, expect, it } from 'vitest';
import { generateColumnarTransactions } from '../engine/dataGenerator';
import { NexusDuckDbEngine } from '../engine/duckdbEngine';
import {
  buildArrowIpcFromRows,
  ENTERPRISE_SAMPLE_CATALOG,
  generateEnterpriseSampleDataset,
  inferColumnTypeFromValues,
  parseAndProfileFile,
  parseCsvRfc4180,
  parseJsonDataset,
  sanitizeTableName,
} from '../engines/ingestionEngine';

describe('v3.0 Local Ingestion, Schema Inference & Profiling Engine', () => {
  it('parses RFC-4180 CSV with UTF-8 BOM, quoted commas, escaped quotes, and multiline values', () => {
    const csv =
      '\uFEFF"product_name","city","revenue_vnd","notes"\r\n' +
      '"Aptamil Gold, 900g","Ho Chi Minh",685000,"Best ""VIP"" SKU"\r\n' +
      '"Meiji Formula","Ha Noi",545000,"Line 1\nLine 2"';

    const parsed = parseCsvRfc4180(csv);
    expect(parsed.headers).toEqual(['product_name', 'city', 'revenue_vnd', 'notes']);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0][0]).toBe('Aptamil Gold, 900g');
    expect(parsed.rows[0][3]).toBe('Best "VIP" SKU');
    expect(parsed.rows[1][3]).toContain('Line 1');
  });

  it('auto-detects semicolon-delimited CSV files', () => {
    const csv = 'sku;units;active\nSKU-01;12;true\nSKU-02;8;false';
    const parsed = parseCsvRfc4180(csv);
    expect(parsed.headers).toEqual(['sku', 'units', 'active']);
    expect(parsed.rows).toEqual([
      ['SKU-01', '12', 'true'],
      ['SKU-02', '8', 'false'],
    ]);
  });

  it('parses JSON arrays, wrapped objects ({ data }), and NDJSON streams', () => {
    const arr = parseJsonDataset('[{"id":"A1","val":10},{"id":"A2","val":20}]');
    expect(arr.length).toBe(2);

    const wrapped = parseJsonDataset('{"meta":"ok","data":[{"k":"x","n":5}]}');
    expect(wrapped).toEqual([{ k: 'x', n: 5 }]);

    const ndjson = parseJsonDataset('{"a":1}\n{"a":2}\n{"a":3}');
    expect(ndjson.length).toBe(3);
  });

  it('infers Numeric, Boolean, Date, and String types accurately while keeping leading-zero IDs as String', () => {
    expect(inferColumnTypeFromValues([10, 20.5, '30', null])).toBe('Numeric');
    expect(inferColumnTypeFromValues(['true', 'false', true, ''])).toBe('Boolean');
    expect(inferColumnTypeFromValues(['2026-01-15', '2026-02-28', '2026-03-01'])).toBe('Date');
    expect(inferColumnTypeFromValues(['00123', '00456', '00789'])).toBe('String');
    expect(inferColumnTypeFromValues(['HCMC', 'Ha Noi', 'Da Nang'])).toBe('String');
  });

  it('profiles uploaded CSV with exact null counts, cardinality, min, max, p50, and p95', () => {
    const lines = ['order_id,order_date,amount,is_vip,city'];
    for (let i = 1; i <= 20; i += 1) {
      const amt = i === 10 ? '' : String(i * 100);
      lines.push(`ORD-${i},2026-05-${String(i).padStart(2, '0')},${amt},${i % 2 === 0 ? 'true' : 'false'},${i % 3 === 0 ? 'Ha Noi' : 'Ho Chi Minh'}`);
    }
    const ingested = parseAndProfileFile('vn_sales_q2.csv', lines.join('\n'));

    expect(ingested.tableName).toBe('vn_sales_q2');
    expect(ingested.profile.rowCount).toBe(20);
    expect(ingested.profile.columnCount).toBe(5);

    const amtCol = ingested.profile.columns.find((c) => c.name === 'amount')!;
    expect(amtCol.inferredType).toBe('Numeric');
    expect(amtCol.nullCount).toBe(1);
    expect(amtCol.nullRatePct).toBe(5);
    expect(amtCol.cardinality).toBe(19);
    expect(amtCol.min).toBe(100);
    expect(amtCol.max).toBe(2000);
    expect(amtCol.p95).toBeGreaterThanOrEqual(1900);

    const dateCol = ingested.profile.columns.find((c) => c.name === 'order_date')!;
    expect(dateCol.inferredType).toBe('Date');

    const vipCol = ingested.profile.columns.find((c) => c.name === 'is_vip')!;
    expect(vipCol.inferredType).toBe('Boolean');
  });

  it('sanitizes arbitrary file names into safe SQL identifiers and rejects empty CSV', () => {
    expect(sanitizeTableName('2026 Q4 Sales (VN)!.csv')).toBe('t_2026_q4_sales_vn');
    expect(sanitizeTableName('...json')).toBe('uploaded_table');
    expect(() => parseAndProfileFile('empty.csv', 'col1,col2\n')).toThrow();
  });

  it('generates Vietnam Retail POS 50K Rows sample with Arrow IPC stream and full profile', () => {
    const sample = generateEnterpriseSampleDataset('vn_retail_pos_50k');
    expect(sample.tableName).toBe('vn_retail_pos_50k');
    expect(sample.rows.length).toBe(50_000);
    expect(sample.profile.rowCount).toBe(50_000);
    expect(sample.arrowIpcBytes).toBeDefined();
    expect(sample.arrowIpcBytes!.byteLength).toBeGreaterThan(100_000);

    const revCol = sample.profile.columns.find((c) => c.name === 'revenue_vnd')!;
    expect(revCol.inferredType).toBe('Numeric');
    expect(revCol.min).toBeGreaterThan(0);
    expect(revCol.p95).toBeGreaterThan(revCol.p50!);
  });

  it('generates SaaS MRR & Churn Cohorts sample with churned Enterprise accounts > 50M VND', () => {
    const sample = generateEnterpriseSampleDataset('saas_mrr_cohorts');
    expect(sample.tableName).toBe('saas_mrr_cohorts');
    expect(sample.rows.length).toBeGreaterThan(1500);

    const churnedEntOver50m = sample.rows.filter(
      (r) => r.segment === 'Enterprise' && r.is_churned === true && Number(r.mrr_vnd) > 50_000_000,
    );
    expect(churnedEntOver50m.length).toBeGreaterThan(0);
  });

  it('generates Supply Chain Freight Telemetry sample with 6,000 rows and SLA columns', () => {
    const sample = generateEnterpriseSampleDataset('supply_chain_freight');
    expect(sample.tableName).toBe('supply_chain_freight');
    expect(sample.rows.length).toBe(6_000);
    const delayCol = sample.profile.columns.find((c) => c.name === 'delay_hours')!;
    expect(delayCol.inferredType).toBe('Numeric');
    expect(delayCol.max).toBeGreaterThan(0);
    expect(ENTERPRISE_SAMPLE_CATALOG.length).toBe(3);
  });

  it('packs typed rows into valid Apache Arrow IPC bytes', () => {
    const ingested = parseAndProfileFile(
      'mini.json',
      JSON.stringify([
        { city: 'HCMC', rev: 1200, active: true },
        { city: 'Ha Noi', rev: 950, active: false },
      ]),
    );
    const ipc = buildArrowIpcFromRows(ingested.rows, ingested.profile);
    expect(ipc.byteLength).toBeGreaterThan(64);
  });

  it('ingests CSV & enterprise samples into NexusDuckDbEngine and executes filtered/grouped SQL', async () => {
    const engine = new NexusDuckDbEngine();
    await engine.initialize(generateColumnarTransactions(1_000, 11));

    const csv = 'city,channel,revenue_vnd\nHCMC,POS,500000\nHCMC,APP,300000\nHa Noi,POS,400000';
    const info = await engine.ingestFile('vn_pos_mini.csv', csv);
    expect(info.name).toBe('vn_pos_mini');
    expect(info.rowCount).toBe(3);
    expect(info.profile?.columns.length).toBe(3);

    const grouped = await engine.executeSql(
      'SELECT city, SUM(revenue_vnd) FROM vn_pos_mini GROUP BY city LIMIT 10;',
    );
    expect(grouped.error).toBeUndefined();
    expect(grouped.rowCount).toBe(2);
    expect(grouped.rows[0].city).toBe('HCMC');
    expect(grouped.rows[0].revenue_vnd).toBe(800000);

    const saas = generateEnterpriseSampleDataset('saas_mrr_cohorts');
    await engine.ingestStructuredDataset(saas, 'sample');
    expect(engine.hasTable('saas_mrr_cohorts')).toBe(true);

    const filtered = await engine.executeSql(
      "SELECT * FROM saas_mrr_cohorts WHERE segment = 'Enterprise' AND is_churned = true AND mrr_vnd > 50000000 LIMIT 20;",
    );
    expect(filtered.error).toBeUndefined();
    expect(filtered.rowCount).toBeGreaterThan(0);
    expect(Number(filtered.rows[0].mrr_vnd)).toBeGreaterThan(50_000_000);

    await engine.dispose();
  });
});
