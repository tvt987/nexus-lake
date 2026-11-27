import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Database,
  Filter,
  Gauge,
  GitFork,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import {
  buildMedallionLineageGraph,
  computeBezierEdgePath,
  computeLineageDependencyHighlight,
  estimateQueryPlanCost,
  injectStaleDelta,
  simulateIncrementalRefresh,
  validateLineageAcyclic,
} from '../engines/lineageGraphEngine';
import type {
  IncrementalRefreshResult,
  LineageTableNode,
  Locale,
  MedallionLayer,
  MedallionLineageGraph,
  TableSchemaInfo,
} from '../types/lakehouse';

interface SchemaLineageViewProps {
  copy: CopyDict;
  locale: Locale;
  tables: TableSchemaInfo[];
  baseTransactionRows: number;
  onQueryTableInNotebook: (tableName: string, sql: string) => void;
}

const LAYER_META: Record<
  MedallionLayer,
  { label: string; shortTag: string; stroke: string; fillSoft: string; textClass: string }
> = {
  bronze: {
    label: 'BRONZE · RAW INGEST',
    shortTag: 'BRONZE',
    stroke: 'var(--accent-amber)',
    fillSoft: 'var(--accent-amber-soft)',
    textClass: 'text-[var(--accent-amber)]',
  },
  silver: {
    label: 'SILVER · CONFORMED',
    shortTag: 'SILVER',
    stroke: 'var(--accent-cyan)',
    fillSoft: 'var(--accent-cyan-soft)',
    textClass: 'text-[var(--accent-cyan)]',
  },
  gold: {
    label: 'GOLD · KPI MARTS',
    shortTag: 'GOLD',
    stroke: 'var(--accent-emerald)',
    fillSoft: 'var(--accent-emerald-soft)',
    textClass: 'text-[var(--accent-emerald)]',
  },
};

function formatCompactRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function qualityColor(grade: LineageTableNode['qualityGrade']): string {
  if (grade === 'A') return 'var(--accent-emerald)';
  if (grade === 'B') return 'var(--accent-amber)';
  return 'var(--accent-crimson)';
}

