import { tableFromArrays, tableToIPC } from 'apache-arrow';
import type {
  ColumnProfile,
  DatasetProfile,
  EnterpriseSampleId,
  InferredColumnType,
} from '../types/lakehouse';

export interface IngestedDataset {
  tableName: string;
  rows: Record<string, unknown>[];
  profile: DatasetProfile;
  /** Optional pre-packed Arrow IPC buffer for ultra-fast DuckDB-WASM ingestion (e.g. 50K rows) */
  arrowIpcBytes?: Uint8Array;
  /** Suggested starter SQL query tailored to this dataset */
  starterSql: string;
}

export interface EnterpriseSampleMeta {
  id: EnterpriseSampleId;
  tableName: string;
  titleEn: string;
  titleVi: string;
  badge: string;
  rowCountLabel: string;
  descriptionEn: string;
  descriptionVi: string;
  starterSql: string;
}

export const ENTERPRISE_SAMPLE_CATALOG: EnterpriseSampleMeta[] = [
  {
    id: 'vn_retail_pos_50k',
    tableName: 'vn_retail_pos_50k',
    titleEn: 'Vietnam Retail POS (50K Rows)',
    titleVi: 'Bán Lẻ POS Việt Nam (50K Dòng)',
    badge: '50K POS',
    rowCountLabel: '50,000 rows',
    descriptionEn:
      'Omnichannel retail POS orders across 6 Vietnamese cities with SKU revenue, COGS, gross margin VND & VIP loyalty flags.',
    descriptionVi:
      'Dữ liệu đơn hàng POS đa kênh tại 6 thành phố Việt Nam với doanh thu SKU, giá vốn, biên lợi nhuận VND & hạng thành viên VIP.',
    starterSql: `SELECT
  product_name,
  category,
  SUM(units_sold) AS total_units,
  ROUND(SUM(revenue_vnd), 0) AS revenue_vnd,
  ROUND(SUM(gross_margin_vnd), 0) AS gross_margin_vnd,
  ROUND(100.0 * SUM(gross_margin_vnd) / NULLIF(SUM(revenue_vnd), 0), 2) AS margin_pct
FROM vn_retail_pos_50k
GROUP BY product_name, category
ORDER BY gross_margin_vnd DESC
LIMIT 10;`,
  },
  {
    id: 'saas_mrr_cohorts',
    tableName: 'saas_mrr_cohorts',
    titleEn: 'SaaS MRR & Churn Cohorts',
    titleVi: 'SaaS MRR & Phân Khúc Rời Bỏ',
    badge: 'SAAS NRR',
    rowCountLabel: '2,450 rows',
    descriptionEn:
      'B2B SaaS subscription cohorts (M0-M6) with Enterprise, Mid-Market & Growth expansion MRR, seat counts, churn flags & NPS.',
    descriptionVi:
      'Dữ liệu cohort thuê bao SaaS B2B (M0-M6) gồm MRR mở rộng, số lượng seat, trạng thái churn & chỉ số NPS theo phân khúc.',
    starterSql: `SELECT
  signup_cohort,
  segment,
  COUNT(DISTINCT account_id) AS accounts,
  ROUND(SUM(mrr_vnd), 0) AS base_mrr_vnd,
  ROUND(SUM(expansion_vnd), 0) AS expansion_vnd,
  ROUND(SUM(net_mrr_vnd), 0) AS net_mrr_vnd,
  SUM(CASE WHEN is_churned THEN 1 ELSE 0 END) AS churned_records
FROM saas_mrr_cohorts
GROUP BY signup_cohort, segment
ORDER BY signup_cohort ASC, net_mrr_vnd DESC;`,
  },
  {
    id: 'supply_chain_freight',
    tableName: 'supply_chain_freight',
    titleEn: 'Supply Chain Freight Telemetry',
    titleVi: 'Chuỗi Cung Ứng & Vận Tải APAC',
    badge: 'FREIGHT',
    rowCountLabel: '6,000 rows',
    descriptionEn:
      'APAC port-to-hub cold-chain & ocean/air freight telemetry with SLA target hours, carrier delays & freight cost VND.',
    descriptionVi:
      'Telemetry vận tải biển/hàng không/chuỗi lạnh APAC từ cảng tới hub cùng mục tiêu SLA, độ trễ nhà xe & chi phí VND.',
    starterSql: `SELECT
  carrier,
  transport_mode,
  COUNT(*) AS shipments,
  ROUND(AVG(transit_hours), 1) AS avg_transit_hrs,
  ROUND(AVG(delay_hours), 2) AS avg_delay_hrs,
  ROUND(SUM(freight_cost_vnd), 0) AS total_freight_vnd,
  ROUND(100.0 * SUM(CASE WHEN on_time_delivery THEN 1 ELSE 0 END) / COUNT(*), 2) AS on_time_pct
FROM supply_chain_freight
GROUP BY carrier, transport_mode
ORDER BY total_freight_vnd DESC;`,
  },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sanitizeTableName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').toLowerCase();
  const clean = base.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) return 'uploaded_table';
  return /^[0-9]/.test(clean) ? `t_${clean}` : clean;
}

