export type ThemeMode = 'dark' | 'light';
export type Locale = 'en' | 'vi';
export type EngineBackend = 'DUCKDB-WASM' | 'FALLBACK-OLAP';
export type RendererBackend = 'WEBGPU WGSL' | 'WEBGL2 FALLBACK' | 'CANVAS2D FALLBACK';
export type WorkspaceTab =
  | 'workbench'
  | 'quality'
  | 'lineage'
  | 'ingest'
  | 'cohorts'
  | 'multiplayer'
  | 'architecture';

export type RegionCode = 'APAC-VN' | 'APAC-SG' | 'NA-WEST' | 'NA-EAST' | 'EU-CENTRAL';

export type CategoryCode =
  | 'RETAIL_POS'
  | 'VOUCHER_REDEEM'
  | 'FLASH_SALE'
  | 'SUBSCRIPTION'
  | 'B2B_SETTLEMENT';

export interface ColumnarTransactions {
  rowCount: number;
  generationMs: number;
  txId: string[];
  tsMs: Float64Array;
  storeId: Uint16Array;
  regionIdx: Uint8Array;
  categoryIdx: Uint8Array;
  amountUsd: Float32Array;
  riskScore: Float32Array;
  latencyMs: Uint16Array;
  voucherIdx: Int8Array; // -1 = null
  isAnomaly: Uint8Array;
  xCoord: Float32Array; // normalized [0, 1] for GPU scatter (amount_usd log scale)
  yCoord: Float32Array; // normalized [0, 1] for GPU scatter (risk_score / latency blend)
  // Pre-packed interleaved Float32Array for zero-copy WebGPU / WebGL2 upload:
  // stride 6 floats per point: [x, y, risk, regionIdx, timeNorm, isAnomaly]
  gpuVertexBuffer: Float32Array;
}

export type InferredColumnType = 'Numeric' | 'String' | 'Date' | 'Boolean';

export interface ColumnProfile {
  name: string;
  inferredType: InferredColumnType;
  sqlType: string;
  rowCount: number;
  nullCount: number;
  nullRatePct: number;
  cardinality: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  p50?: number;
  p95?: number;
  topValues?: { value: string; count: number }[];
  sampleValues: string[];
}

export interface DatasetProfile {
  tableName: string;
  sourceName: string;
  format: 'csv' | 'json' | 'sample';
  rowCount: number;
  columnCount: number;
  parseMs: number;
  estimatedBytes: number;
  ingestedAt: string;
  columns: ColumnProfile[];
}

export type EnterpriseSampleId =
  | 'vn_retail_pos_50k'
  | 'saas_mrr_cohorts'
  | 'supply_chain_freight';

export interface TableSchemaInfo {
  name: string;
  rowCount: number;
  source: 'synthetic' | 'uploaded' | 'sample';
  columns: { name: string; type: string }[];
  profile?: DatasetProfile;
}

export interface SqlQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  scannedRows: number;
  executionMs: number;
  rowsPerSec: number;
  engine: EngineBackend;
  sql: string;
  error?: string;
}

export interface SqlPreset {
  id: string;
  label: string;
  shortTag: string;
  description: string;
  sql: string;
}

export interface SavedNotebook {
  id: string;
  title: string;
  sql: string;
  updatedAt: string;
  tags: string[];
}

export interface SemanticCatalogHit {
  id: string;
  kind: 'table' | 'column' | 'preset' | 'notebook';
  title: string;
  subtitle: string;
  score: number;
  sqlSnippet?: string;
}

export interface StorageTelemetry {
  backend: 'IndexedDB + OPFS' | 'IndexedDB' | 'Memory';
  notebooksCount: number;
  uploadedTablesCount: number;
  pinnedWidgetsCount: number;
  usageBytes: number;
  quotaBytes: number;
}

export interface GpuFilterState {
  riskThreshold: number;
  regionMask: number; // 5-bit mask for 5 regions (0b11111 = all)
  timeWindowPct: number; // 10..100 (% of latest timeline)
  yAxisMode: 'risk_score' | 'latency_ms';
  pointSize: number;
}

export interface GpuTelemetry {
  renderer: RendererBackend;
  fps: number;
  totalPoints: number;
  visiblePoints: number;
  anomalyPoints: number;
  frameTimeMs: number;
  shaderCompileMs: number;
}

export type AguiEventType =
  | 'RUN_STARTED'
  | 'STEP_STARTED'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_RESULT'
  | 'STATE_DELTA'
  | 'UI_WIDGET_EMIT'
  | 'TEXT_MESSAGE_CONTENT'
  | 'RUN_FINISHED';

