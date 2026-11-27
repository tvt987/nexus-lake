import type {
  IncrementalRefreshResult,
  IncrementalRefreshStep,
  LineageColumnSchema,
  LineageDependencyHighlight,
  LineageEdge,
  LineageQualityGrade,
  LineageTableNode,
  LineageTopologicalValidation,
  MedallionLayer,
  MedallionLineageGraph,
  QueryPlanCostEstimate,
  TableSchemaInfo,
} from '../types/lakehouse';

export const NODE_CARD_WIDTH = 286;
export const NODE_CARD_HEIGHT = 176;
const LAYER_X: Record<MedallionLayer, number> = {
  bronze: 28,
  silver: 392,
  gold: 756,
};
const ROW_START_Y = 58;
const ROW_STEP_Y = 198;

export function gradeQualityFromNullRate(nullRatePct: number): LineageQualityGrade {
  if (nullRatePct < 1.0) return 'A';
  if (nullRatePct < 5.0) return 'B';
  return 'C';
}

function estimateSizeMb(rowCount: number, colCount: number): number {
  const bytesPerRow = Math.max(24, colCount * 11.5);
  return Number(Math.max(0.05, (rowCount * bytesPerRow) / (1024 * 1024)).toFixed(2));
}

function summarizeGraph(
  nodes: LineageTableNode[],
  edges: LineageEdge[],
  svgWidth: number,
  svgHeight: number,
): MedallionLineageGraph {
  const bronzeCount = nodes.filter((n) => n.layer === 'bronze').length;
  const silverCount = nodes.filter((n) => n.layer === 'silver').length;
  const goldCount = nodes.filter((n) => n.layer === 'gold').length;
  const totalRows = nodes.reduce((acc, n) => acc + n.rowCount, 0);
  const totalSizeMb = Number(nodes.reduce((acc, n) => acc + n.sizeMb, 0).toFixed(2));
  const avgNullRatePct =
    nodes.length > 0
      ? Number((nodes.reduce((acc, n) => acc + n.nullRatePct, 0) / nodes.length).toFixed(2))
      : 0;
  const staleCount = nodes.filter((n) => n.refreshState === 'stale').length;

  return {
    nodes,
    edges,
    svgWidth,
    svgHeight,
    summary: {
      totalTables: nodes.length,
      bronzeCount,
      silverCount,
      goldCount,
      totalRows,
      totalSizeMb,
      avgNullRatePct,
      staleCount,
    },
  };
}

function layoutNodes(rawNodes: Omit<LineageTableNode, 'x' | 'y' | 'width' | 'height'>[]): {
  nodes: LineageTableNode[];
  svgWidth: number;
  svgHeight: number;
} {
  const layerBuckets: Record<MedallionLayer, Omit<LineageTableNode, 'x' | 'y' | 'width' | 'height'>[]> = {
    bronze: [],
    silver: [],
    gold: [],
  };

  for (const node of rawNodes) {
    layerBuckets[node.layer].push(node);
  }

  const maxStack = Math.max(
    layerBuckets.bronze.length,
    layerBuckets.silver.length,
    layerBuckets.gold.length,
    1,
  );
  const totalLaneHeight = maxStack * ROW_STEP_Y;
  const positioned: LineageTableNode[] = [];

  for (const layer of ['bronze', 'silver', 'gold'] as MedallionLayer[]) {
    const list = layerBuckets[layer];
    const stackHeight = list.length * ROW_STEP_Y;
    const verticalOffset = Math.round((totalLaneHeight - stackHeight) / 2);

    list.forEach((item, idx) => {
      positioned.push({
        ...item,
        x: LAYER_X[layer],
        y: ROW_START_Y + verticalOffset + idx * ROW_STEP_Y,
        width: NODE_CARD_WIDTH,
        height: NODE_CARD_HEIGHT,
      });
    });
  }

  const svgWidth = LAYER_X.gold + NODE_CARD_WIDTH + 32;
  const svgHeight = Math.max(540, ROW_START_Y + totalLaneHeight + 24);
  return { nodes: positioned, svgWidth, svgHeight };
}

export interface BuildLineageOptions {
  baseTransactionRows?: number;
  refreshedAt?: string;
}

const KNOWN_SAMPLE_TABLES = new Set([
  'transactions',
  'vn_retail_pos_50k',
  'saas_mrr_cohorts',
  'supply_chain_freight',
]);

/**
 * Constructs a deterministic Medallion Lakehouse Lineage & Schema ERD Graph
 * (Bronze Raw -> Silver Cleaned -> Gold KPI Marts) synchronized with live
 * DuckDB-WASM table row counts and any user-uploaded CSV/JSON schemas.
 */