export function sanitizeColumnName(raw: string, fallbackIdx: number): string {
  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return `col_${fallbackIdx + 1}`;
  return /^[0-9]/.test(cleaned) ? `c_${cleaned}` : cleaned;
}

const ISO_DATE_RE =
  /^\d{4}[-/]\d{2}[-/]\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function isLeadingZeroCode(val: string): boolean {
  return /^0\d+$/.test(val);
}

function isNullishToken(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') {
    const trimmed = val.trim().toLowerCase();
    return trimmed === '' || trimmed === 'null' || trimmed === 'na' || trimmed === 'n/a' || trimmed === 'nan';
  }
  return false;
}

function detectDelimiter(firstLine: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const delim of candidates) {
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < firstLine.length; i += 1) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === delim) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = delim;
    }
  }
  return best;
}

/**
 * Full RFC-4180 CSV parser supporting quoted fields, escaped quotes (""),
 * embedded commas/newlines, UTF-8 BOM stripping, and auto delimiter detection.
 */
export function parseCsvRfc4180(rawText: string): { headers: string[]; rows: string[][] } {
  const text = rawText.replace(/^\uFEFF/, '');
  if (!text.trim()) return { headers: [], rows: [] };

  const firstNewline = text.indexOf('\n');
  const firstLine = firstNewline >= 0 ? text.slice(0, firstNewline) : text;
  const delimiter = detectDelimiter(firstLine);

  const parsedRows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if (ch === '\r' && next === '\n') {
      currentRow.push(currentField.trim());
      if (currentRow.some((cell) => cell !== '')) {
        parsedRows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      currentRow.push(currentField.trim());
      if (currentRow.some((cell) => cell !== '')) {
        parsedRows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }

  currentRow.push(currentField.trim());
  if (currentRow.some((cell) => cell !== '')) {
    parsedRows.push(currentRow);
  }

  if (parsedRows.length === 0) return { headers: [], rows: [] };

  const seenNames = new Map<string, number>();
  const headers = parsedRows[0].map((h, idx) => {
    const base = sanitizeColumnName(h, idx);
    const count = seenNames.get(base) ?? 0;
    seenNames.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });

  return {
    headers,
    rows: parsedRows.slice(1),
  };
}

/**
 * Parses standard JSON arrays, wrapped payload objects ({ data | rows | records | items }),
 * or NDJSON (newline-delimited JSON objects).
 */
export function parseJsonDataset(rawText: string): Record<string, unknown>[] {
  const text = rawText.replace(/^\uFEFF/, '').trim();
  if (!text) return [];

  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      );
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['data', 'rows', 'records', 'items', 'results']) {
        if (Array.isArray(obj[key])) {
          return (obj[key] as unknown[]).filter(
            (item): item is Record<string, unknown> =>
              typeof item === 'object' && item !== null && !Array.isArray(item),
          );
        }
      }
      return [obj];
    }
  } catch {
    // Attempt NDJSON fallback
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const out: Record<string, unknown>[] = [];
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    }
    return out;
  }

  return [];
}

export function inferColumnTypeFromValues(values: unknown[]): InferredColumnType {
  let nonNull = 0;
  let numCount = 0;
  let boolCount = 0;
  let dateCount = 0;

  const sampleLimit = Math.min(values.length, 4000);
  const step = values.length > sampleLimit ? Math.max(1, Math.floor(values.length / sampleLimit)) : 1;

  for (let i = 0; i < values.length; i += step) {
    const v = values[i];
    if (isNullishToken(v)) continue;
    nonNull += 1;

    if (typeof v === 'boolean') {
      boolCount += 1;
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      numCount += 1;
      continue;
    }
    const s = String(v).trim();
    const lower = s.toLowerCase();
    if (lower === 'true' || lower === 'false') {
      boolCount += 1;
      continue;
    }
    if (ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(s.replace('/', '-')))) {
      dateCount += 1;
      continue;
    }
    if (!isLeadingZeroCode(s) && NUMERIC_RE.test(s) && Number.isFinite(Number(s))) {
      numCount += 1;
    }
  }

  if (nonNull === 0) return 'String';
  const ratio = 0.92;
  if (boolCount / nonNull >= ratio) return 'Boolean';
  if (dateCount / nonNull >= ratio) return 'Date';
  if (numCount / nonNull >= ratio) return 'Numeric';
  return 'String';
}

