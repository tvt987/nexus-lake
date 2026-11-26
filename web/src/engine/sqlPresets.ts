import type { SqlPreset } from '../types/lakehouse';

export const SQL_PRESETS: SqlPreset[] = [
  {
    id: 'regional-revenue-rollup',
    label: 'Regional Revenue Rollup',
    shortTag: 'ROLLUP',
    description: 'Volume, transaction count, mean risk score, and anomaly exposure grouped by region.',
    sql: `SELECT
  region,
  COUNT(*) AS tx_count,
  ROUND(SUM(amount_usd), 2) AS gross_volume_usd,
  ROUND(AVG(amount_usd), 2) AS avg_ticket_usd,
  ROUND(AVG(risk_score), 4) AS avg_risk_score,
  SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) AS anomaly_count,
  ROUND(100.0 * SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) / COUNT(*), 2) AS anomaly_rate_pct
FROM transactions
GROUP BY region
ORDER BY gross_volume_usd DESC;`,
  },
  {
    id: 'fraud-burst-window',
    label: 'Fraud Burst Window',
    shortTag: 'FRAUD',
    description: 'High-risk anomaly bursts (risk_score >= 0.80) ranked by financial exposure per store.',
    sql: `SELECT
  store_id,
  region,
  COUNT(*) AS burst_txs,
  ROUND(SUM(amount_usd), 2) AS exposed_usd,
  ROUND(MAX(risk_score), 4) AS peak_risk,
  ROUND(AVG(latency_ms), 1) AS avg_latency_ms
FROM transactions
WHERE risk_score >= 0.80
GROUP BY store_id, region
ORDER BY exposed_usd DESC
LIMIT 40;`,
  },
  {
    id: 'p99-latency-percentiles',
    label: 'P99 Latency Percentiles',
    shortTag: 'SLA P99',
    description: 'P50, P95, and P99 transaction settlement latencies across regions and categories.',
    sql: `SELECT
  region,
  category,
  COUNT(*) AS sample_size,
  ROUND(QUANTILE_CONT(latency_ms, 0.50), 1) AS p50_ms,
  ROUND(QUANTILE_CONT(latency_ms, 0.95), 1) AS p95_ms,
  ROUND(QUANTILE_CONT(latency_ms, 0.99), 1) AS p99_ms
FROM transactions
GROUP BY region, category
ORDER BY p99_ms DESC
LIMIT 25;`,
  },
  {
    id: 'voucher-abuse-detection',
    label: 'Voucher Abuse Detection',
    shortTag: 'VOUCHER',
    description: 'Identifies voucher codes exhibiting double-spend bursts and disproportionate anomaly rates.',
    sql: `SELECT
  voucher_code,
  COUNT(*) AS redemptions,
  COUNT(DISTINCT store_id) AS unique_stores,
  ROUND(SUM(amount_usd), 2) AS redeemed_usd,
  ROUND(AVG(risk_score), 4) AS mean_risk,
  SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) AS flagged_anomalies
FROM transactions
WHERE voucher_code IS NOT NULL
GROUP BY voucher_code
ORDER BY flagged_anomalies DESC, redeemed_usd DESC;`,
  },
  {
    id: 'rolling-24h-moving-avg',
    label: 'Rolling 24h Moving Average',
    shortTag: 'WINDOW',
    description: 'Hourly transaction throughput with 24-hour rolling moving average using SQL window frames.',
    sql: `WITH hourly AS (
  SELECT
    DATE_TRUNC('hour', ts) AS hour_bucket,
    COUNT(*) AS tx_count,
    ROUND(SUM(amount_usd), 2) AS hourly_usd,
    SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) AS anomalies
  FROM transactions
  GROUP BY 1
)
SELECT
  STRFTIME(hour_bucket, '%Y-%m-%d %H:00') AS hour_utc,
  tx_count,
  hourly_usd,
  anomalies,
  ROUND(AVG(hourly_usd) OVER (
    ORDER BY hour_bucket
    ROWS BETWEEN 23 PRECEDING AND CURRENT ROW
  ), 2) AS rolling_24h_avg_usd
FROM hourly
ORDER BY hour_bucket DESC
LIMIT 48;`,
  },
  {
    id: 'anomaly-clusters',
    label: 'Anomaly Clusters',
    shortTag: 'CLUSTER',
    description: 'Top individual high-risk anomaly transactions with coordinates synchronized to WebGPU Canvas.',
    sql: `SELECT
  tx_id,
  STRFTIME(ts, '%Y-%m-%d %H:%M:%S') AS timestamp_utc,
  store_id,
  region,
  category,
  amount_usd,
  risk_score,
  latency_ms,
  COALESCE(voucher_code, 'NONE') AS voucher_code
FROM transactions
WHERE is_anomaly = true
ORDER BY risk_score DESC, amount_usd DESC
LIMIT 250;`,
  },
];