export interface AguiWireEvent {
  id: string;
  seq: number;
  timestamp: string;
  type: AguiEventType;
  payload: Record<string, unknown>;
}

export interface RegionalBarMetric {
  region: string;
  value: number;
  anomalies: number;
  avgRisk: number;
}

export type GenerativeWidget =
  | {
      id: string;
      kind: 'kpi_anomaly_alert';
      title: string;
      anomalyCount: number;
      anomalyRatePct: number;
      totalExposureUsd: number;
      p99LatencyMs: number;
      severity: 'critical' | 'elevated' | 'nominal';
    }
  | {
      id: string;
      kind: 'regional_bar_chart';
      title: string;
      unit: string;
      bars: RegionalBarMetric[];
    }
  | {
      id: string;
      kind: 'sql_explain_plan';
      title: string;
      sql: string;
      engine: EngineBackend;
      executionMs: number;
      scannedRows: number;
      guardrailStatus: 'VERIFIED_READ_ONLY';
      operators: string[];
    }
  | {
      id: string;
      kind: 'compact_table';
      title: string;
      columns: string[];
      rows: Record<string, unknown>[];
    };

export interface ByokConfig {
  provider: 'local-planner' | 'gemini' | 'openai';
  apiKey: string;
  model: string;
}

export interface BrushSelectionBounds {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  minAmountUsd: number;
  maxAmountUsd: number;
  minRiskScore: number;
  maxRiskScore: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  yAxisMode: 'risk_score' | 'latency_ms';
  activeRegions: RegionCode[];
}

export interface BrushedClusterMetrics {
  selectedPoints: number;
  totalVisiblePoints: number;
  shareOfVisiblePct: number;
  avgAmountUsd: number;
  totalVolumeUsd: number;
  anomalyCount: number;
  anomalyRatePct: number;
  avgRiskScore: number;
  avgLatencyMs: number;
  bounds: BrushSelectionBounds;
}

export type WorkbenchSubTab = 'results' | 'chart' | 'plan' | 'history';
export type AutoChartType = 'bar' | 'area' | 'metric';

export interface AutoChartPoint {
  label: string;
  value: number;
  secondaryValue?: number;
  isHighlighted?: boolean;
}

export interface AutoChartModel {
  recommendedType: AutoChartType;
  labelColumn: string;
  numericColumns: string[];
  metricColumn: string;
  secondaryMetricColumn?: string;
  points: AutoChartPoint[];
  summary: {
    min: number;
    max: number;
    avg: number;
    sum: number;
    count: number;
  };
}

export interface QueryPlanStage {
  id: string;
  operator: string;
  detail: string;
  estimatedRowsIn: number;
  estimatedRowsOut: number;
  timingMs: number;
  sharePct: number;
  vectorized: boolean;
}

export interface ArrowColumnBufferStat {
  column: string;
  arrowType: string;
  bytes: number;
  sharePct: number;
  encoding: 'FIXED_WIDTH' | 'UTF8_OFFSET' | 'BITPACKED_BOOL';
}

export interface QueryPlanAnalysis {
  stages: QueryPlanStage[];
  rawExplainText: string;
  source: 'DUCKDB_EXPLAIN' | 'VECTORIZED_ANALYZER';
  totalExecutionMs: number;
  rowsPerSec: number;
  scannedRows: number;
  returnedRows: number;
  arrowTotalBytes: number;
  arrowBuffers: ArrowColumnBufferStat[];
  estimatedScanRows: number;
  partitionPruningRatio: number;
  memoryFootprintMb: number;
}

export type QueryHistorySource =
  | 'manual'
  | 'preset'
  | 'brush'
  | 'copilot'
  | 'cdc'
  | 'peer'
  | 'notebook'
  | 'nl2sql';

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  label: string;
  executedAt: string;
  executionMs: number;
  rowCount: number;
  scannedRows: number;
  engine: EngineBackend;
  pinned: boolean;
  source: QueryHistorySource;
  error?: string;
}

export interface CdcTelemetryState {
  isStreaming: boolean;
  topicName: string;
  currentRateTxSec: number;
  totalIngestedRows: number;
  totalBurstAnomalies: number;
  batchCount: number;
  lastIngestMs: number;
  lastBatchAnomalies: number;
  burstAlertActive: boolean;
  rateHistory: number[];
}