export function mapInferredTypeToSql(t: InferredColumnType): string {
  switch (t) {
    case 'Numeric':
      return 'DOUBLE';
    case 'Boolean':
      return 'BOOLEAN';
    case 'Date':
      return 'VARCHAR';
    default:
      return 'VARCHAR';
  }
}

function coerceScalar(raw: unknown, type: InferredColumnType): unknown {
  if (isNullishToken(raw)) return null;
  if (type === 'Boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return null;
  }
  if (type === 'Numeric') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const n = Number(String(raw).trim());
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'Date') {
    return String(raw).trim();
  }
  return typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
}

function computeQuantileSorted(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return Number(sorted[idx].toFixed(4));
}

/**
 * Computes full column profiling (inferred type, null counts, cardinality, min/max/p50/p95, top values).
 */
export function profileDatasetRows(
  tableName: string,
  sourceName: string,
  format: 'csv' | 'json' | 'sample',
  rows: Record<string, unknown>[],
  parseMs: number,
  estimatedBytes: number,
  knownTypes?: Record<string, InferredColumnType>,
): DatasetProfile {
  const rowCount = rows.length;
  const headerSet = new Set<string>();
  const inspectLimit = Math.min(rowCount, 128);
  for (let i = 0; i < inspectLimit; i += 1) {
    for (const k of Object.keys(rows[i])) headerSet.add(k);
  }
  const colNames = [...headerSet];

  const columns: ColumnProfile[] = colNames.map((name) => {
    const colVals = new Array<unknown>(rowCount);
    for (let i = 0; i < rowCount; i += 1) {
      colVals[i] = rows[i][name];
    }

    const inferredType = knownTypes?.[name] ?? inferColumnTypeFromValues(colVals);
    const sqlType = mapInferredTypeToSql(inferredType);

    let nullCount = 0;
    const distinctSet = new Set<string>();
    const freqMap = new Map<string, number>();
    const sampleValues: string[] = [];

    if (inferredType === 'Numeric') {
      const nums = new Float64Array(rowCount);
      let numLen = 0;
      let sum = 0;
      let minVal = Infinity;
      let maxVal = -Infinity;

      for (let i = 0; i < rowCount; i += 1) {
        const v = colVals[i];
        if (isNullishToken(v)) {
          nullCount += 1;
          continue;
        }
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) {
          nullCount += 1;
          continue;
        }
        nums[numLen++] = n;
        sum += n;
        if (n < minVal) minVal = n;
        if (n > maxVal) maxVal = n;
        const key = String(n);
        if (distinctSet.size < 100_000) distinctSet.add(key);
        if (sampleValues.length < 4 && !sampleValues.includes(key)) {
          sampleValues.push(key);
        }
      }

      const activeSlice = nums.subarray(0, numLen);
      activeSlice.sort();

      return {
        name,
        inferredType,
        sqlType,
        rowCount,
        nullCount,
        nullRatePct: rowCount > 0 ? Number(((nullCount / rowCount) * 100).toFixed(2)) : 0,
        cardinality: distinctSet.size,
        min: numLen > 0 ? Number(minVal.toFixed(4)) : undefined,
        max: numLen > 0 ? Number(maxVal.toFixed(4)) : undefined,
        mean: numLen > 0 ? Number((sum / numLen).toFixed(4)) : undefined,
        p50: numLen > 0 ? computeQuantileSorted(activeSlice, 0.5) : undefined,
        p95: numLen > 0 ? computeQuantileSorted(activeSlice, 0.95) : undefined,
        sampleValues,
      };
    }

    let minStr: string | undefined;
    let maxStr: string | undefined;

    for (let i = 0; i < rowCount; i += 1) {
      const v = colVals[i];
      if (isNullishToken(v)) {
        nullCount += 1;
        continue;
      }
      const str = String(v);
      if (distinctSet.size < 100_000) distinctSet.add(str);
      if (freqMap.size < 2500 || freqMap.has(str)) {
        freqMap.set(str, (freqMap.get(str) ?? 0) + 1);
      }
      if (minStr === undefined || str < minStr) minStr = str;
      if (maxStr === undefined || str > maxStr) maxStr = str;
      if (sampleValues.length < 4 && !sampleValues.includes(str)) {
        sampleValues.push(str);
      }
    }

    const topValues = [...freqMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([value, count]) => ({ value, count }));

    return {
      name,
      inferredType,
      sqlType,
      rowCount,
      nullCount,
      nullRatePct: rowCount > 0 ? Number(((nullCount / rowCount) * 100).toFixed(2)) : 0,
      cardinality: distinctSet.size,
      min: minStr,
      max: maxStr,
      topValues,
      sampleValues,
    };
  });

  return {
    tableName,
    sourceName,
    format,
    rowCount,
    columnCount: columns.length,
    parseMs: Number(parseMs.toFixed(2)),
    estimatedBytes,
    ingestedAt: new Date().toISOString(),
    columns,
  };
}