export const SchemaLineageView: React.FC<SchemaLineageViewProps> = ({
  copy,
  locale,
  tables,
  baseTransactionRows,
  onQueryTableInNotebook,
}) => {
  const catalogSignature = useMemo(
    () => tables.map((t) => `${t.name}:${t.rowCount}:${t.columns.length}`).join('|'),
    [tables],
  );

  const [graph, setGraph] = useState<MedallionLineageGraph>(() =>
    buildMedallionLineageGraph(tables, { baseTransactionRows }),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('silver_transactions_clean');
  const [costProbeMode, setCostProbeMode] = useState<'pruned' | 'full'>('pruned');
  const [refreshResult, setRefreshResult] = useState<IncrementalRefreshResult | null>(null);

  useEffect(() => {
    setGraph(buildMedallionLineageGraph(tables, { baseTransactionRows }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogSignature, baseTransactionRows]);

  const topoValidation = useMemo(
    () => validateLineageAcyclic(graph.nodes, graph.edges),
    [graph.nodes, graph.edges],
  );

  const highlight = useMemo(
    () => computeLineageDependencyHighlight(selectedNodeId, graph.nodes, graph.edges),
    [selectedNodeId, graph.nodes, graph.edges],
  );

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );

  const selectedNode =
    (selectedNodeId ? nodeById.get(selectedNodeId) : undefined) ?? graph.nodes[0] ?? null;

  const probeSql = useMemo(() => {
    if (!selectedNode) return 'SELECT * FROM transactions LIMIT 100;';
    const firstPartCol =
      selectedNode.partitionKey.split(',')[0]?.replace(/DATE\(|\)/gi, '').trim() || 'region';
    if (costProbeMode === 'pruned') {
      return `SELECT ${selectedNode.columns
        .slice(0, 3)
        .map((c) => c.name)
        .join(', ')} FROM ${selectedNode.name} WHERE ${firstPartCol} = 'APAC-VN' GROUP BY ${
        selectedNode.columns[0]?.name ?? 'id'
      } LIMIT 100;`;
    }
    return `SELECT * FROM ${selectedNode.name} GROUP BY ${
      selectedNode.columns[0]?.name ?? 'id'
    };`;
  }, [costProbeMode, selectedNode]);

  const costEstimate = useMemo(
    () => estimateQueryPlanCost(probeSql, graph, selectedNode?.id ?? null),
    [probeSql, graph, selectedNode?.id],
  );

  const upstreamSet = useMemo(() => new Set(highlight.upstreamNodeIds), [highlight.upstreamNodeIds]);
  const downstreamSet = useMemo(
    () => new Set(highlight.downstreamNodeIds),
    [highlight.downstreamNodeIds],
  );
  const upstreamEdgeSet = useMemo(
    () => new Set(highlight.upstreamEdgeIds),
    [highlight.upstreamEdgeIds],
  );
  const downstreamEdgeSet = useMemo(
    () => new Set(highlight.downstreamEdgeIds),
    [highlight.downstreamEdgeIds],
  );

  const handleRefreshAll = () => {
    const res = simulateIncrementalRefresh(graph, null);
    setGraph(res.graph);
    setRefreshResult(res);
  };

  const handleRefreshSelected = () => {
    if (!selectedNodeId) return;
    const res = simulateIncrementalRefresh(graph, selectedNodeId);
    setGraph(res.graph);
    setRefreshResult(res);
  };

  const handleInjectStale = () => {
    setGraph((prev) => injectStaleDelta(prev, 4_500));
  };

  return (
    <div data-testid="schema-lineage-view" className="space-y-4">
      {/* Top Toolbar & Pipeline Actions */}
      <section className="nexus-panel rounded-md overflow-hidden">
        <div className="px-3.5 py-2.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <GitFork className="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display font-bold text-sm text-[var(--text-primary)] m-0 truncate">
                  {copy.lineageTitle}
                </h2>
                <span
                  data-testid="lineage-dag-status"
                  className="font-mono-tech text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] border border-[var(--accent-emerald)]/35 font-semibold"
                >
                  {topoValidation.acyclic ? 'ACYCLIC DAG · 3 LAYERS' : 'CYCLE DETECTED'}
                </span>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] m-0 mt-0.5">
                {locale === 'vi'
                  ? 'Nhấp vào bất kỳ bảng nào để làm nổi bật chuỗi phụ thuộc thượng nguồn / hạ nguồn, kiểm tra chất lượng null-rate và mô phỏng làm mới Materialized View.'
                  : 'Click any Medallion table card to trace animated upstream & downstream dependencies, inspect null-rate quality, and simulate incremental refreshes.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {selectedNodeId && (
              <button
                type="button"
                data-testid="lineage-reset-selection-btn"
                onClick={() => setSelectedNodeId(null)}
                className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{locale === 'vi' ? 'Bỏ chọn' : 'Reset Focus'}</span>
              </button>
            )}

            <button
              type="button"
              data-testid="lineage-inject-stale-btn"
              onClick={handleInjectStale}
              className="px-2.5 py-1 rounded border border-[var(--accent-amber)]/50 bg-[var(--bg-inset)] hover:border-[var(--accent-amber)] text-[var(--accent-amber)] font-mono-tech text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
            >
              <AlertTriangle className="w-3 h-3" />
              <span>{locale === 'vi' ? 'Bơm Delta Trễ' : 'Simulate CDC Delta'}</span>
            </button>

            {selectedNodeId && (
              <button
                type="button"
                data-testid="lineage-refresh-selected-btn"
                onClick={handleRefreshSelected}
                className="px-2.5 py-1 rounded border border-[var(--accent-cyan)]/60 bg-[var(--accent-cyan-soft)] hover:brightness-110 text-[var(--accent-cyan)] font-mono-tech text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{locale === 'vi' ? 'Làm mới Chuỗi Chọn' : 'Refresh Chain'}</span>
              </button>
            )}

            <button
              type="button"
              data-testid="lineage-refresh-all-btn"
              onClick={handleRefreshAll}
              className="px-2.5 py-1 rounded bg-[var(--accent-signal)] hover:brightness-110 text-white font-mono-tech text-[10.5px] font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Zap className="w-3 h-3" />
              <span>{copy.lineageRefreshAll}</span>
            </button>
          </div>
        </div>

        {/* Executive Lineage Telemetry KPI Strip */}
        <div className="px-3.5 py-2 nexus-hairline-b bg-[var(--bg-inset)] grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="px-2.5 py-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
            <div className="font-mono-tech text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
              MEDALLION TOPOLOGY
            </div>
            <div className="font-mono-tech text-xs font-bold text-[var(--text-primary)] mt-0.5 tabular-nums">
              {graph.summary.totalTables} Tables ({graph.summary.bronzeCount}B ·{' '}
              {graph.summary.silverCount}S · {graph.summary.goldCount}G)
            </div>
          </div>

          <div className="px-2.5 py-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
            <div className="font-mono-tech text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
              TOTAL LAKEHOUSE VOLUME
            </div>
            <div className="font-mono-tech text-xs font-bold text-[var(--accent-cyan)] mt-0.5 tabular-nums">
              {formatCompactRows(graph.summary.totalRows)} rows · {graph.summary.totalSizeMb} MB
            </div>
          </div>

          <div className="px-2.5 py-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
            <div className="font-mono-tech text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
              AVG NULL-RATE HEALTH
            </div>
            <div className="font-mono-tech text-xs font-bold text-[var(--accent-emerald)] mt-0.5 tabular-nums">
              {graph.summary.avgNullRatePct}% null ·{' '}
              {graph.summary.staleCount === 0
                ? 'ALL FRESH'
                : `${graph.summary.staleCount} STALE`}
            </div>
          </div>

          <div
            data-testid="lineage-highlight-summary"
            className="px-2.5 py-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]"
          >
            <div className="font-mono-tech text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
              DEPENDENCY TRACE
            </div>
            <div className="font-mono-tech text-xs font-bold text-[var(--text-primary)] mt-0.5 tabular-nums">
              {highlight.selectedId ? (
                <span>
                  <span className="text-[var(--accent-cyan)]">
                    {highlight.upstreamNodeIds.length} up
                  </span>
                  {' · '}
                  <span className="text-[var(--accent-signal)]">
                    {highlight.downstreamNodeIds.length} down
                  </span>
                </span>
              ) : (
                <span className="text-[var(--text-muted)]">Click table to trace</span>
              )}
            </div>
          </div>
        </div>

        {/* Interactive Legend */}
        <div className="px-3.5 py-1.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px] text-[var(--text-muted)]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 bg-[var(--accent-cyan)] inline-block" />
              <span>Upstream Ancestors ({highlight.upstreamNodeIds.length})</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 bg-[var(--accent-signal)] inline-block" />
              <span>Downstream Impact ({highlight.downstreamNodeIds.length})</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--accent-emerald)] inline-block" />
              <span>Quality Grade A (&lt;1% null)</span>
            </span>
          </div>
          <span>TOPOLOGICAL ORDER: {topoValidation.topologicalOrder.length} STAGES</span>
        </div>

        {/* Interactive SVG Medallion ERD & Lineage Graph */}
        <div className="p-3 bg-[var(--bg-inset)] overflow-x-auto">
          <svg
            data-testid="schema-lineage-svg"
            viewBox={`0 0 ${graph.svgWidth} ${graph.svgHeight}`}
            className="w-full min-w-[920px] h-auto block select-none"
            role="img"
            aria-label="Interactive Medallion Lakehouse Data Lineage and Schema ERD Graph"
          >
            <defs>
              <marker
                id="lineage-arrow-idle"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--border-strong)" />
              </marker>
              <marker
                id="lineage-arrow-up"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--accent-cyan)" />
              </marker>
              <marker
                id="lineage-arrow-down"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--accent-signal)" />
              </marker>
            </defs>

            {/* 3 Medallion Column Lane Backdrops */}
            {(
              [
                { layer: 'bronze' as const, x: 14, width: 314 },
                { layer: 'silver' as const, x: 378, width: 314 },
                { layer: 'gold' as const, x: 742, width: 314 },
              ]
            ).map((lane) => {
              const meta = LAYER_META[lane.layer];
              return (
                <g key={lane.layer}>
                  <rect
                    x={lane.x}
                    y={12}
                    width={lane.width}
                    height={graph.svgHeight - 24}
                    rx="8"
                    fill="var(--bg-surface)"
                    fillOpacity="0.42"
                    stroke="var(--border-hairline)"
                    strokeDasharray="4 4"
                  />
                  <rect
                    x={lane.x + 12}
                    y={22}
                    width={lane.width - 24}
                    height={24}
                    rx="4"
                    fill={meta.fillSoft}
                    stroke={meta.stroke}
                    strokeOpacity="0.45"
                  />
                  <text
                    x={lane.x + lane.width / 2}
                    y={38}
                    textAnchor="middle"
                    fill={meta.stroke}
                    fontSize="10.5"
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight="700"
                    letterSpacing="0.06em"
                  >
                    {meta.label}
                  </text>
                </g>
              );
            })}

            {/* Directed Lineage Edges */}
            {graph.edges.map((edge) => {
              const src = nodeById.get(edge.source);
              const dst = nodeById.get(edge.target);
              if (!src || !dst) return null;

              const { d, midX, midY } = computeBezierEdgePath(src, dst);
              const isUp = upstreamEdgeSet.has(edge.id);
              const isDown = downstreamEdgeSet.has(edge.id);
              const hasSelection = highlight.selectedId !== null;

              const stroke = isUp
                ? 'var(--accent-cyan)'
                : isDown
                  ? 'var(--accent-signal)'
                  : 'var(--border-strong)';
              const opacity = hasSelection ? (isUp || isDown ? 1 : 0.16) : 0.72;
              const markerEnd = isUp
                ? 'url(#lineage-arrow-up)'
                : isDown
                  ? 'url(#lineage-arrow-down)'
                  : 'url(#lineage-arrow-idle)';

              return (
                <g
                  key={edge.id}
                  data-testid={`lineage-edge-${edge.id}`}
                  data-edge-state={isUp ? 'upstream' : isDown ? 'downstream' : 'idle'}
                  style={{ opacity, transition: 'opacity 200ms ease' }}
                >
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={isUp || isDown ? 2.4 : 1.4}
                    markerEnd={markerEnd}
                    className={isUp || isDown ? 'nexus-lineage-flow' : undefined}
                  />
                  {(isUp || isDown || !hasSelection) && (
                    <g>
                      <rect
                        x={midX - 52}
                        y={midY - 9}
                        width={104}
                        height={17}
                        rx="4"
                        fill="var(--bg-canvas)"
                        stroke={isUp || isDown ? stroke : 'var(--border-hairline)'}
                        strokeWidth={0.9}
                      />
                      <text
                        x={midX}
                        y={midY + 3}
                        textAnchor="middle"
                        fill={isUp || isDown ? stroke : 'var(--text-muted)'}
                        fontSize="8.5"
                        fontFamily="JetBrains Mono, monospace"
                        fontWeight={isUp || isDown ? '600' : '500'}
                      >
                        {edge.transformLabel.slice(0, 18)}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {/* Clickable Schema ERD Table Cards */}
            {graph.nodes.map((node) => {
              const meta = LAYER_META[node.layer];
              const isSelected = highlight.selectedId === node.id;
              const isUp = upstreamSet.has(node.id);
              const isDown = downstreamSet.has(node.id);
              const hasSelection = highlight.selectedId !== null;
              const dimmed = hasSelection && !isSelected && !isUp && !isDown;

              const role = isSelected
                ? 'selected'
                : isUp
                  ? 'upstream'
                  : isDown
                    ? 'downstream'
                    : dimmed
                      ? 'dimmed'
                      : 'idle';

              const borderStroke = isSelected
                ? 'var(--text-primary)'
                : isUp
                  ? 'var(--accent-cyan)'
                  : isDown
                    ? 'var(--accent-signal)'
                    : 'var(--border-strong)';

              const qColor = qualityColor(node.qualityGrade);
              const visibleCols = node.columns.slice(0, 4);

              return (
                <g
                  key={node.id}
                  data-testid={`lineage-node-${node.id}`}
                  data-highlight-role={role}
                  onClick={() =>
                    setSelectedNodeId((prev) => (prev === node.id ? null : node.id))
                  }
                  className="cursor-pointer"
                  style={{
                    opacity: dimmed ? 0.34 : 1,
                    transition: 'opacity 200ms ease',
                  }}
                >
                  {/* Selection halo */}
                  {(isSelected || isUp || isDown) && (
                    <rect
                      x={node.x - 3}
                      y={node.y - 3}
                      width={node.width + 6}
                      height={node.height + 6}
                      rx="9"
                      fill="none"
                      stroke={isSelected ? meta.stroke : isUp ? 'var(--accent-cyan)' : 'var(--accent-signal)'}
                      strokeWidth={isSelected ? 2 : 1.4}
                      strokeOpacity="0.6"
                    />
                  )}

                  {/* Card Base */}
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    rx="7"
                    fill="var(--bg-surface)"
                    stroke={borderStroke}
                    strokeWidth={isSelected ? 1.8 : 1.1}
                  />

                  {/* Left Medallion Accent Strip */}
                  <rect
                    x={node.x}
                    y={node.y}
                    width={4.5}
                    height={node.height}
                    rx="2"
                    fill={meta.stroke}
                  />

                  {/* Header Background */}
                  <rect
                    x={node.x + 4.5}
                    y={node.y + 1}
                    width={node.width - 5.5}
                    height={52}
                    rx="6"
                    fill="var(--bg-elevated)"
                    fillOpacity="0.65"
                  />

                  {/* Layer & Quality Badge Row */}
                  <text
                    x={node.x + 14}
                    y={node.y + 16}
                    fill={meta.stroke}
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight="700"
                  >
                    {node.kind === 'materialized_view'
                      ? `${meta.shortTag} · MV`
                      : node.kind === 'stream'
                        ? `${meta.shortTag} · CDC`
                        : meta.shortTag}
                  </text>

                  {/* Quality Null-Rate Pill */}
                  <rect
                    x={node.x + node.width - 102}
                    y={node.y + 6}
                    width={92}
                    height={15}
                    rx="3"
                    fill="var(--bg-inset)"
                    stroke={qColor}
                    strokeOpacity="0.55"
                    strokeWidth="0.8"
                  />
                  <text
                    x={node.x + node.width - 56}
                    y={node.y + 16.5}
                    textAnchor="middle"
                    fill={qColor}
                    fontSize="8.2"
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight="600"
                  >
                    {node.nullRatePct}% NULL · {node.qualityGrade}
                  </text>

                  {/* Table Name */}
                  <text
                    x={node.x + 14}
                    y={node.y + 33}
                    fill="var(--text-primary)"
                    fontSize="11.5"
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight="700"
                  >
                    {node.name.length > 26 ? `${node.name.slice(0, 25)}..` : node.name}
                  </text>

                  {/* Row Count + Size + Freshness */}
                  <text
                    x={node.x + 14}
                    y={node.y + 47}
                    fill="var(--text-muted)"
                    fontSize="9"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {formatCompactRows(node.rowCount)} rows · {node.sizeMb} MB
                  </text>
                  <circle
                    cx={node.x + node.width - 54}
                    cy={node.y + 44}
                    r="3"
                    fill={
                      node.refreshState === 'stale'
                        ? 'var(--accent-amber)'
                        : node.refreshState === 'refreshed'
                          ? 'var(--accent-emerald)'
                          : 'var(--accent-cyan)'
                    }
                  />
                  <text
                    x={node.x + node.width - 47}
                    y={node.y + 47}
                    fill={
                      node.refreshState === 'stale'
                        ? '#f59e0b'
                        : node.refreshState === 'refreshed'
                          ? '#10b981'
                          : 'var(--text-secondary)'
                    }
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight="600"
                  >
                    {node.refreshState === 'stale'
                      ? 'STALE'
                      : node.refreshState === 'refreshed'
                        ? 'SYNCED'
                        : 'FRESH'}
                  </text>

                  {/* Divider */}
                  <line
                    x1={node.x + 6}
                    y1={node.y + 54}
                    x2={node.x + node.width - 2}
                    y2={node.y + 54}
                    stroke="var(--border-hairline)"
                  />

                  {/* Schema Column Preview Rows */}
                  {visibleCols.map((col, idx) => {
                    const rowY = node.y + 72 + idx * 21;
                    return (
                      <g key={col.name}>
                        {col.isPk && (
                          <rect
                            x={node.x + 12}
                            y={rowY - 9}
                            width={18}
                            height={12}
                            rx="2"
                            fill="rgba(6, 182, 212, 0.2)"
                          />
                        )}
                        {col.isPk && (
                          <text
                            x={node.x + 21}
                            y={rowY}
                            textAnchor="middle"
                            fill="var(--accent-cyan)"
                            fontSize="7.5"
                            fontFamily="JetBrains Mono, monospace"
                            fontWeight="700"
                          >
                            PK
                          </text>
                        )}
                        {!col.isPk && col.isFk && (
                          <rect
                            x={node.x + 12}
                            y={rowY - 9}
                            width={18}
                            height={12}
                            rx="2"
                            fill="rgba(245, 158, 11, 0.2)"
                          />
                        )}
                        {!col.isPk && col.isFk && (
                          <text
                            x={node.x + 21}
                            y={rowY}
                            textAnchor="middle"
                            fill="#f59e0b"
                            fontSize="7.5"
                            fontFamily="JetBrains Mono, monospace"
                            fontWeight="700"
                          >
                            FK
                          </text>
                        )}
                        <text
                          x={node.x + (col.isPk || col.isFk ? 35 : 14)}
                          y={rowY}
                          fill="var(--text-secondary)"
                          fontSize="9.5"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {col.name.length > 18 ? `${col.name.slice(0, 17)}..` : col.name}
                        </text>
                        <text
                          x={node.x + node.width - 12}
                          y={rowY}
                          textAnchor="end"
                          fill="var(--text-muted)"
                          fontSize="8.5"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {col.type}
                        </text>
                      </g>
                    );
                  })}

                  {/* Remaining columns footer */}
                  <text
                    x={node.x + 14}
                    y={node.y + node.height - 10}
                    fill="var(--text-muted)"
                    fontSize="8.2"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    PARTITION: {node.partitionKey}
                  </text>
                  {node.columns.length > visibleCols.length && (
                    <text
                      x={node.x + node.width - 12}
                      y={node.y + node.height - 10}
                      textAnchor="end"
                      fill="var(--accent-cyan)"
                      fontSize="8.2"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      +{node.columns.length - visibleCols.length} cols
                    </text>
                  )}

                  {/* Left/Right Port Anchors */}
                  {node.layer !== 'bronze' && (
                    <circle
                      cx={node.x}
                      cy={node.y + node.height / 2}
                      r="3.5"
                      fill="var(--bg-canvas)"
                      stroke={isUp || isSelected ? 'var(--accent-cyan)' : 'var(--border-strong)'}
                      strokeWidth="1.5"
                    />
                  )}
                  {node.layer !== 'gold' && (
                    <circle
                      cx={node.x + node.width}
                      cy={node.y + node.height / 2}
                      r="3.5"
                      fill="var(--bg-canvas)"
                      stroke={isDown || isSelected ? 'var(--accent-signal)' : 'var(--border-strong)'}
                      strokeWidth="1.5"
                    />
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </section>

      {/* Bottom 2-Column Analytical Inspectors */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* Left: Selected Table Schema & Dependency Impact Inspector */}
        <section
          data-testid="lineage-table-inspector"
          className="xl:col-span-6 nexus-panel rounded-md overflow-hidden"
        >
          {selectedNode ? (
            <>
              <div className="px-3.5 py-2.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Database className="w-3.5 h-3.5 text-[var(--accent-cyan)] shrink-0" />
                  <h3 className="font-mono-tech text-xs font-bold text-[var(--text-primary)] m-0 truncate">
                    {selectedNode.name}
                  </h3>
                  <span
                    className={`font-mono-tech text-[9px] px-1.5 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-semibold ${LAYER_META[selectedNode.layer].textClass}`}
                  >
                    {LAYER_META[selectedNode.layer].shortTag}
                  </span>
                </div>

                <button
                  type="button"
                  data-testid="lineage-query-table-btn"
                  onClick={() =>
                    onQueryTableInNotebook(selectedNode.name, selectedNode.sampleSql)
                  }
                  className="px-2.5 py-1 rounded bg-[var(--accent-cyan-soft)] border border-[var(--accent-cyan)]/45 hover:bg-[var(--accent-cyan)] hover:text-white text-[var(--accent-cyan)] font-mono-tech text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <Play className="w-2.5 h-2.5 fill-current" />
                  <span>{locale === 'vi' ? 'Truy vấn trong Sổ SQL' : 'Query in SQL Notebook'}</span>
                </button>
              </div>

              <div className="p-3.5 space-y-3 bg-[var(--bg-inset)]">
                <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed">
                  {selectedNode.description}
                </p>

                {/* Upstream / Downstream Jump Chips */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="p-2.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] space-y-1.5">
                    <div className="font-mono-tech text-[9.5px] uppercase text-[var(--accent-cyan)] font-semibold">
                      UPSTREAM SOURCES ({highlight.upstreamNodeIds.length})
                    </div>
                    {highlight.upstreamNodeIds.length === 0 ? (
                      <p className="font-mono-tech text-[10px] text-[var(--text-muted)] m-0">
                        Root Bronze ingestion source
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {highlight.upstreamNodeIds.map((uid) => (
                          <button
                            key={uid}
                            type="button"
                            onClick={() => setSelectedNodeId(uid)}
                            className="px-1.5 py-0.5 rounded bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-mono-tech text-[9.5px] hover:brightness-110 cursor-pointer"
                          >
                            {uid}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="p-2.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] space-y-1.5">
                    <div className="font-mono-tech text-[9.5px] uppercase text-[var(--accent-signal)] font-semibold">
                      DOWNSTREAM IMPACT ({highlight.downstreamNodeIds.length})
                    </div>
                    {highlight.downstreamNodeIds.length === 0 ? (
                      <p className="font-mono-tech text-[10px] text-[var(--text-muted)] m-0">
                        Terminal Gold BI serving mart
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {highlight.downstreamNodeIds.map((did) => (
                          <button
                            key={did}
                            type="button"
                            onClick={() => setSelectedNodeId(did)}
                            className="px-1.5 py-0.5 rounded bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] font-mono-tech text-[9.5px] hover:brightness-110 cursor-pointer"
                          >
                            {did}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Full Column Schema + Null Quality Bars */}
                <div className="rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] overflow-x-auto">
                  <table className="w-full border-collapse text-left font-mono-tech text-[10.5px]">
                    <thead className="bg-[var(--bg-elevated)] nexus-hairline-b text-[9px] uppercase text-[var(--text-muted)]">
                      <tr>
                        <th className="px-2.5 py-1.5">Column</th>
                        <th className="px-2.5 py-1.5">SQL Type</th>
                        <th className="px-2.5 py-1.5">Key</th>
                        <th className="px-2.5 py-1.5 text-right">Null Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedNode.columns.map((col) => (
                        <tr
                          key={col.name}
                          className="border-b border-[var(--border-hairline)] last:border-b-0"
                        >
                          <td className="px-2.5 py-1.5 text-[var(--text-primary)] font-medium">
                            {col.name}
                          </td>
                          <td className="px-2.5 py-1.5 text-[var(--text-muted)]">{col.type}</td>
                          <td className="px-2.5 py-1.5">
                            {col.isPk ? (
                              <span className="px-1 py-0.2 rounded bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] text-[9px] font-semibold">
                                PK
                              </span>
                            ) : col.isFk ? (
                              <span className="px-1 py-0.2 rounded bg-[var(--bg-elevated)] text-[var(--accent-amber)] text-[9px] font-semibold">
                                FK
                              </span>
                            ) : (
                              <span className="text-[var(--text-muted)] opacity-45">--</span>
                            )}
                          </td>
                          <td className="px-2.5 py-1.5 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <div className="w-12 h-1.5 rounded bg-[var(--bg-elevated)] overflow-hidden">
                                <div
                                  className="h-full"
                                  style={{
                                    width: `${Math.min(100, Math.max(4, col.nullRatePct * 5))}%`,
                                    backgroundColor:
                                      col.nullRatePct < 1
                                        ? 'var(--accent-emerald)'
                                        : col.nullRatePct < 5
                                          ? 'var(--accent-amber)'
                                          : 'var(--accent-crimson)',
                                  }}
                                />
                              </div>
                              <span className="tabular-nums text-[var(--text-secondary)]">
                                {col.nullRatePct.toFixed(1)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </section>

        {/* Right: Materialized View Refresh & Query Plan Cost Inspector */}
        <section
          data-testid="lineage-cost-inspector"
          className="xl:col-span-6 nexus-panel rounded-md overflow-hidden"
        >
          <div className="px-3.5 py-2.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Gauge className="w-3.5 h-3.5 text-[var(--accent-emerald)] shrink-0" />
              <h3 className="font-mono-tech text-xs font-bold text-[var(--text-primary)] m-0">
                {copy.costInspectorTitle}
              </h3>
            </div>

            <div className="flex items-center rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] p-0.5 font-mono-tech text-[9.5px]">
              <button
                type="button"
                data-testid="cost-probe-pruned"
                onClick={() => setCostProbeMode('pruned')}
                className={`px-2 py-0.5 rounded-[3px] cursor-pointer ${
                  costProbeMode === 'pruned'
                    ? 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                Partition Pruned
              </button>
              <button
                type="button"
                data-testid="cost-probe-full"
                onClick={() => setCostProbeMode('full')}
                className={`px-2 py-0.5 rounded-[3px] cursor-pointer ${
                  costProbeMode === 'full'
                    ? 'bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                Full Scan
              </button>
            </div>
          </div>

          <div className="p-3.5 space-y-3 bg-[var(--bg-inset)]">
            {/* Simulated Cost Telemetry Tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
                <div className="font-mono-tech text-[8.5px] text-[var(--text-muted)] flex items-center gap-1">
                  <Layers className="w-2.5 h-2.5 text-[var(--accent-cyan)]" />
                  EST. SCAN ROWS
                </div>
                <div
                  data-testid="cost-estimated-scan-rows"
                  className="font-mono-tech text-xs font-bold text-[var(--text-primary)] mt-0.5 tabular-nums"
                >
                  {costEstimate.estimatedScanRows.toLocaleString()}
                </div>
              </div>

              <div className="p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
                <div className="font-mono-tech text-[8.5px] text-[var(--text-muted)] flex items-center gap-1">
                  <Filter className="w-2.5 h-2.5 text-[var(--accent-emerald)]" />
                  PRUNING RATIO
                </div>
                <div
                  data-testid="cost-pruning-ratio"
                  className="font-mono-tech text-xs font-bold text-[var(--accent-emerald)] mt-0.5 tabular-nums"
                >
                  {(costEstimate.partitionPruningRatio * 100).toFixed(1)}%
                </div>
              </div>

              <div className="p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
                <div className="font-mono-tech text-[8.5px] text-[var(--text-muted)] flex items-center gap-1">
                  <Cpu className="w-2.5 h-2.5 text-[var(--accent-cyan)]" />
                  MEMORY (MB)
                </div>
                <div
                  data-testid="cost-memory-mb"
                  className="font-mono-tech text-xs font-bold text-[var(--accent-cyan)] mt-0.5 tabular-nums"
                >
                  {costEstimate.memoryFootprintMb.toFixed(2)} MB
                </div>
              </div>

              <div className="p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
                <div className="font-mono-tech text-[8.5px] text-[var(--text-muted)] flex items-center gap-1">
                  <Activity className="w-2.5 h-2.5 text-[var(--accent-signal)]" />
                  EST. LATENCY
                </div>
                <div className="font-mono-tech text-xs font-bold text-[var(--text-primary)] mt-0.5 tabular-nums">
                  {costEstimate.estimatedLatencyMs.toFixed(1)} ms
                </div>
              </div>
            </div>

            {/* Active Cost SQL Probe + Optimizer Advice */}
            <div className="p-2.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] space-y-2">
              <div className="flex items-center justify-between font-mono-tech text-[9.5px]">
                <span className="text-[var(--text-muted)]">ANALYZED PLAN SQL</span>
                <span
                  className={`px-1.5 py-0.5 rounded font-semibold ${
                    costEstimate.costTier === 'LOW'
                      ? 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]'
                      : costEstimate.costTier === 'MODERATE'
                        ? 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)]'
                        : 'bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]'
                  }`}
                >
                  COST: {costEstimate.costTier}
                </span>
              </div>
              <pre className="m-0 p-2 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[10px] text-[var(--text-secondary)] overflow-x-auto whitespace-pre-wrap break-all">
                {probeSql}
              </pre>
              <div className="space-y-1">
                {costEstimate.recommendations.map((rec) => (
                  <div
                    key={rec}
                    className="flex items-start gap-1.5 text-[10.5px] text-[var(--text-secondary)]"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent-emerald)] shrink-0 mt-0.5" />
                    <span>{rec}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Materialized View Incremental Refresh Trace */}
            <div
              data-testid="lineage-refresh-trace"
              className="p-2.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px]">
                <span className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  <RefreshCw className="w-3 h-3 text-[var(--accent-cyan)]" />
                  INCREMENTAL REFRESH EXECUTION TRACE
                </span>
                {refreshResult ? (
                  <span className="text-[var(--accent-emerald)] font-semibold">
                    {refreshResult.steps.length} STAGES · {refreshResult.totalDurationMs}ms · PEAK{' '}
                    {refreshResult.peakMemoryMb} MB
                  </span>
                ) : (
                  <span className="text-[var(--text-muted)]">READY</span>
                )}
              </div>

              {refreshResult ? (
                <div className="space-y-1 max-h-44 overflow-y-auto pr-0.5">
                  {refreshResult.steps.map((step) => (
                    <div
                      key={step.nodeId}
                      data-testid={`refresh-step-${step.nodeId}`}
                      className="px-2 py-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[9.5px]"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <CheckCircle2 className="w-3 h-3 text-[var(--accent-emerald)] shrink-0" />
                        <span
                          className={`uppercase font-semibold ${LAYER_META[step.layer].textClass}`}
                        >
                          {step.layer.slice(0, 3)}
                        </span>
                        <ArrowRight className="w-2.5 h-2.5 text-[var(--text-muted)] shrink-0" />
                        <span className="text-[var(--text-primary)] truncate">
                          {step.tableName}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[var(--text-muted)] tabular-nums">
                        <span className="text-[var(--accent-emerald)]">
                          +{step.deltaRows.toLocaleString()}
                        </span>
                        <span>{(step.partitionPruningRatio * 100).toFixed(0)}% pruned</span>
                        <span>{step.memoryMb} MB</span>
                        <span className="text-[var(--text-primary)]">{step.durationMs}ms</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="font-mono-tech text-[10px] text-[var(--text-muted)] m-0">
                  Click &quot;{copy.lineageRefreshAll}&quot; above to run a 1-click incremental
                  Bronze -&gt; Silver -&gt; Gold refresh simulation and inspect partition pruning &amp;
                  memory metrics.
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default SchemaLineageView;