export interface LakehouseSnapshotPayload {
  version: string;
  exportedAt: string;
  engine: EngineBackend;
  totalRows: number;
  activeSql: string;
  cdcTelemetry: CdcTelemetryState;
  activeBrushBounds: BrushSelectionBounds | null;
  queryResult: {
    columns: string[];
    rowCount: number;
    scannedRows: number;
    executionMs: number;
    rowsPerSec: number;
    rows: Record<string, unknown>[];
  } | null;
  queryHistory: QueryHistoryEntry[];
}

export type PivotAggregation = 'SUM' | 'AVG' | 'COUNT' | 'MAX';

export interface PivotConfig {
  rowDim: string;
  colDim: string;
  metricCol: string;
  aggregation: PivotAggregation;
}

export interface PivotCellValue {
  value: number;
  count: number;
}

export interface PivotMatrixResult {
  config: PivotConfig;
  rowKeys: string[];
  colKeys: string[];
  matrix: Record<string, Record<string, PivotCellValue>>;
  rowTotals: Record<string, number>;
  colTotals: Record<string, number>;
  grandTotal: number;
  minCellValue: number;
  maxCellValue: number;
  truncatedCols: number;
}

export type NotebookCellViewMode = 'grid' | 'chart' | 'pivot' | 'plan';

export interface NotebookCell {
  id: string;
  title: string;
  sql: string;
  viewMode: NotebookCellViewMode;
  result: SqlQueryResult | null;
  rawExplainText: string | null;
  isRunning: boolean;
  lastExecutedAt: string | null;
  pivotConfig?: PivotConfig;
  collapsed?: boolean;
}

export type CohortGranularity = 'monthly' | 'weekly';
export type CohortMetricMode = 'retention_pct' | 'nrr_pct' | 'expansion_vnd';
export type CohortSegmentFilter = 'ALL' | 'Enterprise' | 'Mid-Market' | 'Growth';

export interface CohortCellMetric {
  periodIndex: number;
  activeAccounts: number;
  churnedAccounts: number;
  retentionPct: number;
  baseMrrVnd: number;
  netMrrVnd: number;
  expansionVnd: number;
  nrrPct: number;
}

export interface CohortRowData {
  cohortLabel: string;
  cohortSize: number;
  initialMrrVnd: number;
  cells: (CohortCellMetric | null)[];
}

export interface CohortHeatmapModel {
  granularity: CohortGranularity;
  segment: CohortSegmentFilter;
  periods: string[];
  rows: CohortRowData[];
  summary: {
    totalAccounts: number;
    avgM3RetentionPct: number;
    avgLatestNrrPct: number;
    totalExpansionMrrVnd: number;
    churnedMrrAtRiskVnd: number;
  };
}

export interface NlSqlTranslation {
  prompt: string;
  intent: string;
  sql: string;
  targetTable: string;
  requiredSampleDataset?: EnterpriseSampleId;
  confidence: number;
  explanationEn: string;
  explanationVi: string;
  matchedTokens: string[];
}

// v4.0 Medallion Data Lineage, Schema ERD & Query Cost Inspector Types
export type MedallionLayer = 'bronze' | 'silver' | 'gold';
export type LineageNodeKind = 'stream' | 'table' | 'materialized_view';
export type LineageRefreshState = 'fresh' | 'stale' | 'refreshed';
export type LineageQualityGrade = 'A' | 'B' | 'C';

export interface LineageColumnSchema {
  name: string;
  type: string;
  isPk?: boolean;
  isFk?: boolean;
  fkTarget?: string;
  nullRatePct: number;
}