/**
 * Builds an Apache Arrow IPC stream from typed row objects + DatasetProfile
 * so DuckDB-WASM can ingest arbitrary datasets without SQL-escaping hazards.
 */
export function buildArrowIpcFromRows(
  rows: Record<string, unknown>[],
  profile: DatasetProfile,
): Uint8Array {
  const n = rows.length;
  const arrays: Record<string, Float64Array | string[] | boolean[]> = {};

  for (const col of profile.columns) {
    if (col.inferredType === 'Numeric') {
      const arr = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        const val = rows[i][col.name];
        arr[i] = typeof val === 'number' && Number.isFinite(val) ? val : NaN;
      }
      arrays[col.name] = arr;
    } else if (col.inferredType === 'Boolean') {
      const arr = new Array<boolean>(n);
      for (let i = 0; i < n; i += 1) {
        arr[i] = Boolean(rows[i][col.name]);
      }
      arrays[col.name] = arr;
    } else {
      const arr = new Array<string>(n);
      for (let i = 0; i < n; i += 1) {
        const val = rows[i][col.name];
        arr[i] = val === null || val === undefined ? '' : String(val);
      }
      arrays[col.name] = arr;
    }
  }

  const table = tableFromArrays(arrays);
  return tableToIPC(table, 'stream');
}

/**
 * Parses and profiles a user-uploaded local CSV or JSON file into a queryable table.
 */
export function parseAndProfileFile(fileName: string, content: string): IngestedDataset {
  const start = performance.now();
  const tableName = sanitizeTableName(fileName);
  const lower = fileName.toLowerCase();
  const isJson = lower.endsWith('.json') || lower.endsWith('.ndjson');
  const estimatedBytes = new Blob([content]).size;

  let coercedRows: Record<string, unknown>[] = [];
  const inferredMap: Record<string, InferredColumnType> = {};

  if (isJson) {
    const rawObjects = parseJsonDataset(content);
    if (rawObjects.length === 0) {
      throw new Error('JSON file contains no valid object rows.');
    }
    const colSet = new Set<string>();
    for (const obj of rawObjects.slice(0, 128)) {
      for (const k of Object.keys(obj)) colSet.add(k);
    }
    const rawKeys = [...colSet];
    const cleanKeys = rawKeys.map((k, idx) => sanitizeColumnName(k, idx));

    for (let c = 0; c < rawKeys.length; c += 1) {
      const sample = rawObjects.map((r) => r[rawKeys[c]]);
      inferredMap[cleanKeys[c]] = inferColumnTypeFromValues(sample);
    }

    coercedRows = rawObjects.map((r) => {
      const out: Record<string, unknown> = {};
      for (let c = 0; c < rawKeys.length; c += 1) {
        out[cleanKeys[c]] = coerceScalar(r[rawKeys[c]], inferredMap[cleanKeys[c]]);
      }
      return out;
    });
  } else {
    const { headers, rows: rawMatrix } = parseCsvRfc4180(content);
    if (headers.length === 0 || rawMatrix.length === 0) {
      throw new Error('CSV file must include a header row and at least one data row.');
    }

    for (let c = 0; c < headers.length; c += 1) {
      const colVals = rawMatrix.map((r) => r[c]);
      inferredMap[headers[c]] = inferColumnTypeFromValues(colVals);
    }

    coercedRows = rawMatrix.map((rawRow) => {
      const out: Record<string, unknown> = {};
      for (let c = 0; c < headers.length; c += 1) {
        out[headers[c]] = coerceScalar(rawRow[c], inferredMap[headers[c]]);
      }
      return out;
    });
  }

  const parseMs = performance.now() - start;
  const profile = profileDatasetRows(
    tableName,
    fileName,
    isJson ? 'json' : 'csv',
    coercedRows,
    parseMs,
    estimatedBytes,
    inferredMap,
  );

  const firstCat = profile.columns.find((c) => c.inferredType === 'String' && c.cardinality > 1 && c.cardinality <= 60);
  const firstNum = profile.columns.find((c) => c.inferredType === 'Numeric');

  const starterSql =
    firstCat && firstNum
      ? `SELECT
  ${firstCat.name},
  COUNT(*) AS row_count,
  ROUND(SUM(${firstNum.name}), 2) AS total_${firstNum.name},
  ROUND(AVG(${firstNum.name}), 2) AS avg_${firstNum.name}
FROM "${tableName}"
GROUP BY ${firstCat.name}
ORDER BY total_${firstNum.name} DESC
LIMIT 25;`
      : `SELECT * FROM "${tableName}" LIMIT 100;`;

  return {
    tableName,
    rows: coercedRows,
    profile,
    starterSql,
  };
}

