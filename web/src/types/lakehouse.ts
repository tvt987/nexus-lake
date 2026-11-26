export type ThemeMode = 'dark' | 'light';
export type Locale = 'en' | 'vi';
export type EngineBackend = 'DUCKDB-WASM' | 'FALLBACK-OLAP';
export type RendererBackend = 'WEBGPU WGSL' | 'WEBGL2 FALLBACK' | 'CANVAS2D FALLBACK';
export type WorkspaceTab = 'workbench' | 'multiplayer' | 'architecture';

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

export interface TableSchemaInfo {
  name: string;
  rowCount: number;
  source: 'synthetic' | 'uploaded';
  columns: { name: string; type: string }[];
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
