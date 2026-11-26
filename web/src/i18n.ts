import type { Locale } from './types/lakehouse';

export interface CopyDict {
  subtitle: string;
  tabWorkbench: string;
  tabMultiplayer: string;
  tabArchitecture: string;
  cmdPalette: string;
  datasetScale: string;
  semanticSearchPlaceholder: string;
  tablesSection: string;
  dropCsvJson: string;
  savedNotebooks: string;
  saveNotebook: string;
  storageTitle: string;
  clearStorage: string;
  runQuery: string;
  exportCsv: string;
  exportJson: string;
  presetsLabel: string;
  gpuCanvasTitle: string;
  shaderInspector: string;
  riskThreshold: string;
  timeWindow: string;
  regionFilter: string;
  copilotPlaceholder: string;
  copilotRun: string;
  wireInspector: string;
  byokSettings: string;
  multiplayerTitle: string;
  multiplayerDesc: string;
  severLink: string;
  reconnectSync: string;
  statusOnline: string;
  statusPartitioned: string;
  // v2.0 VIP PRO copy
  liveCdcLabel: string;
  liveCdcActive: string;
  exportSnapshot: string;
  subtabResults: string;
  subtabChart: string;
  subtabPlan: string;
  subtabHistory: string;
  brushHint: string;
  applyBrushSql: string;
  clearBrush: string;
}

export const COPY: Record<Locale, CopyDict> = {
  en: {
    subtitle: 'LOCAL-FIRST OLAP LAKEHOUSE & AI BI WORKBENCH',
    tabWorkbench: 'SQL + GPU Workbench',
    tabMultiplayer: 'CRDT Multiplayer Lab',
    tabArchitecture: 'MCP + Architecture',
    cmdPalette: 'Command',
    datasetScale: 'Rows',
    semanticSearchPlaceholder: 'Semantic vector search (e.g. fraud spikes by region)...',
    tablesSection: 'LAKEHOUSE CATALOG',
    dropCsvJson: 'Drop CSV or JSON to ingest into DuckDB-WASM',
    savedNotebooks: 'LOCAL NOTEBOOKS (IDB)',
    saveNotebook: 'Save',
    storageTitle: 'LOCAL STORAGE',
    clearStorage: 'Reset',
    runQuery: 'Run Query',
    exportCsv: 'CSV',
    exportJson: 'JSON',
    presetsLabel: 'ANALYTICS PRESETS',
    gpuCanvasTitle: 'HIGH-DENSITY ANOMALY CANVAS',
    shaderInspector: 'WGSL Shaders',
    riskThreshold: 'Risk Threshold',
    timeWindow: 'Time Window',
    regionFilter: 'Regions',
    copilotPlaceholder:
      'Ask Nexus Copilot (EN/VI): e.g. "Show fraud spikes by region" or "Detect voucher abuse"...',
    copilotRun: 'Dispatch',
    wireInspector: 'AG-UI Wire Inspector',
    byokSettings: 'BYOK LLM',
    multiplayerTitle: 'SPLIT MULTIPLAYER & OFFLINE PARTITION CRDT LAB',
    multiplayerDesc:
      'Two independent Yjs Y.Doc replicas synchronized over BroadcastChannel. Sever the network link, introduce conflicting SQL edits simultaneously across Saigon & San Francisco peers, then reconnect to inspect exact CRDT binary delta convergence.',
    severLink: 'Sever Network Link (Offline)',
    reconnectSync: 'Reconnect & Sync CRDT',
    statusOnline: 'MESH LINK CONNECTED',
    statusPartitioned: 'NETWORK PARTITIONED (OFFLINE)',
    liveCdcLabel: 'Live CDC Stream',
    liveCdcActive: 'CDC LIVE',
    exportSnapshot: 'Export SQL + JSON Snapshot',
    subtabResults: 'Results Table',
    subtabChart: 'Auto-Chart',
    subtabPlan: 'Query Plan & Arrow',
    subtabHistory: 'History',
    brushHint: 'DRAG TO LASSO CLUSTER -> SQL',
    applyBrushSql: 'Apply Brush to SQL',
    clearBrush: 'Clear Selection',
  },
  vi: {
    subtitle: 'KHO DỮ LIỆU OLAP LOCAL-FIRST & TRẠM PHÂN TÍCH AI BI',
    tabWorkbench: 'Trạm SQL + WebGPU',
    tabMultiplayer: 'Phòng Lab CRDT Đa Người Dùng',
    tabArchitecture: 'MCP & Kiến Trúc',
    cmdPalette: 'Lệnh nhanh',
    datasetScale: 'Dòng dữ liệu',
    semanticSearchPlaceholder: 'Tìm vector ngữ nghĩa (vd: fraud spikes by region)...',
    tablesSection: 'DANH MỤC LAKEHOUSE',
    dropCsvJson: 'Kéo thả CSV hoặc JSON để nạp vào DuckDB-WASM',
    savedNotebooks: 'SỔ SQL CỤC BỘ (IDB)',
    saveNotebook: 'Lưu SQL',
    storageTitle: 'LƯU TRỮ CỤC BỘ',
    clearStorage: 'Đặt lại',
    runQuery: 'Chạy SQL',
    exportCsv: 'CSV',
    exportJson: 'JSON',
    presetsLabel: 'TRUY VẤN MẪU OLAP',
    gpuCanvasTitle: 'BẢN ĐỒ BẤT THƯỜNG WEBGPU 100K+ ĐIỂM',
    shaderInspector: 'Mã WGSL',
    riskThreshold: 'Ngưỡng Rủi Ro',
    timeWindow: 'Khung Thời Gian',
    regionFilter: 'Khu Vực',
    copilotPlaceholder:
      'Hỏi Nexus Copilot (EN/VI): vd "Thống kê gian lận theo khu vực" hoặc "Phát hiện lạm dụng voucher"...',
    copilotRun: 'Thực thi',
    wireInspector: 'Giám sát AG-UI Wire',
    byokSettings: 'Cấu hình BYOK',
    multiplayerTitle: 'PHÒNG LAB CRDT ĐA NGƯỜI DÙNG & NGẮT KẾT NỐI OFFLINE',
    multiplayerDesc:
      'Hai bản sao Yjs Y.Doc độc lập đồng bộ qua BroadcastChannel. Ngắt kết nối mạng, sửa xung đột SQL đồng thời ở Peer Sài Gòn và San Francisco, sau đó kết nối lại để quan sát Yjs hợp nhất toán học không mất dữ liệu.',
    severLink: 'Ngắt Kết Nối Mạng (Offline)',
    reconnectSync: 'Kết Nối Lại & Hợp Nhất CRDT',
    statusOnline: 'ĐANG ĐỒNG BỘ MESH CRDT',
    statusPartitioned: 'MẤT KẾT NỐI MẠNG (OFFLINE)',
    liveCdcLabel: 'Luồng CDC Trực Tiếp',
    liveCdcActive: 'CDC TRỰC TIẾP',
    exportSnapshot: 'Xuất SQL + JSON Snapshot',
    subtabResults: 'Bảng Kết Quả',
    subtabChart: 'Biểu Đồ Tự Động',
    subtabPlan: 'Kế Hoạch & Arrow',
    subtabHistory: 'Lịch Sử',
    brushHint: 'KÉO CHỌN CỤM -> TẠO SQL',
    applyBrushSql: 'Áp Dụng Vùng Chọn Vào SQL',
    clearBrush: 'Xóa Vùng Chọn',
  },
};