// ============================================================================
// 3 Instant 1-Click Enterprise Sample Datasets
// ============================================================================

const VN_CITIES = ['Ho Chi Minh', 'Ha Noi', 'Da Nang', 'Can Tho', 'Hai Phong', 'Binh Duong'] as const;
const POS_CHANNELS = ['POS_STORE', 'APP_DELIVERY', 'ZALO_MINIAPP', 'OMNICHANNEL'] as const;
const POS_PRODUCTS: { name: string; category: string; unitPrice: number; marginRatio: number }[] = [
  { name: 'Aptamil Gold Stage 3 900g', category: 'Dairy & Formula', unitPrice: 685_000, marginRatio: 0.28 },
  { name: 'Meiji Infant Formula 800g', category: 'Dairy & Formula', unitPrice: 545_000, marginRatio: 0.25 },
  { name: 'Merries Super Jumbo Diaper L', category: 'Baby Gear', unitPrice: 425_000, marginRatio: 0.31 },
  { name: 'Pampers Ichiban Pull-Up XL', category: 'Baby Gear', unitPrice: 395_000, marginRatio: 0.29 },
  { name: 'Ensure Gold Vanilla 850g', category: 'Health & Pharma', unitPrice: 890_000, marginRatio: 0.34 },
  { name: 'Blackmores Bio C 1000mg', category: 'Health & Pharma', unitPrice: 460_000, marginRatio: 0.42 },
  { name: 'Smart UV Sterilizer Pro', category: 'Smart Electronics', unitPrice: 2_890_000, marginRatio: 0.38 },
  { name: 'AI Baby Monitor 2K Wifi', category: 'Smart Electronics', unitPrice: 1_950_000, marginRatio: 0.41 },
  { name: 'Combi Compact Stroller Air', category: 'Baby Gear', unitPrice: 6_450_000, marginRatio: 0.33 },
  { name: 'Vinamilk Organic A2 Pack', category: 'Organic Fresh', unitPrice: 245_000, marginRatio: 0.22 },
  { name: 'Dalat Organic Berry Box', category: 'Organic Fresh', unitPrice: 185_000, marginRatio: 0.36 },
  { name: 'Kiddie Omega-3 DHA Drops', category: 'Health & Pharma', unitPrice: 520_000, marginRatio: 0.45 },
  { name: 'Ergonomic Carrier Mesh Pro', category: 'Baby Gear', unitPrice: 1_680_000, marginRatio: 0.39 },
  { name: 'ThermoScan Digital Ear Pro', category: 'Smart Electronics', unitPrice: 1_290_000, marginRatio: 0.37 },
  { name: 'ST25 Premium Rice 5kg', category: 'FMCG Essential', unitPrice: 215_000, marginRatio: 0.19 },
  { name: 'Organic Cold-Pressed Olive Oil', category: 'FMCG Essential', unitPrice: 310_000, marginRatio: 0.32 },
];

