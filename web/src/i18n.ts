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
  // v3.0 ENTERPRISE SUPER VIP PRO copy
  tabIngest: string;
  tabCohorts: string;
  enterpriseLicenseBtn: string;
  enterpriseModalTitle: string;
  enterpriseModalSubtitle: string;
  nl2sqlTitle: string;
  nl2sqlPlaceholder: string;
  nl2sqlCompileRun: string;
  notebookTitle: string;
  addCell: string;
  runAllCells: string;
  viewGrid: string;
  viewChart: string;
  viewPivot: string;
  viewPlan: string;
  pivotRowDim: string;
  pivotColDim: string;
  pivotMetric: string;
  pivotAgg: string;
  ingestStudioTitle: string;
  ingestDropHeadline: string;
  ingestDropSub: string;
  sampleDatasetsTitle: string;
  schemaProfilerTitle: string;
  cohortStudioTitle: string;
  cohortMonthly: string;
  cohortWeekly: string;
  cohortRetentionMode: string;
  cohortNrrMode: string;
  cohortExpansionMode: string;
  // v4.0 FULL-STACK MEDALLION LINEAGE & COST INSPECTOR
  tabLineage: string;
  lineageTitle: string;
  lineageRefreshAll: string;
  costInspectorTitle: string;
  // v5.0 DAYLIGHT ANALYTICS & DATA QUALITY CONTRACTS
  tabQuality: string;
  qualityTitle: string;
  themeDaylight: string;
  themeObsidian: string;
}