export interface LineageTableNode {
  id: string;
  name: string;
  layer: MedallionLayer;
  kind: LineageNodeKind;
  description: string;
  rowCount: number;
  sizeMb: number;
  nullRatePct: number;
  qualityGrade: LineageQualityGrade;
  freshnessSec: number;
  partitionKey: string;
  partitionCount: number;
  refreshState: LineageRefreshState;
  lastRefreshedAt: string;
  sourceTableRef: string;
  sampleSql: string;
  columns: LineageColumnSchema[];
  // Deterministic SVG ERD Canvas coordinates
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LineageEdge {
  id: string;
  source: string;
  target: string;
  transformLabel: string;
  joinKey: string;
  edgeType: 'cdc' | 'transform' | 'materialize';
  estimatedRowFlow: number;
}

export interface MedallionLineageGraph {
  nodes: LineageTableNode[];
  edges: LineageEdge[];
  svgWidth: number;
  svgHeight: number;
  summary: {
    totalTables: number;
    bronzeCount: number;
    silverCount: number;
    goldCount: number;
    totalRows: number;
    totalSizeMb: number;
    avgNullRatePct: number;
    staleCount: number;
  };
}

export interface LineageTopologicalValidation {
  acyclic: boolean;
  topologicalOrder: string[];
  cycleNodes: string[];
}

export interface LineageDependencyHighlight {
  selectedId: string | null;
  upstreamNodeIds: string[];
  downstreamNodeIds: string[];
  upstreamEdgeIds: string[];
  downstreamEdgeIds: string[];
  impactedNodeCount: number;
}

export interface QueryPlanCostEstimate {
  targetTableId: string;
  targetLayer: MedallionLayer;
  totalTableRows: number;
  estimatedScanRows: number;
  prunedRows: number;
  partitionPruningRatio: number; // 0..0.95
  memoryFootprintMb: number;
  estimatedLatencyMs: number;
  costTier: 'LOW' | 'MODERATE' | 'HEAVY';
  usedPredicatePushdown: boolean;
  usedPartitionFilter: boolean;
  recommendations: string[];
}

export interface IncrementalRefreshStep {
  nodeId: string;
  tableName: string;
  layer: MedallionLayer;
  deltaRows: number;
  scannedRows: number;
  partitionPruningRatio: number;
  memoryMb: number;
  durationMs: number;
  status: 'COMPLETED';
}

export interface IncrementalRefreshResult {
  graph: MedallionLineageGraph;
  steps: IncrementalRefreshStep[];
  totalDeltaRows: number;
  totalScannedRows: number;
  avgPartitionPruningRatio: number;
  peakMemoryMb: number;
  totalDurationMs: number;
  refreshedAt: string;
}

// v5.0 Data Quality & Freshness SLA Contract Engine (dbt-test / Great Expectations)
export type DataQualityRuleType =
  | 'not_null'
  | 'unique'
  | 'accepted_range'
  | 'referential_integrity'
  | 'freshness_sla_minutes';

export type DataQualityStatus = 'PASS' | 'WARN' | 'CRITICAL_FAIL';
export type DataQualityOverallStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
export type QualityContractTableId = 'bronze_orders' | 'silver_vouchers' | 'gold_store_kpis';
export type QualityChaosId =
  | 'null_store_id'
  | 'duplicate_vouchers'
  | 'kafka_cdc_lag';

export interface DataQualityChaosState {
  nullStoreIdPct: number; // 0 or 1.8
  duplicateVoucherCount: number; // 0 or 412
  kafkaCdcLagMinutes: number; // 0 or 45
  outOfRangeAmountCount: number;
  orphanFkCount: number;
}

export interface DataQualityAssertion {
  ruleId: string;
  table: QualityContractTableId;
  layer: MedallionLayer;
  column: string;
  ruleType: DataQualityRuleType;
  dbtTestName: string;
  geExpectation: string;
  status: DataQualityStatus;
  thresholdLabel: string;
  observedValue: number;
  observedLabel: string;
  failedRows: number;
  quarantinedRows: number;
  slaBreached: boolean;
  weight: number;
  penalty: number;
  remediationSql: string;
}

export interface DataQualitySlaBreach {
  table: QualityContractTableId;
  layer: MedallionLayer;
  observedLagMinutes: number;
  slaLimitMinutes: number;
  excessMinutes: number;
  status: DataQualityStatus;
}

export interface DataQualityTableSummary {
  table: QualityContractTableId;
  layer: MedallionLayer;
  description: string;
  rowCount: number;
  trustScore: number;
  freshnessLagMinutes: number;
  slaLimitMinutes: number;
  passedAssertions: number;
  warnAssertions: number;
  failedAssertions: number;
  quarantinedRows: number;
  status: DataQualityStatus;
}

export interface QualityTimelinePoint {
  hourIndex: number;
  hourLabel: string;
  trustScore: number;
  freshnessLagMinutes: number;
  quarantinedRows: number;
  slaBreached: boolean;
}

export interface DataQualityContractReport {
  dataTrustScore: number;
  overallStatus: DataQualityOverallStatus;
  totalRules: number;
  passedRules: number;
  warnRules: number;
  failedRules: number;
  totalQuarantinedRows: number;
  slaBreachCount: number;
  slaBreaches: DataQualitySlaBreach[];
  tableSummaries: DataQualityTableSummary[];
  assertions: DataQualityAssertion[];
  timeline24h: QualityTimelinePoint[];
  dbtSchemaYaml: string;
  evaluatedAt: string;
  activeChaosIds: QualityChaosId[];
}