function generateVnRetailPos50k(): IngestedDataset {
  const start = performance.now();
  const rowCount = 50_000;
  const rng = mulberry32(20261127);

  const orderIdArr = new Array<string>(rowCount);
  const orderDateArr = new Array<string>(rowCount);
  const orderMonthArr = new Array<string>(rowCount);
  const cityArr = new Array<string>(rowCount);
  const branchArr = new Array<string>(rowCount);
  const categoryArr = new Array<string>(rowCount);
  const productArr = new Array<string>(rowCount);
  const channelArr = new Array<string>(rowCount);
  const unitsArr = new Float64Array(rowCount);
  const revenueArr = new Float64Array(rowCount);
  const costArr = new Float64Array(rowCount);
  const marginArr = new Float64Array(rowCount);
  const marginPctArr = new Float64Array(rowCount);
  const vipArr = new Array<boolean>(rowCount);

  const rows = new Array<Record<string, unknown>>(rowCount);

  // Months 2026-01 .. 2026-10 with progressive growth curve for realistic MoM SQL analytics
  const monthWeights = [0.072, 0.078, 0.085, 0.091, 0.098, 0.105, 0.112, 0.116, 0.12, 0.123];
  const monthCumulative: number[] = [];
  let acc = 0;
  for (const w of monthWeights) {
    acc += w;
    monthCumulative.push(acc);
  }

  for (let i = 0; i < rowCount; i += 1) {
    const rMonth = rng();
    let mIdx = 9;
    for (let m = 0; m < monthCumulative.length; m += 1) {
      if (rMonth <= monthCumulative[m]) {
        mIdx = m;
        break;
      }
    }
    const monthNum = mIdx + 1;
    const dayNum = 1 + Math.floor(rng() * 28);
    const monthStr = `2026-${String(monthNum).padStart(2, '0')}`;
    const dateStr = `${monthStr}-${String(dayNum).padStart(2, '0')}`;

    const cityPick = rng();
    const cityIdx =
      cityPick < 0.36 ? 0 : cityPick < 0.63 ? 1 : cityPick < 0.76 ? 2 : cityPick < 0.85 ? 3 : cityPick < 0.93 ? 4 : 5;
    const city = VN_CITIES[cityIdx];
    const branchNo = 1 + Math.floor(rng() * 18);
    const branch = `${city.slice(0, 3).toUpperCase()}-S${String(branchNo).padStart(2, '0')}`;

    const prod = POS_PRODUCTS[Math.floor(rng() * POS_PRODUCTS.length)];
    const units = 1 + Math.floor(Math.pow(rng(), 2.2) * 8);
    const discountFactor = 0.92 + rng() * 0.12;
    const revenue = Math.round(prod.unitPrice * units * discountFactor);
    const actualMarginRatio = Math.max(0.12, Math.min(0.55, prod.marginRatio + (rng() - 0.5) * 0.08));
    const margin = Math.round(revenue * actualMarginRatio);
    const cost = revenue - margin;
    const marginPct = Number(((margin / Math.max(1, revenue)) * 100).toFixed(2));
    const channel = POS_CHANNELS[Math.floor(rng() * POS_CHANNELS.length)];
    const isVip = rng() < 0.34;
    const orderId = `POS-${String(100000 + i)}`;

    orderIdArr[i] = orderId;
    orderDateArr[i] = dateStr;
    orderMonthArr[i] = monthStr;
    cityArr[i] = city;
    branchArr[i] = branch;
    categoryArr[i] = prod.category;
    productArr[i] = prod.name;
    channelArr[i] = channel;
    unitsArr[i] = units;
    revenueArr[i] = revenue;
    costArr[i] = cost;
    marginArr[i] = margin;
    marginPctArr[i] = marginPct;
    vipArr[i] = isVip;

    rows[i] = {
      order_id: orderId,
      order_date: dateStr,
      order_month: monthStr,
      city,
      store_branch: branch,
      category: prod.category,
      product_name: prod.name,
      channel,
      units_sold: units,
      revenue_vnd: revenue,
      cost_vnd: cost,
      gross_margin_vnd: margin,
      gross_margin_pct: marginPct,
      is_vip_member: isVip,
    };
  }

  const arrowTable = tableFromArrays({
    order_id: orderIdArr,
    order_date: orderDateArr,
    order_month: orderMonthArr,
    city: cityArr,
    store_branch: branchArr,
    category: categoryArr,
    product_name: productArr,
    channel: channelArr,
    units_sold: unitsArr,
    revenue_vnd: revenueArr,
    cost_vnd: costArr,
    gross_margin_vnd: marginArr,
    gross_margin_pct: marginPctArr,
    is_vip_member: vipArr,
  });
  const arrowIpcBytes = tableToIPC(arrowTable, 'stream');

  const knownTypes: Record<string, InferredColumnType> = {
    order_id: 'String',
    order_date: 'Date',
    order_month: 'String',
    city: 'String',
    store_branch: 'String',
    category: 'String',
    product_name: 'String',
    channel: 'String',
    units_sold: 'Numeric',
    revenue_vnd: 'Numeric',
    cost_vnd: 'Numeric',
    gross_margin_vnd: 'Numeric',
    gross_margin_pct: 'Numeric',
    is_vip_member: 'Boolean',
  };

  const parseMs = performance.now() - start;
  const profile = profileDatasetRows(
    'vn_retail_pos_50k',
    'vietnam_retail_pos_50k.parquet',
    'sample',
    rows,
    parseMs,
    arrowIpcBytes.byteLength,
    knownTypes,
  );

  return {
    tableName: 'vn_retail_pos_50k',
    rows,
    profile,
    arrowIpcBytes,
    starterSql: ENTERPRISE_SAMPLE_CATALOG[0].starterSql,
  };
}

const SAAS_COMPANY_PREFIXES = [
  'Saigon', 'Viet', 'Mekong', 'Hanoi', 'Pacific', 'Lotus', 'Dragon', 'Asean',
  'Nexus', 'Cloud', 'Vina', 'Hyper', 'KinhDo', 'Sun', 'Alpha', 'Prime',
];
const SAAS_COMPANY_SUFFIXES = [
  'Logistics', 'Retail Group', 'Fintech', 'Commerce', 'Holdings', 'Systems',
  'Pharma', 'Capital', 'Manufacturing', 'Distribution', 'Digital', 'MedTech',
];