export const COPY: Record<Locale, CopyDict> = {
  en: {
    subtitle: 'DAYLIGHT ANALYTICS STUDIO · DATA QUALITY & DUCKDB-WASM LAKEHOUSE',
    tabWorkbench: 'SQL Notebook',
    tabQuality: 'Data Quality',
    tabLineage: 'Schema Lineage',
    tabIngest: 'Ingest & Profiler',
    tabCohorts: 'Cohorts',
    tabMultiplayer: 'CRDT Lab',
    tabArchitecture: 'Architecture',
    cmdPalette: 'Command',
    datasetScale: 'Rows',
    semanticSearchPlaceholder: 'Semantic vector search (e.g. fraud spikes by region)...',
    tablesSection: 'LAKEHOUSE CATALOG',
    dropCsvJson: 'Drop CSV or JSON to profile & ingest into DuckDB-WASM',
    savedNotebooks: 'LOCAL NOTEBOOKS (IDB)',
    saveNotebook: 'Save',
    storageTitle: 'LOCAL STORAGE',
    clearStorage: 'Reset',
    runQuery: 'Run Query',
    exportCsv: 'CSV BOM',
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
    enterpriseLicenseBtn: 'Enterprise · 14.9M',
    enterpriseModalTitle: 'ENTERPRISE LAKEHOUSE COMMISSIONING',
    enterpriseModalSubtitle:
      'Deploy NEXUS LAKE v5.0 Daylight Analytics Studio (Python FastAPI + DuckDB-WASM + Data Quality Contracts) inside your VPC with full source ownership, MCP Server & Principal Architect support.',
    nl2sqlTitle: 'NL-TO-SQL COPILOT (OFFLINE VI/EN)',
    nl2sqlPlaceholder:
      'Ask in English or Vietnamese: e.g. "Top 10 products by gross margin" or "Churned enterprise accounts > 50M VND"...',
    nl2sqlCompileRun: 'Compile & Run',
    notebookTitle: 'MULTI-CELL INTERACTIVE SQL NOTEBOOK',
    addCell: 'Add Cell',
    runAllCells: 'Run All',
    viewGrid: 'Data Grid',
    viewChart: 'SVG Chart',
    viewPivot: 'Pivot Matrix',
    viewPlan: 'EXPLAIN Plan',
    pivotRowDim: 'Rows',
    pivotColDim: 'Columns',
    pivotMetric: 'Metric',
    pivotAgg: 'Agg',
    ingestStudioTitle: 'LOCAL CSV / JSON INGESTION & COLUMN PROFILER',
    ingestDropHeadline: 'Drag & drop any local .csv or .json file here, or click to browse',
    ingestDropSub:
      '100% browser-local execution: automatic Numeric / String / Date / Boolean inference, null counts, cardinality & P95 quantiles.',
    sampleDatasetsTitle: '1-CLICK ENTERPRISE SAMPLE DATASETS',
    schemaProfilerTitle: 'COLUMN SCHEMA & STATISTICAL PROFILER',
    cohortStudioTitle: 'LIVE COHORT RETENTION & EXPANSION HEATMAP',
    cohortMonthly: 'Monthly (M0-M6)',
    cohortWeekly: 'Weekly (W0-W6)',
    cohortRetentionMode: 'Logo Retention %',
    cohortNrrMode: 'Net Revenue Retention %',
    cohortExpansionMode: 'Expansion MRR (VND)',
    lineageTitle: 'MEDALLION DATA LINEAGE & SCHEMA ERD',
    lineageRefreshAll: 'Refresh All Layers',
    costInspectorTitle: 'MATERIALIZED VIEW REFRESH & QUERY PLAN COST',
    qualityTitle: 'DATA QUALITY & FRESHNESS SLA CONTRACTS',
    themeDaylight: 'Daylight',
    themeObsidian: 'Obsidian',
  },
  vi: {
    subtitle: 'DAYLIGHT ANALYTICS STUDIO · HỢP ĐỒNG CHẤT LƯỢNG & DUCKDB-WASM',
    tabWorkbench: 'Sổ Tay SQL',
    tabQuality: 'Chất Lượng Dữ Liệu',
    tabLineage: 'Lineage & ERD',
    tabIngest: 'Nạp Dữ Liệu',
    tabCohorts: 'Cohort',
    tabMultiplayer: 'Lab CRDT',
    tabArchitecture: 'Kiến Trúc',
    cmdPalette: 'Lệnh nhanh',
    datasetScale: 'Dòng dữ liệu',
    semanticSearchPlaceholder: 'Tìm vector ngữ nghĩa (vd: fraud spikes by region)...',
    tablesSection: 'DANH MỤC LAKEHOUSE',
    dropCsvJson: 'Kéo thả CSV hoặc JSON để phân tích & nạp vào DuckDB-WASM',
    savedNotebooks: 'SỔ SQL CỤC BỘ (IDB)',
    saveNotebook: 'Lưu SQL',
    storageTitle: 'LƯU TRỮ CỤC BỘ',
    clearStorage: 'Đặt lại',
    runQuery: 'Chạy SQL',
    exportCsv: 'CSV BOM',
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
    enterpriseLicenseBtn: 'Bản Quyền · 14.9M',
    enterpriseModalTitle: 'TRIỂN KHAI BẢN QUYỀN DOANH NGHIỆP',
    enterpriseModalSubtitle:
      'Sở hữu trọn bộ mã nguồn NEXUS LAKE v5.0 Full-Stack (Python FastAPI + DuckDB-WASM + Hợp đồng Chất lượng dbt) triển khai nội bộ VPC cùng MCP Server & hỗ trợ Solution Architect.',
    nl2sqlTitle: 'TRỢ LÝ NL-TO-SQL OFFLINE (VI/EN)',
    nl2sqlPlaceholder:
      'Nhập câu hỏi Tiếng Việt/Anh: vd "Top 10 sản phẩm biên lợi nhuận cao nhất" hoặc "Tài khoản doanh nghiệp rời bỏ > 50 triệu VND"...',
    nl2sqlCompileRun: 'Biên Dịch & Chạy',
    notebookTitle: 'SỔ TAY SQL TƯƠNG TÁC ĐA Ô (MULTI-CELL)',
    addCell: 'Thêm Ô SQL',
    runAllCells: 'Chạy Tất Cả',
    viewGrid: 'Bảng Dữ Liệu',
    viewChart: 'Biểu Đồ SVG',
    viewPivot: 'Ma Trận Pivot',
    viewPlan: 'Kế Hoạch EXPLAIN',
    pivotRowDim: 'Hàng',
    pivotColDim: 'Cột',
    pivotMetric: 'Chỉ Số',
    pivotAgg: 'Hàm',
    ingestStudioTitle: 'NẠP DỮ LIỆU CSV / JSON & PHÂN TÍCH HỒ SƠ CỘT',
    ingestDropHeadline: 'Kéo thả tệp .csv hoặc .json cục bộ vào đây, hoặc nhấn để chọn tệp',
    ingestDropSub:
      'Chạy 100% tại trình duyệt: tự suy luận kiểu Numeric / String / Date / Boolean, đếm null, cardinality & phân vị P95.',
    sampleDatasetsTitle: '3 BỘ DỮ LIỆU DOANH NGHIỆP 1-CLICK',
    schemaProfilerTitle: 'LƯỢC ĐỒ CỘT & THỐNG KÊ CHUYÊN SÂU',
    cohortStudioTitle: 'BẢN ĐỒ NHIỆT GIỮ CHÂN COHORT & MỞ RỘNG DOANH THU',
    cohortMonthly: 'Theo Tháng (M0-M6)',
    cohortWeekly: 'Theo Tuần (W0-W6)',
    cohortRetentionMode: 'Giữ Chân Logo %',
    cohortNrrMode: 'Mở Rộng Doanh Thu NRR %',
    cohortExpansionMode: 'MRR Mở Rộng (VND)',
    lineageTitle: 'ĐỒ THỊ LINEAGE MEDALLION & LƯỢC ĐỒ ERD',
    lineageRefreshAll: 'Làm Mới Toàn Bộ Tầng',
    costInspectorTitle: 'LÀM MỚI MATERIALIZED VIEW & CHI PHÍ TRUY VẤN',
    qualityTitle: 'HỢP ĐỒNG CHẤT LƯỢNG DỮ LIỆU & SLA ĐỘ TƯƠI',
    themeDaylight: 'Daylight',
    themeObsidian: 'Obsidian',
  },
};
