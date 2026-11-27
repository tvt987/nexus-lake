import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  FileUp,
  Layers,
  Play,
  Sparkles,
  Table2,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import { ENTERPRISE_SAMPLE_CATALOG } from '../engines/ingestionEngine';
import type {
  ColumnProfile,
  EnterpriseSampleId,
  InferredColumnType,
  Locale,
  TableSchemaInfo,
} from '../types/lakehouse';

interface DataIngestStudioProps {
  copy: CopyDict;
  locale: Locale;
  tables: TableSchemaInfo[];
  isIngesting: boolean;
  onUploadFile: (fileName: string, content: string) => Promise<void>;
  onLoadEnterpriseSample: (sampleId: EnterpriseSampleId, openNotebook?: boolean) => Promise<void>;
  onQueryTableInNotebook: (tableName: string, sql: string) => void;
}

const TYPE_BADGE_STYLE: Record<InferredColumnType, string> = {
  Numeric: 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] border-[var(--accent-cyan)]/35',
  String: 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-strong)]',
  Date: 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] border-[var(--accent-emerald)]/35',
  Boolean: 'bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] border-[var(--accent-signal)]/35',
};

function formatStat(val: number | string | undefined): string {
  if (val === undefined) return '--';
  if (typeof val === 'number') {
    if (Math.abs(val) >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
    if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
    if (Math.abs(val) >= 10_000) return `${(val / 1_000).toFixed(1)}K`;
    return Number.isInteger(val) ? val.toLocaleString('en-US') : val.toFixed(2);
  }
  return val.length > 18 ? `${val.slice(0, 17)}..` : val;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const DataIngestStudio: React.FC<DataIngestStudioProps> = ({
  copy,
  locale,
  tables,
  isIngesting,
  onUploadFile,
  onLoadEnterpriseSample,
  onQueryTableInNotebook,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    null,
  );
  const [selectedTableName, setSelectedTableName] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const profiledTables = useMemo(
    () => tables.filter((t) => Boolean(t.profile)),
    [tables],
  );

  const activeTable = useMemo(() => {
    const picked = tables.find((t) => t.name === selectedTableName);
    if (picked) return picked;
    if (profiledTables.length > 0) return profiledTables[profiledTables.length - 1];
    return tables[0] ?? null;
  }, [profiledTables, selectedTableName, tables]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.json') && !lower.endsWith('.ndjson')) {
      setStatusMessage({
        kind: 'err',
        text:
          locale === 'vi'
            ? 'Chỉ hỗ trợ tệp .csv, .json hoặc .ndjson.'
            : 'Only .csv, .json, or .ndjson files are supported.',
      });
      return;
    }

    try {
      const content = await file.text();
      await onUploadFile(file.name, content);
      const cleanName = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      setSelectedTableName(cleanName);
      setStatusMessage({
        kind: 'ok',
        text:
          locale === 'vi'
            ? `Đã nạp & phân tích lược đồ thành công tệp ${file.name} vào DuckDB-WASM.`
            : `Successfully profiled & registered ${file.name} into DuckDB-WASM.`,
      });
    } catch (err) {
      setStatusMessage({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleLoadSample = async (sampleId: EnterpriseSampleId) => {
    try {
      await onLoadEnterpriseSample(sampleId, false);
      setSelectedTableName(sampleId);
      setStatusMessage({
        kind: 'ok',
        text:
          locale === 'vi'
            ? `Đã nạp bảng doanh nghiệp "${sampleId}" vào DuckDB-WASM kèm hồ sơ thống kê cột.`
            : `Mounted enterprise dataset "${sampleId}" into DuckDB-WASM with full column stats.`,
      });
    } catch (err) {
      setStatusMessage({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const activeProfile = activeTable?.profile;

  return (
    <div data-testid="data-ingest-studio" className="space-y-4">
      {/* Top Row: Dropzone + 3 Enterprise Sample Datasets */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Drag-and-Drop CSV/JSON Dropzone */}
        <section className="xl:col-span-5 nexus-panel rounded-md overflow-hidden flex flex-col">
          <div className="px-3.5 py-2 nexus-hairline-b bg-[var(--bg-surface)] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileUp className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <h2 className="font-mono-tech text-[11px] font-semibold tracking-wide text-[var(--text-primary)] m-0">
                {copy.ingestStudioTitle}
              </h2>
            </div>
            <span className="font-mono-tech text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]">
              RFC-4180 + NDJSON
            </span>
          </div>

          <div className="p-4 flex-1 flex flex-col justify-between gap-3 bg-[var(--bg-inset)]">
            <div
              data-testid="ingest-dropzone"
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                void handleFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`flex-1 min-h-[168px] p-5 rounded-md border-2 border-dashed flex flex-col items-center justify-center text-center gap-2.5 transition-all cursor-pointer ${
                isDragging
                  ? 'border-[var(--accent-signal)] bg-[var(--accent-signal-soft)]'
                  : 'border-[var(--border-strong)] bg-[var(--bg-surface)] hover:border-[var(--accent-cyan)]'
              }`}
            >
              <input
                ref={fileInputRef}
                data-testid="ingest-file-input"
                type="file"
                accept=".csv,.json,.ndjson"
                className="hidden"
                onChange={(e) => void handleFiles(e.target.files)}
              />
              <div className="w-10 h-10 rounded-full bg-[var(--accent-cyan-soft)] border border-[var(--accent-cyan)]/35 flex items-center justify-center">
                <FileSpreadsheet className="w-5 h-5 text-[var(--accent-cyan)]" />
              </div>
              <div className="space-y-1 max-w-sm">
                <p className="text-xs font-semibold text-[var(--text-primary)] m-0">
                  {copy.ingestDropHeadline}
                </p>
                <p className="text-[11px] text-[var(--text-muted)] leading-relaxed m-0">
                  {copy.ingestDropSub}
                </p>
              </div>
              <span className="font-mono-tech text-[10px] px-2.5 py-1 rounded bg-[var(--bg-elevated)] border border-[var(--border-hairline)] text-[var(--accent-cyan)]">
                {isIngesting ? 'PROFILING & MOUNTING...' : '.CSV · .JSON · .NDJSON'}
              </span>
            </div>

            {statusMessage && (
              <div
                data-testid="ingest-status-banner"
                className={`px-3 py-2 rounded border font-mono-tech text-[10.5px] flex items-center gap-2 ${
                  statusMessage.kind === 'ok'
                    ? 'border-[var(--accent-emerald)]/40 bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]'
                    : 'border-[var(--accent-signal)]/40 bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]'
                }`}
              >
                {statusMessage.kind === 'ok' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                )}
                <span>{statusMessage.text}</span>
              </div>
            )}
          </div>
        </section>

        {/* 3 Instant 1-Click Enterprise Sample Datasets */}
        <section className="xl:col-span-7 nexus-panel rounded-md overflow-hidden flex flex-col">
          <div className="px-3.5 py-2 nexus-hairline-b bg-[var(--bg-surface)] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-[var(--accent-signal)]" />
              <h2 className="font-mono-tech text-[11px] font-semibold tracking-wide text-[var(--text-primary)] m-0">
                {copy.sampleDatasetsTitle}
              </h2>
            </div>
            <span className="font-mono-tech text-[9.5px] text-[var(--text-muted)]">
              ARROW IPC ZERO-COPY
            </span>
          </div>

          <div className="p-3.5 grid grid-cols-1 md:grid-cols-3 gap-3 bg-[var(--bg-inset)] flex-1">
            {ENTERPRISE_SAMPLE_CATALOG.map((sample) => {
              const mounted = tables.some((t) => t.name === sample.tableName);
              return (
                <div
                  key={sample.id}
                  data-testid={`sample-card-${sample.id}`}
                  className={`p-3 rounded-md border flex flex-col justify-between gap-3 bg-[var(--bg-surface)] transition-colors ${
                    mounted
                      ? 'border-[var(--accent-emerald)]/50'
                      : 'border-[var(--border-hairline)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="font-mono-tech text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold">
                        {sample.badge}
                      </span>
                      <span className="font-mono-tech text-[9.5px] text-[var(--text-muted)]">
                        {sample.rowCountLabel}
                      </span>
                    </div>
                    <h3 className="font-display font-bold text-xs text-[var(--text-primary)] m-0">
                      {locale === 'vi' ? sample.titleVi : sample.titleEn}
                    </h3>
                    <p className="text-[11px] text-[var(--text-muted)] leading-snug m-0">
                      {locale === 'vi' ? sample.descriptionVi : sample.descriptionEn}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <button
                      type="button"
                      data-testid={`load-sample-${sample.id}`}
                      disabled={isIngesting}
                      onClick={() => void handleLoadSample(sample.id)}
                      className={`w-full py-1.5 px-2.5 rounded font-mono-tech text-[10.5px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 ${
                        mounted
                          ? 'border border-[var(--accent-emerald)] bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]'
                          : 'bg-[var(--accent-signal)] hover:brightness-110 text-white'
                      }`}
                    >
                      <Database className="w-3 h-3" />
                      <span>
                        {mounted
                          ? locale === 'vi'
                            ? 'Đã Nạp · Xem Hồ Sơ'
                            : 'Mounted · Inspect'
                          : locale === 'vi'
                            ? 'Nạp 1-Click'
                            : '1-Click Ingest'}
                      </span>
                    </button>

                    {mounted && (
                      <button
                        type="button"
                        data-testid={`query-sample-${sample.id}`}
                        onClick={() => onQueryTableInNotebook(sample.tableName, sample.starterSql)}
                        className="w-full py-1 px-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center justify-center gap-1 cursor-pointer"
                      >
                        <Play className="w-2.5 h-2.5 fill-current" />
                        <span>{locale === 'vi' ? 'Mở trong Sổ Tay SQL' : 'Query in Notebook'}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Bottom Panel: Column Schema & Statistical Profiler */}
      <section className="nexus-panel rounded-md overflow-hidden">
        <div className="px-3.5 py-2 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
            <h2 className="font-mono-tech text-[11px] font-semibold tracking-wide text-[var(--text-primary)] m-0">
              {copy.schemaProfilerTitle}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {tables.map((t) => {
              const selected = activeTable?.name === t.name;
              return (
                <button
                  key={t.name}
                  type="button"
                  data-testid={`profiler-table-tab-${t.name}`}
                  onClick={() => setSelectedTableName(t.name)}
                  className={`px-2 py-0.5 rounded font-mono-tech text-[10px] border flex items-center gap-1.5 transition-colors cursor-pointer ${
                    selected
                      ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  <Table2 className="w-3 h-3" />
                  <span>{t.name}</span>
                  <span className="text-[9px] opacity-75">({t.rowCount.toLocaleString()})</span>
                </button>
              );
            })}
          </div>
        </div>

        {activeProfile ? (
          <div data-testid="column-profiler-table" className="bg-[var(--bg-inset)]">
            {/* Dataset Profile Summary Strip */}
            <div className="px-3.5 py-2.5 nexus-hairline-b grid grid-cols-2 sm:grid-cols-5 gap-2.5 bg-[var(--bg-surface)]/50">
              {[
                { label: 'TABLE NAME', value: activeProfile.tableName, tone: 'text-[var(--accent-cyan)]' },
                { label: 'TOTAL ROWS', value: activeProfile.rowCount.toLocaleString(), tone: 'text-[var(--text-primary)]' },
                { label: 'COLUMNS', value: `${activeProfile.columnCount} cols`, tone: 'text-[var(--text-primary)]' },
                { label: 'PARSE & PROFILE', value: `${activeProfile.parseMs.toFixed(1)} ms`, tone: 'text-[var(--accent-emerald)]' },
                { label: 'ESTIMATED SIZE', value: formatBytes(activeProfile.estimatedBytes), tone: 'text-[var(--accent-signal)]' },
              ].map((s) => (
                <div
                  key={s.label}
                  className="p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]"
                >
                  <div className="font-mono-tech text-[9px] text-[var(--text-muted)]">{s.label}</div>
                  <div className={`font-mono-tech text-xs font-semibold mt-0.5 truncate ${s.tone}`}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Detailed Per-Column Stats Table */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left font-mono-tech text-[10.5px]">
                <thead className="bg-[var(--bg-elevated)] nexus-hairline-b">
                  <tr className="text-[9.5px] uppercase tracking-wider text-[var(--text-muted)]">
                    <th className="px-3 py-2">Column</th>
                    <th className="px-3 py-2">Inferred Type</th>
                    <th className="px-3 py-2 text-right">Nulls</th>
                    <th className="px-3 py-2 text-right">Cardinality</th>
                    <th className="px-3 py-2 text-right">Min</th>
                    <th className="px-3 py-2 text-right">P50 / Mean</th>
                    <th className="px-3 py-2 text-right">P95</th>
                    <th className="px-3 py-2 text-right">Max</th>
                    <th className="px-3 py-2">Top Values / Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {activeProfile.columns.map((col: ColumnProfile) => (
                    <tr
                      key={col.name}
                      className="border-b border-[var(--border-hairline)] hover:bg-[var(--bg-elevated)]/60 transition-colors"
                    >
                      <td className="px-3 py-2 font-semibold text-[var(--text-primary)] whitespace-nowrap">
                        {col.name}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[9.5px] font-semibold ${TYPE_BADGE_STYLE[col.inferredType]}`}
                        >
                          {col.inferredType}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <span
                          className={
                            col.nullCount > 0
                              ? 'text-[var(--accent-signal)] font-semibold'
                              : 'text-[var(--accent-emerald)]'
                          }
                        >
                          {col.nullCount.toLocaleString()} ({col.nullRatePct}%)
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--text-primary)] whitespace-nowrap">
                        {col.cardinality.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--text-secondary)] whitespace-nowrap">
                        {formatStat(col.min)}
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--text-secondary)] whitespace-nowrap">
                        {col.inferredType === 'Numeric'
                          ? `${formatStat(col.p50)} / ${formatStat(col.mean)}`
                          : '--'}
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--accent-cyan)] font-semibold whitespace-nowrap">
                        {col.inferredType === 'Numeric' ? formatStat(col.p95) : '--'}
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--text-secondary)] whitespace-nowrap">
                        {formatStat(col.max)}
                      </td>
                      <td className="px-3 py-2 text-[var(--text-muted)] max-w-[260px] truncate">
                        {col.topValues && col.topValues.length > 0
                          ? col.topValues.map((tv) => `${tv.value} (${tv.count})`).join(' · ')
                          : col.sampleValues.join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center bg-[var(--bg-inset)] space-y-2">
            <p className="font-mono-tech text-xs text-[var(--text-secondary)] m-0">
              {locale === 'vi'
                ? 'Chọn một bộ dữ liệu mẫu 1-Click hoặc kéo thả tệp CSV/JSON ở trên để kích hoạt Column Statistical Profiler (Min / P50 / P95 / Max / Nulls / Cardinality).'
                : 'Load any 1-Click Enterprise Sample Dataset or drop a local CSV/JSON file above to unlock the full Column Statistical Profiler (Min / P50 / P95 / Max / Nulls / Cardinality).'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
};
