import React, { useMemo, useRef, useState } from 'react';
import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  Database,
  FileUp,
  HardDrive,
  Plus,
  Search,
  Sparkles,
  Table2,
  Trash2,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import type { LocalSemanticVectorIndex } from '../engine/vectorIndex';
import type {
  SavedNotebook,
  StorageTelemetry,
  TableSchemaInfo,
} from '../types/lakehouse';

interface SidebarCatalogProps {
  copy: CopyDict;
  tables: TableSchemaInfo[];
  notebooks: SavedNotebook[];
  vectorIndex: LocalSemanticVectorIndex;
  storageTelemetry: StorageTelemetry;
  onSelectSql: (sql: string, autoRun?: boolean) => void;
  onUploadFile: (fileName: string, content: string) => Promise<void>;
  onSaveCurrentNotebook: () => void;
  onDeleteNotebook: (id: string) => void;
  onClearStorage: () => void;
}

const SAMPLE_CSV = `merchant_id,region,tier,monthly_gmv_usd,chargeback_bps
MCH-001,APAC-VN,ENTERPRISE,482000,14
MCH-002,APAC-SG,ENTERPRISE,619500,8
MCH-003,NA-WEST,GROWTH,275400,31
MCH-004,NA-EAST,ENTERPRISE,540100,19
MCH-005,EU-CENTRAL,GROWTH,312800,11
MCH-006,APAC-VN,GROWTH,198300,47`;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const SidebarCatalog: React.FC<SidebarCatalogProps> = ({
  copy,
  tables,
  notebooks,
  vectorIndex,
  storageTelemetry,
  onSelectSql,
  onUploadFile,
  onSaveCurrentNotebook,
  onDeleteNotebook,
  onClearStorage,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({
    transactions: true,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const semanticHits = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return vectorIndex.search(searchQuery, 6);
  }, [searchQuery, vectorIndex]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    if (!file.name.toLowerCase().endsWith('.csv') && !file.name.toLowerCase().endsWith('.json')) {
      setUploadStatus('Only .csv or .json files supported');
      return;
    }
    const text = await file.text();
    await onUploadFile(file.name, text);
    setUploadStatus(`Ingested ${file.name}`);
  };

  const handleLoadSampleCsv = async () => {
    await onUploadFile('merchant_tiers.csv', SAMPLE_CSV);
    setUploadStatus('Ingested merchant_tiers.csv (6 rows)');
  };

  return (
    <aside className="w-full lg:w-[272px] shrink-0 flex flex-col nexus-hairline-r bg-[var(--bg-surface)] overflow-hidden">
      {/* Semantic Vector Search */}
      <div className="p-3 nexus-hairline-b">
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-mono-tech text-[10px] tracking-wider uppercase text-[var(--text-muted)] flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-[var(--accent-cyan)]" />
            128-D VECTOR CATALOG
          </span>
          <span className="font-mono-tech text-[9px] text-[var(--text-muted)]">COSINE</span>
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            data-testid="semantic-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={copy.semanticSearchPlaceholder}
            className="w-full pl-8 pr-2.5 py-1.5 rounded text-xs bg-[var(--bg-inset)] border border-[var(--border-hairline)] focus:border-[var(--accent-cyan)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
        </div>

        {semanticHits.length > 0 && (
          <div
            data-testid="semantic-search-results"
            className="mt-2 space-y-1 max-h-48 overflow-y-auto pr-0.5"
          >
            {semanticHits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => {
                  if (hit.sqlSnippet) onSelectSql(hit.sqlSnippet, true);
                }}
                className="w-full text-left p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)] transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-medium text-[var(--text-primary)] truncate">
                    {hit.title}
                  </span>
                  <span className="font-mono-tech text-[10px] px-1 rounded bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] shrink-0">
                    {hit.score.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-0.5 gap-2">
                  <span className="text-[10px] text-[var(--text-muted)] truncate">
                    {hit.subtitle}
                  </span>
                  <span className="font-mono-tech text-[9px] uppercase text-[var(--text-muted)] shrink-0">
                    {hit.kind}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Scrollable Middle: Tables + Drag-Drop + Notebooks */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Tables Catalog */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-mono-tech text-[10px] tracking-wider uppercase text-[var(--text-muted)] flex items-center gap-1.5">
              <Database className="w-3 h-3" />
              {copy.tablesSection}
            </h2>
            <span className="font-mono-tech text-[10px] text-[var(--text-muted)]">
              {tables.length} TBL
            </span>
          </div>

          <div className="space-y-1.5">
            {tables.map((tbl) => {
              const isOpen = !!expandedTables[tbl.name];
              return (
                <div
                  key={tbl.name}
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedTables((prev) => ({ ...prev, [tbl.name]: !prev[tbl.name] }))
                    }
                    className="w-full px-2 py-1.5 flex items-center justify-between text-left hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isOpen ? (
                        <ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                      ) : (
                        <ChevronRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                      )}
                      <Table2 className="w-3 h-3 text-[var(--accent-cyan)] shrink-0" />
                      <span className="font-mono-tech text-[11px] font-medium text-[var(--text-primary)] truncate">
                        {tbl.name}
                      </span>
                    </div>
                    <span className="font-mono-tech text-[10px] text-[var(--text-muted)] shrink-0 ml-1">
                      {tbl.rowCount >= 1000
                        ? `${Math.round(tbl.rowCount / 1000)}K`
                        : tbl.rowCount}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="px-2 pb-1.5 pt-1 border-t border-[var(--border-hairline)] space-y-0.5">
                      {tbl.columns.map((col) => (
                        <button
                          key={col.name}
                          type="button"
                          onClick={() =>
                            onSelectSql(
                              `SELECT ${col.name}, COUNT(*) AS cnt FROM "${tbl.name}" GROUP BY ${col.name} ORDER BY cnt DESC LIMIT 30;`,
                              true,
                            )
                          }
                          className="w-full flex items-center justify-between px-1.5 py-0.5 rounded hover:bg-[var(--bg-elevated)] text-left transition-colors cursor-pointer"
                        >
                          <span className="font-mono-tech text-[10px] text-[var(--text-secondary)] truncate">
                            {col.name}
                          </span>
                          <span className="font-mono-tech text-[9px] text-[var(--text-muted)]">
                            {col.type}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Drag-and-Drop CSV/JSON Ingest */}
        <section>
          <div
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
            className={`p-2.5 rounded border border-dashed text-center transition-colors cursor-pointer ${
              isDragging
                ? 'border-[var(--accent-signal)] bg-[var(--accent-signal-soft)]'
                : 'border-[var(--border-strong)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)]'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json"
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
            <FileUp className="w-4 h-4 mx-auto text-[var(--accent-cyan)] mb-1" />
            <p className="text-[11px] text-[var(--text-secondary)] leading-snug">
              {copy.dropCsvJson}
            </p>
            {uploadStatus && (
              <p className="font-mono-tech text-[10px] text-[var(--accent-emerald)] mt-1">
                {uploadStatus}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleLoadSampleCsv()}
            className="mt-1.5 w-full py-1 px-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            + Ingest Sample merchant_tiers.csv
          </button>
        </section>

        {/* Saved Notebooks (IndexedDB) */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-mono-tech text-[10px] tracking-wider uppercase text-[var(--text-muted)] flex items-center gap-1.5">
              <BookMarked className="w-3 h-3" />
              {copy.savedNotebooks}
            </h2>
            <button
              type="button"
              onClick={onSaveCurrentNotebook}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] hover:bg-[var(--accent-signal)] hover:text-white font-mono-tech text-[10px] text-[var(--text-secondary)] transition-colors cursor-pointer"
            >
              <Plus className="w-2.5 h-2.5" />
              {copy.saveNotebook}
            </button>
          </div>

          <div className="space-y-1.5">
            {notebooks.map((nb) => (
              <div
                key={nb.id}
                className="group p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] transition-colors"
              >
                <div className="flex items-start justify-between gap-1">
                  <button
                    type="button"
                    onClick={() => onSelectSql(nb.sql, true)}
                    className="text-left min-w-0 flex-1 cursor-pointer"
                  >
                    <p className="text-[11px] font-medium text-[var(--text-primary)] truncate">
                      {nb.title}
                    </p>
                    <p className="font-mono-tech text-[9px] text-[var(--text-muted)] mt-0.5">
                      {nb.tags.map((t) => `#${t}`).join(' ')}
                    </p>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${nb.title}`}
                    onClick={() => onDeleteNotebook(nb.id)}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--accent-signal)] opacity-60 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Persistent Local Storage Telemetry Footer */}
      <div className="p-3 nexus-hairline-t bg-[var(--bg-inset)]">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono-tech text-[10px] text-[var(--text-muted)] flex items-center gap-1.5">
            <HardDrive className="w-3 h-3 text-[var(--accent-emerald)]" />
            {storageTelemetry.backend}
          </span>
          <button
            type="button"
            onClick={onClearStorage}
            className="font-mono-tech text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-signal)] transition-colors cursor-pointer"
          >
            {copy.clearStorage}
          </button>
        </div>
        <div className="flex items-center justify-between font-mono-tech text-[10px] text-[var(--text-secondary)]">
          <span>
            {storageTelemetry.notebooksCount} NB · {storageTelemetry.uploadedTablesCount} UPL
          </span>
          <span>{formatBytes(storageTelemetry.usageBytes)}</span>
        </div>
      </div>
    </aside>
  );
};