function generateSaasMrrCohorts(): IngestedDataset {
  const start = performance.now();
  const rng = mulberry32(990418);
  const cohorts = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
  const segments = ['Enterprise', 'Mid-Market', 'Growth'] as const;
  const regions = ['VN-South', 'VN-North', 'SG-HQ', 'US-West', 'EU-DACH'] as const;

  const rows: Record<string, unknown>[] = [];
  let accCounter = 1;

  for (let cIdx = 0; cIdx < cohorts.length; cIdx += 1) {
    const cohort = cohorts[cIdx];
    const maxPeriods = cohorts.length - cIdx; // Triangular cohort matrix M0..M6
    const accountsInCohort = 85 + (cIdx % 3) * 12;

    for (let a = 0; a < accountsInCohort; a += 1) {
      const accountId = `ACC-${String(accCounter++).padStart(4, '0')}`;
      const segRoll = rng();
      const segment = segRoll < 0.28 ? segments[0] : segRoll < 0.65 ? segments[1] : segments[2];
      const region = regions[Math.floor(rng() * regions.length)];
      const companyName = `${SAAS_COMPANY_PREFIXES[Math.floor(rng() * SAAS_COMPANY_PREFIXES.length)]} ${
        SAAS_COMPANY_SUFFIXES[Math.floor(rng() * SAAS_COMPANY_SUFFIXES.length)]
      } #${accCounter}`;

      const baseMrr =
        segment === 'Enterprise'
          ? Math.round((45_000_000 + rng() * 145_000_000) / 100_000) * 100_000
          : segment === 'Mid-Market'
            ? Math.round((15_000_000 + rng() * 34_000_000) / 100_000) * 100_000
            : Math.round((3_500_000 + rng() * 11_000_000) / 100_000) * 100_000;

      const baseSeats =
        segment === 'Enterprise'
          ? 45 + Math.floor(rng() * 180)
          : segment === 'Mid-Market'
            ? 15 + Math.floor(rng() * 40)
            : 4 + Math.floor(rng() * 14);

      const monthlyChurnProb =
        segment === 'Enterprise' ? 0.032 : segment === 'Mid-Market' ? 0.062 : 0.095;
      const expansionRate =
        segment === 'Enterprise' ? 0.068 : segment === 'Mid-Market' ? 0.038 : 0.015;

      let active = true;
      let cumulativeExpansion = 0;
      let currentSeats = baseSeats;

      for (let p = 0; p < maxPeriods; p += 1) {
        if (p > 0 && active) {
          if (rng() < monthlyChurnProb) {
            active = false;
          } else if (rng() < 0.58) {
            const delta = Math.round((baseMrr * expansionRate * (0.6 + rng() * 1.1)) / 100_000) * 100_000;
            cumulativeExpansion += delta;
            currentSeats += Math.max(1, Math.floor(rng() * 6));
          }
        }

        const activeMonth = `2026-${String(cIdx + p + 1).padStart(2, '0')}`;
        const expansionVnd = active ? cumulativeExpansion : 0;
        const netMrr = active ? baseMrr + expansionVnd : 0;
        const nps = active ? Math.min(100, Math.max(18, Math.round(58 + (rng() - 0.35) * 44))) : Math.round(12 + rng() * 25);

        rows.push({
          account_id: accountId,
          company_name: companyName,
          segment,
          region,
          signup_cohort: cohort,
          period_index: p,
          active_month: activeMonth,
          mrr_vnd: baseMrr,
          expansion_vnd: expansionVnd,
          net_mrr_vnd: netMrr,
          seats: active ? currentSeats : 0,
          is_active: active,
          is_churned: !active,
          nps_score: nps,
        });
      }
    }
  }

  const knownTypes: Record<string, InferredColumnType> = {
    account_id: 'String',
    company_name: 'String',
    segment: 'String',
    region: 'String',
    signup_cohort: 'String',
    period_index: 'Numeric',
    active_month: 'String',
    mrr_vnd: 'Numeric',
    expansion_vnd: 'Numeric',
    net_mrr_vnd: 'Numeric',
    seats: 'Numeric',
    is_active: 'Boolean',
    is_churned: 'Boolean',
    nps_score: 'Numeric',
  };

  const parseMs = performance.now() - start;
  const profile = profileDatasetRows(
    'saas_mrr_cohorts',
    'saas_mrr_churn_cohorts.json',
    'sample',
    rows,
    parseMs,
    rows.length * 168,
    knownTypes,
  );
  const arrowIpcBytes = buildArrowIpcFromRows(rows, profile);

  return {
    tableName: 'saas_mrr_cohorts',
    rows,
    profile,
    arrowIpcBytes,
    starterSql: ENTERPRISE_SAMPLE_CATALOG[1].starterSql,
  };
}

