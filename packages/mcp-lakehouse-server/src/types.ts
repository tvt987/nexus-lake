export type McpScope =
  | 'lakehouse:read'
  | 'lakehouse:anomaly'
  | 'lakehouse:export'
  | 'lakehouse:admin';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface AuthContext {
  subject: string;
  scopes: McpScope[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  subject: string;
  method: string;
  tool?: string;
  status: 'ok' | 'denied' | 'error';
  durationMs: number;
  detail?: string;
}

export interface TransactionRow {
  tx_id: string;
  ts: string;
  store_id: string;
  region: 'APAC-VN' | 'APAC-SG' | 'NA-WEST' | 'NA-EAST' | 'EU-CENTRAL';
  category: 'RETAIL_POS' | 'VOUCHER_REDEEM' | 'FLASH_SALE' | 'SUBSCRIPTION' | 'B2B_SETTLEMENT';
  amount_usd: number;
  risk_score: number;
  latency_ms: number;
  voucher_code: string | null;
  is_anomaly: boolean;
}

export interface QueryExecutionResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  scannedRows: number;
  executionMs: number;
}
