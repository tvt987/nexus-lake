import type { NlSqlTranslation, TableSchemaInfo } from '../types/lakehouse';
import { SQL_PRESETS } from '../engine/sqlPresets';

export interface NlSqlPresetPrompt {
  id: string;
  labelEn: string;
  labelVi: string;
  promptEn: string;
  promptVi: string;
  badge: string;
}

export const NL_TO_SQL_PRESETS: NlSqlPresetPrompt[] = [
  {
    id: 'top-products-margin',
    labelEn: 'Top 10 products by gross margin',
    labelVi: 'Top 10 sản phẩm biên lợi nhuận cao nhất',
    promptEn: 'Top 10 products by gross margin',
    promptVi: 'Top 10 sản phẩm biên lợi nhuận cao nhất',
    badge: 'RETAIL POS',
  },
  {
    id: 'monthly-revenue-mom',
    labelEn: 'Monthly revenue MoM growth',
    labelVi: 'Tăng trưởng doanh thu theo tháng MoM',
    promptEn: 'Monthly revenue MoM growth',
    promptVi: 'Tăng trưởng doanh thu theo tháng MoM',
    badge: 'WINDOW LAG',
  },
  {
    id: 'churned-enterprise-50m',
    labelEn: 'Churned enterprise accounts > 50M VND',
    labelVi: 'Tài khoản Enterprise rời bỏ > 50M VND',
    promptEn: 'Churned enterprise accounts > 50M VND',
    promptVi: 'Tài khoản doanh nghiệp rời bỏ > 50 triệu VND',
    badge: 'SAAS CHURN',
  },
  {
    id: 'freight-sla-carrier',
    labelEn: 'Freight carrier SLA delay breakdown',
    labelVi: 'Phân tích độ trễ SLA nhà vận chuyển',
    promptEn: 'Freight carrier SLA delay breakdown',
    promptVi: 'Phân tích độ trễ SLA theo nhà vận chuyển',
    badge: 'LOGISTICS',
  },
  {
    id: 'regional-fraud-rollup',
    labelEn: 'Regional fraud & anomaly rate',
    labelVi: 'Tỷ lệ gian lận theo khu vực',
    promptEn: 'Show regional fraud spikes and anomaly rate',
    promptVi: 'Thống kê gian lận và doanh số theo khu vực',
    badge: 'RISK OLAP',
  },
];

function stripVietnameseDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function extractTopLimit(normalized: string, fallback: number): number {
  const match = normalized.match(/\b(?:top|limit|dau|hang dau)\s+(\d{1,3})\b/);
  if (!match) return fallback;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 1 ? Math.min(200, n) : fallback;
}

function extractVndThreshold(normalized: string, fallbackVnd: number): number {
  // Matches "> 50m", "> 50 trieu", "> 1.5b", "> 50000000"
  const mMatch = normalized.match(/(?:>|tren|hon|over|above|>=)\s*(\d+(?:\.\d+)?)\s*(m|tr|trieu|million|b|ty|billion)?/i);
  if (!mMatch) return fallbackVnd;
  const num = Number(mMatch[1]);
  if (!Number.isFinite(num)) return fallbackVnd;
  const unit = (mMatch[2] ?? '').toLowerCase();
  if (unit === 'b' || unit === 'ty' || unit === 'billion') return Math.round(num * 1_000_000_000);
  if (unit === 'm' || unit === 'tr' || unit === 'trieu' || unit === 'million') {
    return Math.round(num * 1_000_000);
  }
  return num < 1000 ? Math.round(num * 1_000_000) : Math.round(num);
}

/**
 * Validates that compiled SQL is strictly read-only SELECT / WITH CTE
 * with zero DDL/DML injection vectors.
 */
export function isReadOnlySafeSql(sql: string): boolean {
  const cleaned = sql.replace(/--[^\n]*/g, ' ').trim();
  if (!/^(SELECT|WITH)\b/i.test(cleaned)) return false;
  if (/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER|CREATE|ATTACH|COPY|PRAGMA)\b/i.test(cleaned)) {
    return false;
  }
  return true;
}