function generateSupplyChainFreight(): IngestedDataset {
  const start = performance.now();
  const rng = mulberry32(441092);
  const rowCount = 6_000;
  const hubs = [
    'Cat Lai HCMC',
    'Hai Phong Port',
    'Da Nang Hub',
    'Singapore PSA',
    'Shenzhen Yantian',
    'Laem Chabang TH',
  ] as const;
  const carriers = [
    'GMD Logistics',
    'Viettel Post Freight',
    'Maersk APAC',
    'DHL Supply Chain',
    'Kerry Express',
  ] as const;
  const modes = ['SEA', 'AIR', 'ROAD_COLD', 'RAIL'] as const;

  const rows = new Array<Record<string, unknown>>(rowCount);

  for (let i = 0; i < rowCount; i += 1) {
    const originIdx = Math.floor(rng() * hubs.length);
    const destIdx = (originIdx + 1 + Math.floor(rng() * (hubs.length - 1))) % hubs.length;
    const carrier = carriers[Math.floor(rng() * carriers.length)];
    const mode = modes[Math.floor(rng() * modes.length)];
    const month = 1 + Math.floor(rng() * 10);
    const day = 1 + Math.floor(rng() * 28);
    const dispatchDate = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const weightKg = Number((120 + Math.pow(rng(), 1.8) * 18_500).toFixed(1));
    const slaTarget = mode === 'AIR' ? 18 : mode === 'ROAD_COLD' ? 36 : mode === 'RAIL' ? 60 : 120;
    const isDelayed = rng() < (mode === 'SEA' ? 0.24 : mode === 'ROAD_COLD' ? 0.14 : 0.09);
    const delayHours = isDelayed ? Number((2 + Math.pow(rng(), 1.5) * 38).toFixed(1)) : 0;
    const transitHours = Number((slaTarget * (0.82 + rng() * 0.2) + delayHours).toFixed(1));
    const costPerKg = mode === 'AIR' ? 52_000 : mode === 'ROAD_COLD' ? 18_500 : mode === 'RAIL' ? 11_200 : 6_800;
    const freightCostVnd = Math.round(weightKg * costPerKg * (0.88 + rng() * 0.26));
    const tempCelsius =
      mode === 'ROAD_COLD'
        ? Number((2.0 + (rng() - 0.3) * 4.5).toFixed(1))
        : Number((22.0 + rng() * 11.0).toFixed(1));

    rows[i] = {
      shipment_id: `FRT-${String(50000 + i)}`,
      dispatch_date: dispatchDate,
      origin_hub: hubs[originIdx],
      dest_hub: hubs[destIdx],
      carrier,
      transport_mode: mode,
      weight_kg: weightKg,
      freight_cost_vnd: freightCostVnd,
      sla_target_hours: slaTarget,
      transit_hours: transitHours,
      delay_hours: delayHours,
      temp_celsius: tempCelsius,
      on_time_delivery: delayHours === 0,
    };
  }

  const knownTypes: Record<string, InferredColumnType> = {
    shipment_id: 'String',
    dispatch_date: 'Date',
    origin_hub: 'String',
    dest_hub: 'String',
    carrier: 'String',
    transport_mode: 'String',
    weight_kg: 'Numeric',
    freight_cost_vnd: 'Numeric',
    sla_target_hours: 'Numeric',
    transit_hours: 'Numeric',
    delay_hours: 'Numeric',
    temp_celsius: 'Numeric',
    on_time_delivery: 'Boolean',
  };

  const parseMs = performance.now() - start;
  const profile = profileDatasetRows(
    'supply_chain_freight',
    'supply_chain_freight_telemetry.csv',
    'sample',
    rows,
    parseMs,
    rowCount * 145,
    knownTypes,
  );
  const arrowIpcBytes = buildArrowIpcFromRows(rows, profile);

  return {
    tableName: 'supply_chain_freight',
    rows,
    profile,
    arrowIpcBytes,
    starterSql: ENTERPRISE_SAMPLE_CATALOG[2].starterSql,
  };
}

export function generateEnterpriseSampleDataset(id: EnterpriseSampleId): IngestedDataset {
  switch (id) {
    case 'vn_retail_pos_50k':
      return generateVnRetailPos50k();
    case 'saas_mrr_cohorts':
      return generateSaasMrrCohorts();
    case 'supply_chain_freight':
      return generateSupplyChainFreight();
  }
}