export function buildMedallionLineageGraph(
  catalogTables: TableSchemaInfo[],
  options: BuildLineageOptions = {},
): MedallionLineageGraph {
  const byName = new Map(catalogTables.map((t) => [t.name.toLowerCase(), t]));
  const txRows = Math.max(
    1_000,
    byName.get('transactions')?.rowCount ?? options.baseTransactionRows ?? 100_000,
  );
  const vnPosTable = byName.get('vn_retail_pos_50k');
  const saasTable = byName.get('saas_mrr_cohorts');
  const freightTable = byName.get('supply_chain_freight');

  const vnPosRows = vnPosTable?.rowCount ?? 50_000;
  const saasRows = saasTable?.rowCount ?? 2_450;
  const freightRows = freightTable?.rowCount ?? 6_000;

  const refreshedAt = options.refreshedAt ?? '2026-11-28T00:00:00.000Z';

  const rawNodes: Omit<LineageTableNode, 'x' | 'y' | 'width' | 'height'>[] = [
    // BRONZE LAYER (Raw Ingestion & CDC Streams)
    {
      id: 'bronze_pos_events',
      name: 'bronze_pos_events',
      layer: 'bronze',
      kind: 'stream',
      description: 'Raw Kafka CDC & POS transaction events ingested into DuckDB Arrow IPC buffers.',
      rowCount: txRows,
      sizeMb: estimateSizeMb(txRows, 10),
      nullRatePct: 2.4,
      qualityGrade: gradeQualityFromNullRate(2.4),
      freshnessSec: 12,
      partitionKey: 'region, DATE(ts)',
      partitionCount: 35,
      refreshState: 'fresh',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: 'transactions',
      sampleSql:
        'SELECT tx_id, region, category, amount_usd, risk_score, latency_ms FROM transactions ORDER BY risk_score DESC LIMIT 50;',
      columns: [
        { name: 'tx_id', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'ts', type: 'TIMESTAMP', nullRatePct: 0.0 },
        { name: 'store_id', type: 'VARCHAR', isFk: true, fkTarget: 'bronze_vn_retail_orders.store_id', nullRatePct: 0.2 },
        { name: 'region', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'amount_usd', type: 'DOUBLE', nullRatePct: 0.1 },
        { name: 'voucher_code', type: 'VARCHAR', nullRatePct: 16.5 },
        { name: 'risk_score', type: 'DOUBLE', nullRatePct: 0.0 },
      ],
    },
    {
      id: 'bronze_vn_retail_orders',
      name: 'bronze_vn_retail_orders',
      layer: 'bronze',
      kind: 'table',
      description: 'Vietnam omnichannel POS SKU ledger with revenue, COGS, and VIP member flags.',
      rowCount: vnPosRows,
      sizeMb: estimateSizeMb(vnPosRows, 9),
      nullRatePct: 1.3,
      qualityGrade: gradeQualityFromNullRate(1.3),
      freshnessSec: 95,
      partitionKey: 'city, category',
      partitionCount: 24,
      refreshState: 'fresh',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: vnPosTable ? 'vn_retail_pos_50k' : 'transactions',
      sampleSql: vnPosTable
        ? 'SELECT city, category, SUM(revenue_vnd) AS revenue_vnd, SUM(gross_margin_vnd) AS margin_vnd FROM vn_retail_pos_50k GROUP BY city, category ORDER BY revenue_vnd DESC LIMIT 25;'
        : 'SELECT region, category, COUNT(*) AS orders, ROUND(SUM(amount_usd), 2) AS volume_usd FROM transactions GROUP BY region, category ORDER BY volume_usd DESC;',
      columns: [
        { name: 'order_id', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'store_id', type: 'VARCHAR', nullRatePct: 0.3 },
        { name: 'city', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'product_name', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'revenue_vnd', type: 'DOUBLE', nullRatePct: 0.2 },
        { name: 'gross_margin_vnd', type: 'DOUBLE', nullRatePct: 0.4 },
      ],
    },
    {
      id: 'bronze_saas_subscriptions',
      name: 'bronze_saas_subscriptions',
      layer: 'bronze',
      kind: 'table',
      description: 'Raw B2B SaaS subscription billing snapshots across M0-M6 retention cohorts.',
      rowCount: saasRows,
      sizeMb: estimateSizeMb(saasRows, 8),
      nullRatePct: 0.8,
      qualityGrade: gradeQualityFromNullRate(0.8),
      freshnessSec: 180,
      partitionKey: 'signup_cohort, segment',
      partitionCount: 18,
      refreshState: 'fresh',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: saasTable ? 'saas_mrr_cohorts' : 'transactions',
      sampleSql: saasTable
        ? 'SELECT signup_cohort, segment, COUNT(DISTINCT account_id) AS accounts, ROUND(SUM(net_mrr_vnd), 0) AS net_mrr_vnd FROM saas_mrr_cohorts GROUP BY signup_cohort, segment ORDER BY signup_cohort;'
        : 'SELECT region, COUNT(*) AS accounts, ROUND(SUM(amount_usd), 2) AS recurring_usd FROM transactions WHERE category = \'SUBSCRIPTION\' GROUP BY region;',
      columns: [
        { name: 'record_id', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'account_id', type: 'VARCHAR', isFk: true, nullRatePct: 0.0 },
        { name: 'signup_cohort', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'segment', type: 'VARCHAR', nullRatePct: 0.4 },
        { name: 'mrr_vnd', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'expansion_vnd', type: 'DOUBLE', nullRatePct: 1.9 },
      ],
    },
    {
      id: 'bronze_freight_telemetry',
      name: 'bronze_freight_telemetry',
      layer: 'bronze',
      kind: 'stream',
      description: 'APAC cold-chain, ocean, and air carrier transit telemetry with SLA breach events.',
      rowCount: freightRows,
      sizeMb: estimateSizeMb(freightRows, 8),
      nullRatePct: 3.6,
      qualityGrade: gradeQualityFromNullRate(3.6),
      freshnessSec: 45,
      partitionKey: 'carrier, transport_mode',
      partitionCount: 16,
      refreshState: 'stale',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: freightTable ? 'supply_chain_freight' : 'transactions',
      sampleSql: freightTable
        ? 'SELECT carrier, transport_mode, COUNT(*) AS shipments, ROUND(AVG(delay_hours), 2) AS avg_delay_hrs FROM supply_chain_freight GROUP BY carrier, transport_mode ORDER BY shipments DESC;'
        : 'SELECT region, ROUND(AVG(latency_ms), 2) AS avg_latency_ms, COUNT(*) AS events FROM transactions GROUP BY region ORDER BY avg_latency_ms DESC;',
      columns: [
        { name: 'shipment_id', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'carrier', type: 'VARCHAR', nullRatePct: 0.5 },
        { name: 'transport_mode', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'transit_hours', type: 'DOUBLE', nullRatePct: 1.2 },
        { name: 'delay_hours', type: 'DOUBLE', nullRatePct: 5.4 },
        { name: 'freight_cost_vnd', type: 'DOUBLE', nullRatePct: 0.6 },
      ],
    },

    // SILVER LAYER (Deduplicated, Validated & Enriched)
    {
      id: 'silver_transactions_clean',
      name: 'silver_transactions_clean',
      layer: 'silver',
      kind: 'table',
      description: 'Deduplicated, schema-enforced transaction fact table with normalized risk flags.',
      rowCount: Math.round(txRows * 0.985 + vnPosRows * 0.2),
      sizeMb: estimateSizeMb(Math.round(txRows * 0.985 + vnPosRows * 0.2), 9),
      nullRatePct: 0.35,
      qualityGrade: gradeQualityFromNullRate(0.35),
      freshnessSec: 38,
      partitionKey: 'region, category',
      partitionCount: 25,
      refreshState: 'fresh',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: 'transactions',
      sampleSql:
        'SELECT region, category, COUNT(*) AS clean_tx, ROUND(SUM(amount_usd), 2) AS net_usd, SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) AS anomalies FROM transactions GROUP BY region, category ORDER BY net_usd DESC;',
      columns: [
        { name: 'tx_id', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'store_id', type: 'VARCHAR', isFk: true, fkTarget: 'bronze_pos_events.store_id', nullRatePct: 0.0 },
        { name: 'region', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'category', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'amount_usd', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'is_anomaly', type: 'BOOLEAN', nullRatePct: 0.0 },
        { name: 'latency_ms', type: 'INTEGER', nullRatePct: 0.2 },
      ],
    },
    {
      id: 'silver_customer_accounts',
      name: 'silver_customer_accounts',
      layer: 'silver',
      kind: 'table',
      description: 'Conformed B2B SaaS account ledger with net MRR attribution and churn risk bands.',
      rowCount: Math.max(350, Math.round(saasRows * 0.85)),
      sizeMb: estimateSizeMb(Math.max(350, Math.round(saasRows * 0.85)), 7),
      nullRatePct: 0.22,
      qualityGrade: gradeQualityFromNullRate(0.22),
      freshnessSec: 120,
      partitionKey: 'segment, signup_cohort',
      partitionCount: 12,
      refreshState: 'fresh',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: saasTable ? 'saas_mrr_cohorts' : 'transactions',
      sampleSql: saasTable
        ? 'SELECT segment, COUNT(DISTINCT account_id) AS accounts, ROUND(SUM(net_mrr_vnd), 0) AS total_net_mrr FROM saas_mrr_cohorts GROUP BY segment ORDER BY total_net_mrr DESC;'
        : 'SELECT region, COUNT(*) AS tx_count, ROUND(AVG(amount_usd), 2) AS avg_ticket_usd FROM transactions GROUP BY region ORDER BY tx_count DESC;',
      columns: [
        { name: 'account_id', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'signup_cohort', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'segment', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'net_mrr_vnd', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'is_churned', type: 'BOOLEAN', nullRatePct: 0.0 },
        { name: 'health_band', type: 'VARCHAR', nullRatePct: 0.4 },
      ],
    },
    {
      id: 'silver_logistics_sla',
      name: 'silver_logistics_sla',
      layer: 'silver',
      kind: 'table',
      description: 'Standardized carrier SLA performance table filtering sensor dropouts and GPS drift.',
      rowCount: Math.round(freightRows * 0.96),
      sizeMb: estimateSizeMb(Math.round(freightRows * 0.96), 7),
      nullRatePct: 0.65,
      qualityGrade: gradeQualityFromNullRate(0.65),
      freshnessSec: 165,
      partitionKey: 'carrier',
      partitionCount: 10,
      refreshState: 'stale',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: freightTable ? 'supply_chain_freight' : 'transactions',
      sampleSql: freightTable
        ? 'SELECT carrier, COUNT(*) AS shipments, ROUND(100.0 * SUM(CASE WHEN on_time_delivery THEN 1 ELSE 0 END) / COUNT(*), 2) AS on_time_pct FROM supply_chain_freight GROUP BY carrier ORDER BY on_time_pct DESC;'
        : 'SELECT category, ROUND(AVG(latency_ms), 2) AS avg_latency_ms FROM transactions GROUP BY category ORDER BY avg_latency_ms DESC;',
      columns: [
        { name: 'shipment_id', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'carrier', type: 'VARCHAR', nullRatePct: 0.0 },
        { name: 'on_time_delivery', type: 'BOOLEAN', nullRatePct: 0.0 },
        { name: 'sla_breach_hrs', type: 'DOUBLE', nullRatePct: 0.9 },
        { name: 'freight_cost_vnd', type: 'DOUBLE', nullRatePct: 0.2 },
      ],
    },

    // GOLD LAYER (Materialized Executive KPI Marts)
    {
      id: 'gold_regional_revenue_mart',
      name: 'gold_regional_revenue_mart',
      layer: 'gold',
      kind: 'materialized_view',
      description: 'Materialized KPI cube serving Regional GMV, Fraud Exposure & P99 Settlement SLA.',
      rowCount: 25,
      sizeMb: 0.14,
      nullRatePct: 0.0,
      qualityGrade: 'A',
      freshnessSec: 42,
      partitionKey: 'region',
      partitionCount: 5,
      refreshState: 'fresh',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: 'transactions',
      sampleSql:
        'SELECT region, COUNT(*) AS tx_count, ROUND(SUM(amount_usd), 2) AS gross_volume_usd, ROUND(AVG(risk_score), 4) AS avg_risk_score, SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) AS anomaly_count FROM transactions GROUP BY region ORDER BY gross_volume_usd DESC;',
      columns: [
        { name: 'region', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'category', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'gross_volume_usd', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'anomaly_rate_pct', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'p99_latency_ms', type: 'DOUBLE', nullRatePct: 0.0 },
      ],
    },
    {
      id: 'gold_nrr_cohort_mart',
      name: 'gold_nrr_cohort_mart',
      layer: 'gold',
      kind: 'materialized_view',
      description: 'Materialized Cohort Retention & Net Revenue Retention (NRR %) executive heatmap cube.',
      rowCount: 126,
      sizeMb: 0.21,
      nullRatePct: 0.0,
      qualityGrade: 'A',
      freshnessSec: 135,
      partitionKey: 'signup_cohort',
      partitionCount: 6,
      refreshState: 'fresh',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: saasTable ? 'saas_mrr_cohorts' : 'transactions',
      sampleSql: saasTable
        ? 'SELECT signup_cohort, segment, COUNT(DISTINCT account_id) AS accounts, ROUND(SUM(mrr_vnd), 0) AS base_mrr, ROUND(SUM(net_mrr_vnd), 0) AS net_mrr FROM saas_mrr_cohorts GROUP BY signup_cohort, segment ORDER BY signup_cohort;'
        : 'SELECT region, COUNT(*) AS tx_count, ROUND(SUM(amount_usd), 2) AS gross_volume_usd FROM transactions GROUP BY region ORDER BY gross_volume_usd DESC;',
      columns: [
        { name: 'signup_cohort', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'segment', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'retention_pct', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'nrr_pct', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'expansion_mrr_vnd', type: 'DOUBLE', nullRatePct: 0.0 },
      ],
    },
    {
      id: 'gold_exec_unit_economics',
      name: 'gold_exec_unit_economics',
      layer: 'gold',
      kind: 'materialized_view',
      description: 'Cross-domain CFO Board Mart unifying GMV, SaaS NRR, Fraud Leakage & Carrier Cost.',
      rowCount: 60,
      sizeMb: 0.18,
      nullRatePct: 0.0,
      qualityGrade: 'A',
      freshnessSec: 210,
      partitionKey: 'region, fiscal_month',
      partitionCount: 6,
      refreshState: 'stale',
      lastRefreshedAt: refreshedAt,
      sourceTableRef: 'transactions',
      sampleSql:
        'SELECT region, category, COUNT(*) AS tx_count, ROUND(SUM(amount_usd), 2) AS gross_usd, ROUND(AVG(latency_ms), 1) AS avg_latency_ms FROM transactions GROUP BY region, category ORDER BY gross_usd DESC LIMIT 15;',
      columns: [
        { name: 'region', type: 'VARCHAR', isPk: true, nullRatePct: 0.0 },
        { name: 'net_contribution_usd', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'fraud_leakage_bps', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'blended_nrr_pct', type: 'DOUBLE', nullRatePct: 0.0 },
        { name: 'logistics_sla_pct', type: 'DOUBLE', nullRatePct: 0.0 },
      ],
    },
  ];

  const edges: LineageEdge[] = [
    {
      id: 'e-pos-silver-tx',
      source: 'bronze_pos_events',
      target: 'silver_transactions_clean',
      transformLabel: 'CDC Dedupe + Risk Score',
      joinKey: 'tx_id',
      edgeType: 'cdc',
      estimatedRowFlow: txRows,
    },
    {
      id: 'e-vnpos-silver-tx',
      source: 'bronze_vn_retail_orders',
      target: 'silver_transactions_clean',
      transformLabel: 'Store SKU Enrich',
      joinKey: 'store_id',
      edgeType: 'transform',
      estimatedRowFlow: Math.round(vnPosRows * 0.2),
    },
    {
      id: 'e-saas-silver-acct',
      source: 'bronze_saas_subscriptions',
      target: 'silver_customer_accounts',
      transformLabel: 'MRR Attribution',
      joinKey: 'account_id',
      edgeType: 'transform',
      estimatedRowFlow: saasRows,
    },
    {
      id: 'e-freight-silver-sla',
      source: 'bronze_freight_telemetry',
      target: 'silver_logistics_sla',
      transformLabel: 'SLA Breach Filter',
      joinKey: 'shipment_id',
      edgeType: 'cdc',
      estimatedRowFlow: freightRows,
    },
    {
      id: 'e-silver-tx-gold-rev',
      source: 'silver_transactions_clean',
      target: 'gold_regional_revenue_mart',
      transformLabel: 'GROUP BY Region Cube',
      joinKey: 'region',
      edgeType: 'materialize',
      estimatedRowFlow: Math.round(txRows * 0.985),
    },
    {
      id: 'e-silver-acct-gold-nrr',
      source: 'silver_customer_accounts',
      target: 'gold_nrr_cohort_mart',
      transformLabel: 'Cohort NRR Rollup',
      joinKey: 'signup_cohort',
      edgeType: 'materialize',
      estimatedRowFlow: Math.max(350, Math.round(saasRows * 0.85)),
    },
    {
      id: 'e-silver-tx-gold-nrr',
      source: 'silver_transactions_clean',
      target: 'gold_nrr_cohort_mart',
      transformLabel: 'Billing Verification',
      joinKey: 'region',
      edgeType: 'transform',
      estimatedRowFlow: Math.round(txRows * 0.12),
    },
    {
      id: 'e-silver-tx-gold-exec',
      source: 'silver_transactions_clean',
      target: 'gold_exec_unit_economics',
      transformLabel: 'GMV + Fraud Leakage',
      joinKey: 'region',
      edgeType: 'materialize',
      estimatedRowFlow: Math.round(txRows * 0.985),
    },
    {
      id: 'e-silver-acct-gold-exec',
      source: 'silver_customer_accounts',
      target: 'gold_exec_unit_economics',
      transformLabel: 'SaaS Margin Blend',
      joinKey: 'segment',
      edgeType: 'materialize',
      estimatedRowFlow: Math.max(350, Math.round(saasRows * 0.85)),
    },
    {
      id: 'e-silver-sla-gold-exec',
      source: 'silver_logistics_sla',
      target: 'gold_exec_unit_economics',
      transformLabel: 'Freight Unit Cost',
      joinKey: 'carrier',
      edgeType: 'materialize',
      estimatedRowFlow: Math.round(freightRows * 0.96),
    },
  ];

  // Dynamically append custom user-uploaded CSV/JSON tables to the Bronze layer
  const customUploads = catalogTables.filter(
    (t) => t.source === 'uploaded' && !KNOWN_SAMPLE_TABLES.has(t.name.toLowerCase()),
  );

  for (const tbl of customUploads) {
    const safeId = `bronze_upload_${tbl.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    const cols: LineageColumnSchema[] = tbl.columns.slice(0, 7).map((col, idx) => {
      const prof = tbl.profile?.columns.find((c) => c.name === col.name);
      return {
        name: col.name,
        type: col.type,
        isPk: idx === 0,
        nullRatePct: prof?.nullRatePct ?? 0,
      };
    });
    const avgNull =
      cols.length > 0
        ? Number((cols.reduce((acc, c) => acc + c.nullRatePct, 0) / cols.length).toFixed(2))
        : 0;

    rawNodes.push({
      id: safeId,
      name: tbl.name,
      layer: 'bronze',
      kind: 'table',
      description: `User-ingested local table (${tbl.rowCount.toLocaleString()} rows) profiled in DuckDB-WASM.`,
      rowCount: tbl.rowCount,
      sizeMb: tbl.profile
        ? Number(Math.max(0.02, tbl.profile.estimatedBytes / (1024 * 1024)).toFixed(2))
        : estimateSizeMb(tbl.rowCount, tbl.columns.length),
      nullRatePct: avgNull,
      qualityGrade: gradeQualityFromNullRate(avgNull),
      freshnessSec: 5,
      partitionKey: cols[0]?.name ?? 'rowid',
      partitionCount: Math.max(1, Math.min(16, Math.ceil(tbl.rowCount / 2500))),
      refreshState: 'fresh',
      lastRefreshedAt: tbl.profile?.ingestedAt ?? refreshedAt,
      sourceTableRef: tbl.name,
      sampleSql: `SELECT * FROM "${tbl.name}" LIMIT 100;`,
      columns: cols,
    });

    edges.push({
      id: `e-${safeId}-silver`,
      source: safeId,
      target: 'silver_transactions_clean',
      transformLabel: 'Custom CSV/JSON Merge',
      joinKey: cols[0]?.name ?? 'id',
      edgeType: 'transform',
      estimatedRowFlow: tbl.rowCount,
    });
  }

  const { nodes, svgWidth, svgHeight } = layoutNodes(rawNodes);
  return summarizeGraph(nodes, edges, svgWidth, svgHeight);
}

/**
 * Verifies the lineage graph is a valid Directed Acyclic Graph (DAG) via Kahn's
 * topological sort algorithm and returns exact refresh execution order.
 */
export function validateLineageAcyclic(
  nodes: Pick<LineageTableNode, 'id'>[],
  edges: Pick<LineageEdge, 'source' | 'target'>[],
): LineageTopologicalValidation {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    adjacency.get(edge.source)!.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    topologicalOrder.push(curr);
    for (const next of adjacency.get(curr) ?? []) {
      const nextDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }

  const visited = new Set(topologicalOrder);
  const cycleNodes = [...nodeIds].filter((id) => !visited.has(id));

  return {
    acyclic: cycleNodes.length === 0,
    topologicalOrder,
    cycleNodes,
  };
}

/**
 * Computes full transitive upstream (ancestors) and downstream (dependents) node
 * and edge sets for interactive SVG dependency highlighting.
 */
export function computeLineageDependencyHighlight(
  selectedNodeId: string | null,
  nodes: Pick<LineageTableNode, 'id'>[],
  edges: Pick<LineageEdge, 'id' | 'source' | 'target'>[],
): LineageDependencyHighlight {
  if (!selectedNodeId || !nodes.some((n) => n.id === selectedNodeId)) {
    return {
      selectedId: null,
      upstreamNodeIds: [],
      downstreamNodeIds: [],
      upstreamEdgeIds: [],
      downstreamEdgeIds: [],
      impactedNodeCount: 0,
    };
  }

  const incomingByTarget = new Map<string, Pick<LineageEdge, 'id' | 'source' | 'target'>[]>();
  const outgoingBySource = new Map<string, Pick<LineageEdge, 'id' | 'source' | 'target'>[]>();

  for (const edge of edges) {
    if (!incomingByTarget.has(edge.target)) incomingByTarget.set(edge.target, []);
    incomingByTarget.get(edge.target)!.push(edge);

    if (!outgoingBySource.has(edge.source)) outgoingBySource.set(edge.source, []);
    outgoingBySource.get(edge.source)!.push(edge);
  }

  const upstreamNodes = new Set<string>();
  const upstreamEdges = new Set<string>();
  const upQueue: string[] = [selectedNodeId];
  while (upQueue.length > 0) {
    const curr = upQueue.shift()!;
    for (const edge of incomingByTarget.get(curr) ?? []) {
      upstreamEdges.add(edge.id);
      if (!upstreamNodes.has(edge.source) && edge.source !== selectedNodeId) {
        upstreamNodes.add(edge.source);
        upQueue.push(edge.source);
      }
    }
  }

  const downstreamNodes = new Set<string>();
  const downstreamEdges = new Set<string>();
  const downQueue: string[] = [selectedNodeId];
  while (downQueue.length > 0) {
    const curr = downQueue.shift()!;
    for (const edge of outgoingBySource.get(curr) ?? []) {
      downstreamEdges.add(edge.id);
      if (!downstreamNodes.has(edge.target) && edge.target !== selectedNodeId) {
        downstreamNodes.add(edge.target);
        downQueue.push(edge.target);
      }
    }
  }

  return {
    selectedId: selectedNodeId,
    upstreamNodeIds: [...upstreamNodes],
    downstreamNodeIds: [...downstreamNodes],
    upstreamEdgeIds: [...upstreamEdges],
    downstreamEdgeIds: [...downstreamEdges],
    impactedNodeCount: upstreamNodes.size + downstreamNodes.size + 1,
  };
}

/**
 * Estimates physical query execution cost: scan rows, partition pruning ratio,
 * columnar Arrow + hash-table memory footprint (MB), and optimization advice.
 */
export function estimateQueryPlanCost(
  sql: string,
  graph: MedallionLineageGraph,
  targetNodeId?: string | null,
): QueryPlanCostEstimate {
  const cleanSql = sql.trim();
  const upper = cleanSql.toUpperCase();

  let targetNode =
    (targetNodeId ? graph.nodes.find((n) => n.id === targetNodeId) : undefined) ??
    graph.nodes.find((n) => upper.includes(n.name.toUpperCase())) ??
    graph.nodes.find((n) => upper.includes(n.sourceTableRef.toUpperCase())) ??
    graph.nodes[0];

  if (!targetNode) {
    return {
      targetTableId: 'transactions',
      targetLayer: 'bronze',
      totalTableRows: 0,
      estimatedScanRows: 0,
      prunedRows: 0,
      partitionPruningRatio: 0,
      memoryFootprintMb: 0,
      estimatedLatencyMs: 0,
      costTier: 'LOW',
      usedPredicatePushdown: false,
      usedPartitionFilter: false,
      recommendations: [],
    };
  }

  const totalTableRows = Math.max(1, targetNode.rowCount);
  const hasWhere = /\bWHERE\b/.test(upper);
  const hasLimit = /\bLIMIT\s+(\d+)/.test(upper);
  const hasGroupBy = /\bGROUP\s+BY\b/.test(upper);
  const hasJoin = /\bJOIN\b/.test(upper);
  const hasSelectStar = /SELECT\s+\*/.test(upper);

  const partitionTokens = targetNode.partitionKey
    .split(',')
    .map((k) => k.replace(/DATE\(|\)/gi, '').trim().toUpperCase())
    .filter(Boolean);

  const usedPartitionFilter =
    hasWhere && partitionTokens.some((tok) => new RegExp(`\\b${tok}\\b`, 'i').test(upper));

  let pruningRatio = 0;
  if (usedPartitionFilter) {
    pruningRatio = Math.min(0.88, 0.55 + (targetNode.partitionCount >= 16 ? 0.25 : 0.14));
  } else if (hasWhere) {
    pruningRatio = 0.28;
  } else if (hasLimit && !hasGroupBy && !/\bORDER\s+BY\b/.test(upper)) {
    pruningRatio = 0.65;
  }

  // Gold materialized views are pre-aggregated cubes -> ultra-high effective scan reduction
  if (targetNode.layer === 'gold' && pruningRatio < 0.72) {
    pruningRatio = Math.max(pruningRatio, 0.78);
  }

  pruningRatio = Number(Math.min(0.95, Math.max(0, pruningRatio)).toFixed(3));
  const estimatedScanRows = Math.max(1, Math.round(totalTableRows * (1 - pruningRatio)));
  const prunedRows = Math.max(0, totalTableRows - estimatedScanRows);

  const projectedCols = hasSelectStar
    ? Math.max(6, targetNode.columns.length)
    : Math.max(2, Math.min(targetNode.columns.length, 4));

  const columnarBufferMb = (estimatedScanRows * projectedCols * 9.5) / (1024 * 1024);
  const hashOverheadMb = (hasGroupBy ? 1.8 : 0.4) + (hasJoin ? 3.2 : 0);
  const memoryFootprintMb = Number(Math.max(0.12, columnarBufferMb + hashOverheadMb).toFixed(2));

  const scanSpeedRowsPerMs = targetNode.layer === 'gold' ? 45_000 : 12_500;
  const estimatedLatencyMs = Number(
    Math.max(0.8, estimatedScanRows / scanSpeedRowsPerMs + (hasGroupBy ? 3.4 : 0.9) + (hasJoin ? 4.2 : 0)).toFixed(
      2,
    ),
  );

  const costTier: QueryPlanCostEstimate['costTier'] =
    estimatedScanRows >= 80_000 || memoryFootprintMb >= 14
      ? 'HEAVY'
      : estimatedScanRows >= 20_000 || memoryFootprintMb >= 4
        ? 'MODERATE'
        : 'LOW';

  const recommendations: string[] = [];
  if (hasSelectStar) {
    recommendations.push(
      'Replace SELECT * with explicit column projection to shrink Arrow IPC columnar memory by ~45%.',
    );
  }
  if (!usedPartitionFilter && targetNode.layer !== 'gold') {
    recommendations.push(
      `Add a predicate on partition key (${targetNode.partitionKey}) to unlock 65-85% partition pruning.`,
    );
  }
  if (targetNode.layer === 'bronze' && hasGroupBy) {
    recommendations.push(
      'Route aggregate KPI workloads to gold_regional_revenue_mart materialized view to avoid raw Bronze scans.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Optimal vectorized plan: predicate pushdown and columnar projection are active.',
    );
  }

  return {
    targetTableId: targetNode.id,
    targetLayer: targetNode.layer,
    totalTableRows,
    estimatedScanRows,
    prunedRows,
    partitionPruningRatio: pruningRatio,
    memoryFootprintMb,
    estimatedLatencyMs,
    costTier,
    usedPredicatePushdown: hasWhere,
    usedPartitionFilter,
    recommendations,
  };
}

/**
 * Simulates an incoming CDC burst that marks Bronze source tables and all
 * downstream Silver/Gold dependents as stale so operators can test incremental refresh.
 */
export function injectStaleDelta(
  graph: MedallionLineageGraph,
  extraRows = 4_500,
): MedallionLineageGraph {
  const staleNodes = graph.nodes.map((node) => {
    if (node.layer === 'bronze') {
      const nextRows = node.rowCount + Math.round(extraRows * (node.kind === 'stream' ? 1 : 0.25));
      return {
        ...node,
        rowCount: nextRows,
        sizeMb: estimateSizeMb(nextRows, node.columns.length),
        freshnessSec: node.freshnessSec + 240,
        refreshState: 'stale' as const,
      };
    }
    return {
      ...node,
      freshnessSec: node.freshnessSec + 310,
      refreshState: 'stale' as const,
    };
  });

  return summarizeGraph(staleNodes, graph.edges, graph.svgWidth, graph.svgHeight);
}

/**
 * Simulates a 1-click incremental Materialized View & Medallion Pipeline refresh
 * in strict topological order (Bronze -> Silver -> Gold). If `targetNodeId` is
 * supplied, refreshes only that node and its upstream ancestor lineage chain.
 */
export function simulateIncrementalRefresh(
  graph: MedallionLineageGraph,
  targetNodeId?: string | null,
): IncrementalRefreshResult {
  const topo = validateLineageAcyclic(graph.nodes, graph.edges);
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const refreshedAt = new Date().toISOString();

  let scopeIds: Set<string>;
  if (targetNodeId && nodeMap.has(targetNodeId)) {
    const hl = computeLineageDependencyHighlight(targetNodeId, graph.nodes, graph.edges);
    scopeIds = new Set([targetNodeId, ...hl.upstreamNodeIds]);
  } else {
    scopeIds = new Set(graph.nodes.map((n) => n.id));
  }

  const orderedScope = topo.topologicalOrder.filter((id) => scopeIds.has(id));
  const steps: IncrementalRefreshStep[] = [];
  const updatedById = new Map<string, LineageTableNode>(graph.nodes.map((n) => [n.id, { ...n }]));

  for (const id of orderedScope) {
    const node = updatedById.get(id);
    if (!node) continue;

    const deltaFactor =
      node.layer === 'bronze' ? 0.025 : node.layer === 'silver' ? 0.022 : 0.08;
    const deltaRows =
      node.layer === 'gold'
        ? Math.max(2, Math.round(node.rowCount * deltaFactor))
        : Math.max(45, Math.round(node.rowCount * deltaFactor));

    const pruningRatio =
      node.layer === 'bronze' ? 0.84 : node.layer === 'silver' ? 0.78 : 0.91;
    const scannedRows = Math.max(deltaRows, Math.round(node.rowCount * (1 - pruningRatio)));
    const memoryMb = Number(
      Math.max(0.25, (scannedRows * Math.max(4, node.columns.length) * 8) / (1024 * 1024) + 0.65).toFixed(2),
    );
    const durationMs = Number(
      Math.max(1.8, scannedRows / 18_000 + (node.layer === 'gold' ? 2.4 : 4.1)).toFixed(1),
    );

    const nextRowCount =
      node.layer === 'gold'
        ? node.rowCount
        : node.rowCount + deltaRows;

    const refreshedNode: LineageTableNode = {
      ...node,
      rowCount: nextRowCount,
      sizeMb:
        node.layer === 'gold'
          ? node.sizeMb
          : estimateSizeMb(nextRowCount, node.columns.length),
      freshnessSec: 0,
      refreshState: 'refreshed',
      lastRefreshedAt: refreshedAt,
    };

    updatedById.set(id, refreshedNode);

    steps.push({
      nodeId: id,
      tableName: node.name,
      layer: node.layer,
      deltaRows,
      scannedRows,
      partitionPruningRatio: pruningRatio,
      memoryMb,
      durationMs,
      status: 'COMPLETED',
    });
  }

  const nextNodes = graph.nodes.map((n) => updatedById.get(n.id) ?? n);
  const nextGraph = summarizeGraph(nextNodes, graph.edges, graph.svgWidth, graph.svgHeight);

  const totalDeltaRows = steps.reduce((acc, s) => acc + s.deltaRows, 0);
  const totalScannedRows = steps.reduce((acc, s) => acc + s.scannedRows, 0);
  const avgPartitionPruningRatio =
    steps.length > 0
      ? Number(
          (steps.reduce((acc, s) => acc + s.partitionPruningRatio, 0) / steps.length).toFixed(3),
        )
      : 0;
  const peakMemoryMb = steps.reduce((acc, s) => Math.max(acc, s.memoryMb), 0);
  const totalDurationMs = Number(steps.reduce((acc, s) => acc + s.durationMs, 0).toFixed(1));

  return {
    graph: nextGraph,
    steps,
    totalDeltaRows,
    totalScannedRows,
    avgPartitionPruningRatio,
    peakMemoryMb: Number(peakMemoryMb.toFixed(2)),
    totalDurationMs,
    refreshedAt,
  };
}

/**
 * Generates a smooth cubic Bezier SVG path connecting the right output port of
 * `source` to the left input port of `target`.
 */
export function computeBezierEdgePath(source: LineageTableNode, target: LineageTableNode): {
  d: string;
  midX: number;
  midY: number;
} {
  const x1 = source.x + source.width;
  const y1 = source.y + source.height / 2;
  const x2 = target.x;
  const y2 = target.y + target.height / 2;
  const dx = Math.max(48, (x2 - x1) * 0.48);

  const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  return {
    d,
    midX: (x1 + x2) / 2,
    midY: (y1 + y2) / 2,
  };
}