/**
 * Offline deterministic Vietnamese/English Natural-Language-to-SQL Compiler.
 * Maps plain analytics questions into executable DuckDB SQL and identifies
 * whether a built-in enterprise dataset should be auto-mounted.
 */
export function translateNlToSql(
  rawPrompt: string,
  registeredTables: TableSchemaInfo[] = [],
): NlSqlTranslation {
  const prompt = rawPrompt.trim();
  const norm = stripVietnameseDiacritics(prompt);
  const topN = extractTopLimit(norm, 10);

  // 1. Churned Enterprise Accounts > X VND (SaaS MRR & Churn Cohorts)
  if (
    (norm.includes('churn') || norm.includes('roi bo') || norm.includes('huy goi') || norm.includes('ngung gia han')) &&
    (norm.includes('enterprise') || norm.includes('doanh nghiep') || norm.includes('account') || norm.includes('tai khoan') || norm.includes('saas') || norm.includes('mrr'))
  ) {
    const thresholdVnd = extractVndThreshold(norm, 50_000_000);
    const segmentFilter = norm.includes('mid-market') || norm.includes('mid market')
      ? "segment = 'Mid-Market'"
      : norm.includes('growth')
        ? "segment = 'Growth'"
        : "segment = 'Enterprise'";

    return {
      prompt,
      intent: 'churned_enterprise_accounts',
      targetTable: 'saas_mrr_cohorts',
      requiredSampleDataset: 'saas_mrr_cohorts',
      confidence: 0.97,
      matchedTokens: ['churn', segmentFilter, `mrr_vnd > ${thresholdVnd}`],
      explanationEn: `Isolating churned ${segmentFilter.replace("segment = '", '').replace("'", '')} SaaS accounts with base MRR above ${(thresholdVnd / 1_000_000).toFixed(0)}M VND ranked by revenue at risk.`,
      explanationVi: `Lọc danh sách tài khoản SaaS rời bỏ có MRR trên ${(thresholdVnd / 1_000_000).toFixed(0)} triệu VND, sắp xếp theo doanh thu rủi ro cao nhất.`,
      sql: `SELECT
  account_id,
  company_name,
  segment,
  region,
  signup_cohort,
  MIN(active_month) AS churn_month,
  ROUND(MAX(mrr_vnd), 0) AS lost_mrr_vnd,
  MIN(nps_score) AS exit_nps
FROM saas_mrr_cohorts
WHERE ${segmentFilter}
  AND is_churned = true
  AND mrr_vnd > ${thresholdVnd}
GROUP BY account_id, company_name, segment, region, signup_cohort
ORDER BY lost_mrr_vnd DESC
LIMIT ${extractTopLimit(norm, 25)};`,
    };
  }

  // 2. Monthly Revenue MoM Growth (Window LAG on Vietnam Retail POS 50K)
  if (
    norm.includes('mom') ||
    norm.includes('month over month') ||
    norm.includes('tang truong') ||
    (norm.includes('monthly') && (norm.includes('revenue') || norm.includes('growth') || norm.includes('doanh thu'))) ||
    (norm.includes('theo thang') && (norm.includes('doanh thu') || norm.includes('tang truong')))
  ) {
    return {
      prompt,
      intent: 'monthly_revenue_mom_growth',
      targetTable: 'vn_retail_pos_50k',
      requiredSampleDataset: 'vn_retail_pos_50k',
      confidence: 0.96,
      matchedTokens: ['monthly', 'revenue', 'mom_growth', 'LAG()'],
      explanationEn:
        'Aggregating monthly Vietnam Retail POS revenue & gross margin with SQL LAG() window functions to compute Month-over-Month (MoM) growth %.',
      explanationVi:
        'Tổng hợp doanh thu & biên lợi nhuận POS Việt Nam theo từng tháng, dùng hàm cửa sổ LAG() tính tỷ lệ tăng trưởng MoM%.',
      sql: `WITH monthly_rev AS (
  SELECT
    order_month,
    COUNT(*) AS order_count,
    ROUND(SUM(revenue_vnd), 0) AS revenue_vnd,
    ROUND(SUM(gross_margin_vnd), 0) AS gross_margin_vnd
  FROM vn_retail_pos_50k
  GROUP BY order_month
)
SELECT
  order_month,
  order_count,
  revenue_vnd,
  gross_margin_vnd,
  LAG(revenue_vnd) OVER (ORDER BY order_month) AS prev_month_vnd,
  ROUND(
    100.0 * (revenue_vnd - LAG(revenue_vnd) OVER (ORDER BY order_month))
    / NULLIF(LAG(revenue_vnd) OVER (ORDER BY order_month), 0),
    2
  ) AS mom_growth_pct
FROM monthly_rev
ORDER BY order_month ASC;`,
    };
  }

  // 3. Top N Products by Gross Margin / Revenue (Vietnam Retail POS 50K)
  if (
    norm.includes('product') ||
    norm.includes('san pham') ||
    norm.includes('sku') ||
    norm.includes('gross margin') ||
    norm.includes('bien loi nhuan') ||
    norm.includes('loi nhuan') ||
    norm.includes('pos') ||
    norm.includes('retail') ||
    norm.includes('city') ||
    norm.includes('thanh pho')
  ) {
    const groupByCity = norm.includes('city') || norm.includes('thanh pho') || norm.includes('chi nhanh');
    if (groupByCity) {
      return {
        prompt,
        intent: 'retail_city_channel_rollup',
        targetTable: 'vn_retail_pos_50k',
        requiredSampleDataset: 'vn_retail_pos_50k',
        confidence: 0.94,
        matchedTokens: ['city', 'channel', 'revenue_vnd', 'gross_margin_vnd'],
        explanationEn:
          'Rolling up 50,000 Vietnam Retail POS orders by city and omnichannel source to compare gross margin and order volume.',
        explanationVi:
          'Tổng hợp 50.000 đơn hàng POS Việt Nam theo thành phố và kênh bán để đối chiếu doanh thu và biên lợi nhuận.',
        sql: `SELECT
  city,
  channel,
  COUNT(*) AS orders,
  SUM(units_sold) AS total_units,
  ROUND(SUM(revenue_vnd), 0) AS revenue_vnd,
  ROUND(SUM(gross_margin_vnd), 0) AS gross_margin_vnd,
  ROUND(100.0 * SUM(gross_margin_vnd) / NULLIF(SUM(revenue_vnd), 0), 2) AS margin_pct
FROM vn_retail_pos_50k
GROUP BY city, channel
ORDER BY gross_margin_vnd DESC
LIMIT ${extractTopLimit(norm, 24)};`,
      };
    }

    return {
      prompt,
      intent: 'top_products_gross_margin',
      targetTable: 'vn_retail_pos_50k',
      requiredSampleDataset: 'vn_retail_pos_50k',
      confidence: 0.98,
      matchedTokens: [`top ${topN}`, 'product_name', 'gross_margin_vnd'],
      explanationEn: `Ranking top ${topN} retail SKUs by cumulative gross margin (VND) and margin percentage across 50,000 POS orders.`,
      explanationVi: `Xếp hạng top ${topN} sản phẩm theo tổng biên lợi nhuận gộp (VND) và tỷ suất lợi nhuận trên 50.000 đơn POS.`,
      sql: `SELECT
  product_name,
  category,
  SUM(units_sold) AS total_units,
  ROUND(SUM(revenue_vnd), 0) AS revenue_vnd,
  ROUND(SUM(gross_margin_vnd), 0) AS gross_margin_vnd,
  ROUND(100.0 * SUM(gross_margin_vnd) / NULLIF(SUM(revenue_vnd), 0), 2) AS margin_pct
FROM vn_retail_pos_50k
GROUP BY product_name, category
ORDER BY gross_margin_vnd DESC
LIMIT ${topN};`,
    };
  }

  // 4. Supply Chain Freight SLA / Delay / Carrier Telemetry
  if (
    norm.includes('freight') ||
    norm.includes('carrier') ||
    norm.includes('supply chain') ||
    norm.includes('shipment') ||
    norm.includes('van tai') ||
    norm.includes('van chuyen') ||
    norm.includes('nha xe') ||
    norm.includes('cang') ||
    norm.includes('cold chain') ||
    norm.includes('delay')
  ) {
    return {
      prompt,
      intent: 'freight_carrier_sla',
      targetTable: 'supply_chain_freight',
      requiredSampleDataset: 'supply_chain_freight',
      confidence: 0.95,
      matchedTokens: ['carrier', 'transport_mode', 'delay_hours', 'on_time_delivery'],
      explanationEn:
        'Evaluating APAC freight carriers and transport modes by on-time SLA rate, average delay hours, and total freight spend (VND).',
      explanationVi:
        'Đánh giá các nhà vận chuyển và phương thức vận tải APAC theo tỷ lệ giao đúng hạn SLA, giờ trễ trung bình và tổng chi phí VND.',
      sql: `SELECT
  carrier,
  transport_mode,
  COUNT(*) AS shipments,
  ROUND(AVG(transit_hours), 1) AS avg_transit_hrs,
  ROUND(AVG(delay_hours), 2) AS avg_delay_hrs,
  ROUND(SUM(freight_cost_vnd), 0) AS total_freight_vnd,
  ROUND(100.0 * SUM(CASE WHEN on_time_delivery THEN 1 ELSE 0 END) / COUNT(*), 2) AS on_time_pct
FROM supply_chain_freight
GROUP BY carrier, transport_mode
ORDER BY avg_delay_hrs DESC;`,
    };
  }

  // 5. SaaS Cohort / NRR / Expansion summary
  if (norm.includes('cohort') || norm.includes('nrr') || norm.includes('expansion') || norm.includes('mrr') || norm.includes('retention') || norm.includes('giu chan')) {
    return {
      prompt,
      intent: 'saas_cohort_expansion',
      targetTable: 'saas_mrr_cohorts',
      requiredSampleDataset: 'saas_mrr_cohorts',
      confidence: 0.95,
      matchedTokens: ['signup_cohort', 'segment', 'net_mrr_vnd', 'expansion_vnd'],
      explanationEn:
        'Summarizing SaaS signup cohorts across Enterprise, Mid-Market, and Growth segments with base MRR, expansion MRR, and net MRR.',
      explanationVi:
        'Tổng hợp các cohort đăng ký SaaS theo phân khúc với MRR gốc, MRR mở rộng và MRR ròng.',
      sql: `SELECT
  signup_cohort,
  segment,
  COUNT(DISTINCT account_id) AS accounts,
  ROUND(SUM(mrr_vnd), 0) AS base_mrr_vnd,
  ROUND(SUM(expansion_vnd), 0) AS expansion_vnd,
  ROUND(SUM(net_mrr_vnd), 0) AS net_mrr_vnd,
  ROUND(100.0 * SUM(net_mrr_vnd) / NULLIF(SUM(mrr_vnd), 0), 1) AS nrr_pct
FROM saas_mrr_cohorts
GROUP BY signup_cohort, segment
ORDER BY signup_cohort ASC, nrr_pct DESC;`,
    };
  }

  // 6. Existing core lakehouse intents (Voucher, P99 Latency, Rolling 24h, Fraud Burst)
  if (norm.includes('voucher') || norm.includes('promo') || norm.includes('khuyen mai') || norm.includes('ma giam gia')) {
    return {
      prompt,
      intent: 'voucher_abuse_detection',
      targetTable: 'transactions',
      confidence: 0.95,
      matchedTokens: ['voucher_code', 'flagged_anomalies'],
      explanationEn: 'Aggregating voucher redemptions across stores to pinpoint double-spending abuse anomalies.',
      explanationVi: 'Phân tích tốc độ sử dụng mã giảm giá và cảnh báo lạm dụng voucher theo từng cửa hàng.',
      sql: SQL_PRESETS[3].sql,
    };
  }

  if (norm.includes('p99') || norm.includes('latency') || norm.includes('do tre') || norm.includes('sla')) {
    return {
      prompt,
      intent: 'p99_latency_sla',
      targetTable: 'transactions',
      confidence: 0.94,
      matchedTokens: ['QUANTILE_CONT', 'p99_ms', 'latency_ms'],
      explanationEn: 'Computing P50, P95, and P99 settlement latency percentiles by region and category.',
      explanationVi: 'Tính toán phân vị độ trễ P50, P95 và P99 theo khu vực và nhóm giao dịch.',
      sql: SQL_PRESETS[2].sql,
    };
  }

  if (norm.includes('rolling') || norm.includes('24h') || norm.includes('hourly') || norm.includes('theo gio')) {
    return {
      prompt,
      intent: 'rolling_24h_trend',
      targetTable: 'transactions',
      confidence: 0.93,
      matchedTokens: ['DATE_TRUNC', 'rolling_24h_avg_usd'],
      explanationEn: 'Building hourly volume series with a 24-hour rolling window average.',
      explanationVi: 'Xây dựng chuỗi khối lượng giao dịch theo giờ với trung bình trượt 24 giờ.',
      sql: SQL_PRESETS[4].sql,
    };
  }

  if (norm.includes('store') || norm.includes('cua hang') || norm.includes('burst')) {
    return {
      prompt,
      intent: 'fraud_burst_stores',
      targetTable: 'transactions',
      confidence: 0.92,
      matchedTokens: ['store_id', 'risk_score >= 0.80'],
      explanationEn: 'Isolating retail stores with elevated high-risk fraud bursts ranked by exposed USD.',
      explanationVi: 'Tách lọc các cửa hàng có cụm gian lận rủi ro cao theo tổng giá trị phơi nhiễm USD.',
      sql: SQL_PRESETS[1].sql,
    };
  }

  // 7. Dynamic Schema-Aware Compiler for Custom Uploaded Tables
  for (const tbl of registeredTables) {
    if (tbl.name !== 'transactions' && norm.includes(tbl.name.toLowerCase())) {
      const dimCol = tbl.columns.find((c) => /VARCHAR|CHAR|TEXT/i.test(c.type))?.name;
      const numCol = tbl.columns.find((c) => /DOUBLE|FLOAT|INT|DECIMAL/i.test(c.type))?.name;
      if (dimCol && numCol) {
        return {
          prompt,
          intent: 'custom_table_aggregation',
          targetTable: tbl.name,
          confidence: 0.9,
          matchedTokens: [tbl.name, dimCol, numCol],
          explanationEn: `Compiled schema-aware aggregation on uploaded table "${tbl.name}" grouping by ${dimCol} and summing ${numCol}.`,
          explanationVi: `Biên dịch truy vấn tổng hợp tự động theo schema bảng "${tbl.name}", nhóm theo ${dimCol} và tính tổng ${numCol}.`,
          sql: `SELECT
  ${dimCol},
  COUNT(*) AS record_count,
  ROUND(SUM(${numCol}), 2) AS total_${numCol},
  ROUND(AVG(${numCol}), 2) AS avg_${numCol}
FROM "${tbl.name}"
GROUP BY ${dimCol}
ORDER BY total_${numCol} DESC
LIMIT ${topN};`,
        };
      }
      return {
        prompt,
        intent: 'custom_table_preview',
        targetTable: tbl.name,
        confidence: 0.88,
        matchedTokens: [tbl.name],
        explanationEn: `Inspecting top ${topN} rows from registered table "${tbl.name}".`,
        explanationVi: `Xem trước ${topN} dòng đầu tiên từ bảng "${tbl.name}".`,
        sql: `SELECT * FROM "${tbl.name}" LIMIT ${topN};`,
      };
    }
  }

  // 8. Default: Regional Fraud & Revenue Rollup on core transactions table
  return {
    prompt,
    intent: 'regional_fraud_rollup',
    targetTable: 'transactions',
    confidence: 0.89,
    matchedTokens: ['region', 'gross_volume_usd', 'anomaly_rate_pct'],
    explanationEn:
      'Executing regional transaction rollup across gross volume, ticket average, mean risk score, and anomaly rate.',
    explanationVi:
      'Tổng hợp giao dịch theo khu vực gồm tổng doanh số, giá trị trung bình, điểm rủi ro và tỷ lệ bất thường.',
    sql: SQL_PRESETS[0].sql,
  };
}
