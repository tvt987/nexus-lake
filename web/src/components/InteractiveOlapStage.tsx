import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Box,
  Check,
  Copy,
  Crosshair,
  Database,
  Flame,
  GitBranch,
  Lasso,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareDashedMousePointer,
  X,
  Zap,
} from 'lucide-react';
import {
  compileBrushToSql,
  computeOlapClusterBeacons,
  createDefaultCubeCamera,
  createInitialMedallionPipelineState,
  createOlapPointCloudIndex,
  MAX_OLAP_LATENCY_MS,
  MAX_OLAP_REVENUE_USD,
  OLAP_BRUSH_PRESETS,
  OLAP_REGIONS,
  project3dCubePoint,
  queryOlapLassoBox,
  queryOlapPolygonLasso,
  stepMedallionCdcPipeline,
  type Cube3dCamera,
  type MedallionPipelineState,
  type OlapClusterBeacon,
  type OlapLassoBox,
  type OlapLassoSelectionResult,
  type OlapPointCloudIndex,
  type OlapPolygonPoint,
  type OlapStageMode,
} from '../engines/olapBrushPipelineEngine';
import type { Locale, ThemeMode } from '../types/lakehouse';

export interface InteractiveOlapStageProps {
  locale: Locale;
  theme: ThemeMode;
  rowScale: number;
  onRunSqlInNotebook: (sql: string, title: string) => void;
}

interface RibbonParticle {
  t: number; // 0..1 along pipeline
  speed: number;
  lane: number; // -1..1 slight vertical offset
  kind: 'normal' | 'gold' | 'drift';
  deflected: boolean;
  dlqT: number; // 0..1 progress down into DLQ vault once deflected at dbt-test gate
  size: number;
}

interface DragBrushState {
  mode: 'box' | 'polygon';
  startU: number;
  startV: number;
  curU: number;
  curV: number;
  polygonUv: { u: number; v: number }[];
  dragging: boolean;
}

// Responsive plot margins inside the 2D scatter canvas (normalized fraction of width/height)
function getPlotPads(isCompact: boolean) {
  return isCompact
    ? { padL: 0.145, padR: 0.068, padT: 0.105, padB: 0.14 }
    : { padL: 0.068, padR: 0.028, padT: 0.072, padB: 0.125 };
}

function uvToDomain(
  u: number,
  v: number,
  isCompact = false,
): { latencyMs: number; revenueUsd: number } {
  const { padL, padR, padT, padB } = getPlotPads(isCompact);
  const nx = Math.max(0, Math.min(1, (u - padL) / (1 - padL - padR)));
  const ny = Math.max(0, Math.min(1, 1 - (v - padT) / (1 - padT - padB)));
  return {
    latencyMs: Math.round(nx * MAX_OLAP_LATENCY_MS),
    revenueUsd: Number((ny * MAX_OLAP_REVENUE_USD).toFixed(2)),
  };
}

function domainToUv(
  latencyMs: number,
  revenueUsd: number,
  isCompact = false,
): { u: number; v: number } {
  const { padL, padR, padT, padB } = getPlotPads(isCompact);
  const nx = Math.max(0, Math.min(1, latencyMs / MAX_OLAP_LATENCY_MS));
  const ny = Math.max(0, Math.min(1, revenueUsd / MAX_OLAP_REVENUE_USD));
  return {
    u: padL + nx * (1 - padL - padR),
    v: padT + (1 - ny) * (1 - padT - padB),
  };
}

function packAbgr(r: number, g: number, b: number, a: number): number {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

/**
 * Pure React JSX SQL token highlighter (strictly declarative, zero raw HTML injection).
 */
const SQL_KEYWORD_SET = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'BETWEEN',
  'AND',
  'IN',
  'GROUP',
  'BY',
  'ORDER',
  'DESC',
  'ASC',
  'AS',
  'WITHIN',
  'COUNT',
  'ROUND',
  'AVG',
  'PERCENTILE_CONT',
]);

function renderHighlightedSql(sql: string): React.ReactNode {
  const parts = sql.split(/(\s+|[,();']|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(?:\.\d+)?\b)/g);
  return parts.map((tok, i) => {
    if (!tok) return null;
    if (SQL_KEYWORD_SET.has(tok.toUpperCase())) {
      return (
        <span key={i} className="text-[#2563EB] dark:text-[#60A5FA] font-semibold">
          {tok}
        </span>
      );
    }
    if (/^\d+(?:\.\d+)?$/.test(tok)) {
      return (
        <span key={i} className="text-[#0D9488] dark:text-[#2DD4BF] font-semibold">
          {tok}
        </span>
      );
    }
    if (tok === 'gold_transactions') {
      return (
        <span key={i} className="text-[#B45309] dark:text-[#FBBF24] font-semibold">
          {tok}
        </span>
      );
    }
    return <span key={i}>{tok}</span>;
  });
}

export const InteractiveOlapStage: React.FC<InteractiveOlapStageProps> = ({
  locale,
  rowScale,
  onRunSqlInNotebook,
}) => {
  const [stageMode, setStageMode] = useState<OlapStageMode>('scatter2d');
  const [lassoTool, setLassoTool] = useState<'box' | 'polygon'>('box');
  const [activeBox, setActiveBox] = useState<OlapLassoBox | null>(null);
  const [activePolygon, setActivePolygon] = useState<OlapPolygonPoint[] | null>(null);
  const [dragBrush, setDragBrush] = useState<DragBrushState | null>(null);
  const [hoverDomain, setHoverDomain] = useState<{ latencyMs: number; revenueUsd: number } | null>(
    null,
  );
  const [copiedSql, setCopiedSql] = useState(false);
  const [dispatchedNotice, setDispatchedNotice] = useState(false);

  // 3D Cube camera state
  const [cubeCamera, setCubeCamera] = useState<Cube3dCamera>(() => createDefaultCubeCamera());
  const [autoOrbit, setAutoOrbit] = useState(true);
  const [selectedBeaconId, setSelectedBeaconId] = useState<string>('cluster-whale');
  const [hoveredBeaconId, setHoveredBeaconId] = useState<string | null>(null);

  // Medallion pipeline inspection state
  const [selectedStageNode, setSelectedStageNode] = useState<
    'kafka' | 'bronze' | 'silver' | 'dbt_gate' | 'dlq' | 'gold'
  >('dbt_gate');

  // 100K-Row Deterministic Spatial Index (ref-held for zero-GC 60fps rendering + version counter)
  const indexRef = useRef<OlapPointCloudIndex | null>(null);
  if (!indexRef.current || indexRef.current.baseCount !== Math.min(rowScale, 250_000)) {
    indexRef.current = createOlapPointCloudIndex(Math.min(rowScale, 250_000), 20261128);
  }
  const [indexVersion, setIndexVersion] = useState(0);

  // Streaming Medallion CDC Pipeline state
  const [pipeline, setPipeline] = useState<MedallionPipelineState>(() =>
    createInitialMedallionPipelineState(Math.min(rowScale, 250_000)),
  );
  const pipelineRef = useRef(pipeline);
  pipelineRef.current = pipeline;

  // Live selection metrics computed from the 100K spatial index in <5ms
  const [selectionResult, setSelectionResult] = useState<OlapLassoSelectionResult>(() =>
    queryOlapLassoBox(
      indexRef.current!,
      {
        minLatencyMs: 0,
        maxLatencyMs: MAX_OLAP_LATENCY_MS,
        minRevenueUsd: 0,
        maxRevenueUsd: MAX_OLAP_REVENUE_USD,
        label: 'Full Lakehouse View (100K Rows)',
      },
      { updateMask: false },
    ),
  );

  // Recalculate selection whenever box, polygon, or live streaming points update
  useEffect(() => {
    const idx = indexRef.current;
    if (!idx) return;
    if (activePolygon && activePolygon.length >= 3) {
      setSelectionResult(queryOlapPolygonLasso(idx, activePolygon, { updateMask: true }));
    } else if (activeBox) {
      setSelectionResult(queryOlapLassoBox(idx, activeBox, { updateMask: true }));
    } else {
      idx.selectedMask.fill(0, 0, idx.count);
      setSelectionResult(
        queryOlapLassoBox(
          idx,
          {
            minLatencyMs: 0,
            maxLatencyMs: MAX_OLAP_LATENCY_MS,
            minRevenueUsd: 0,
            maxRevenueUsd: MAX_OLAP_REVENUE_USD,
            label: 'Full Lakehouse View',
          },
          { updateMask: false },
        ),
      );
    }
  }, [activeBox, activePolygon, indexVersion]);

  const clusterBeacons = useMemo(
    () => computeOlapClusterBeacons(indexRef.current!),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [indexVersion],
  );

  const effectiveSqlBox = useMemo<OlapLassoBox>(() => {
    if (activeBox) return activeBox;
    if (activePolygon && activePolygon.length >= 3) return selectionResult.box;
    return {
      minLatencyMs: 0,
      maxLatencyMs: MAX_OLAP_LATENCY_MS,
      minRevenueUsd: 0,
      maxRevenueUsd: MAX_OLAP_REVENUE_USD,
      label: 'Full Gold Lakehouse',
    };
  }, [activeBox, activePolygon, selectionResult.box]);

  const compiledSql = useMemo(() => compileBrushToSql(effectiveSqlBox), [effectiveSqlBox]);

  // Live Streaming Medallion CDC micro-batch timer (appends glowing Gold droplets into index)
  useEffect(() => {
    const tickMs = pipeline.streamingMode === 'SURGE' ? 420 : 850;
    const timer = window.setInterval(() => {
      const idx = indexRef.current;
      if (!idx) return;
      const step = stepMedallionCdcPipeline(pipelineRef.current, idx, {
        tickMs,
        maxPointsAppendedPerTick: pipelineRef.current.streamingMode === 'SURGE' ? 420 : 60,
      });
      pipelineRef.current = step.nextState;
      setPipeline(step.nextState);
      if (step.appendedGoldPoints > 0) {
        setIndexVersion((v) => v + 1);
      }
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [pipeline.streamingMode]);

  // Actions: Surge Kafka CDC (+10K/s) & Inject Schema Drift (dbt Gate)
  const handleToggleSurge = useCallback(() => {
    const idx = indexRef.current;
    setPipeline((prev) => {
      const nextMode = prev.streamingMode === 'SURGE' ? 'STEADY' : 'SURGE';
      const toggled: MedallionPipelineState = { ...prev, streamingMode: nextMode };
      if (nextMode === 'SURGE' && idx) {
        const immediate = stepMedallionCdcPipeline(toggled, idx, {
          tickMs: 650,
          maxPointsAppendedPerTick: 520,
        });
        pipelineRef.current = immediate.nextState;
        setIndexVersion((v) => v + 1);
        return immediate.nextState;
      }
      pipelineRef.current = toggled;
      return toggled;
    });
  }, []);

  const handleToggleSchemaDrift = useCallback(() => {
    const idx = indexRef.current;
    setPipeline((prev) => {
      const nextDrift = !prev.schemaDriftActive;
      const toggled: MedallionPipelineState = {
        ...prev,
        schemaDriftActive: nextDrift,
        dbtGateStatus: nextDrift ? 'INTERCEPTING_DRIFT' : 'PASSING',
        activeDriftAlerts: nextDrift ? prev.activeDriftAlerts : [],
      };
      if (nextDrift && idx) {
        const immediate = stepMedallionCdcPipeline(toggled, idx, {
          tickMs: 650,
          maxPointsAppendedPerTick: 160,
        });
        pipelineRef.current = immediate.nextState;
        setIndexVersion((v) => v + 1);
        return immediate.nextState;
      }
      pipelineRef.current = toggled;
      return toggled;
    });
  }, []);

  const handleApplyPreset = useCallback((box: OlapLassoBox) => {
    setActivePolygon(null);
    setActiveBox(box);
    setStageMode('scatter2d');
  }, []);

  const handleClearBrush = useCallback(() => {
    setActiveBox(null);
    setActivePolygon(null);
    setDragBrush(null);
  }, []);

  const handleCopySql = useCallback(() => {
    void navigator.clipboard?.writeText(compiledSql.sql);
    setCopiedSql(true);
    window.setTimeout(() => setCopiedSql(false), 1600);
  }, [compiledSql.sql]);

  const handleDispatchToEditor = useCallback(() => {
    const label = activeBox?.label || (activePolygon ? 'Freehand Lasso Cluster' : 'Gold OLAP Cohort');
    onRunSqlInNotebook(compiledSql.sql, `Brush-to-SQL: ${label}`);
    setDispatchedNotice(true);
    window.setTimeout(() => setDispatchedNotice(false), 1800);
  }, [activeBox, activePolygon, compiledSql.sql, onRunSqlInNotebook]);

  // ============================================================================
  // ANIMATED LIVE MEDALLION STREAMING RIBBON CANVAS (60fps droplets Bronze->Silver->dbt->Gold)
  // ============================================================================
  const ribbonCanvasRef = useRef<HTMLCanvasElement>(null);
  const ribbonParticlesRef = useRef<RibbonParticle[]>([]);

  useEffect(() => {
    const canvas = ribbonCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Seed initial glowing droplets smoothly distributed across the pipeline
    if (ribbonParticlesRef.current.length === 0) {
      for (let i = 0; i < 42; i += 1) {
        ribbonParticlesRef.current.push({
          t: (i / 42) % 1,
          speed: 0.17 + ((i * 37) % 10) * 0.011,
          lane: ((i % 5) - 2) * 0.42,
          kind: i % 6 === 0 ? 'gold' : 'normal',
          deflected: false,
          dlqT: 0,
          size: 2.2 + (i % 3) * 0.7,
        });
      }
    }

    let rafId = 0;
    let lastTs = performance.now();

    const syncRibbonSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(300, Math.floor(rect.width * dpr));
      const h = Math.max(54, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return dpr;
    };

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncRibbonSize) : null;
    ro?.observe(canvas);

    const drawRibbon = (now: number) => {
      const dpr = syncRibbonSize();
      const dt = Math.min(0.05, Math.max(0.004, (now - lastTs) / 1000));
      lastTs = now;

      const w = canvas.width;
      const h = canvas.height;
      const st = pipelineRef.current;
      const isSurge = st.streamingMode === 'SURGE';
      const isDrift = st.schemaDriftActive;

      // Clear obsidian ribbon strip
      ctx.fillStyle = '#070C18';
      ctx.fillRect(0, 0, w, h);

      // Subtle bottom hairline separator
      ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.fillRect(0, h - 1, w, 1);

      const compact = w / dpr < 640;
      const padX = compact ? w * 0.105 : w * 0.055;
      const pipeY = h * 0.48;
      const spanW = w - padX * 2;

      // 5 architectural nodes along the ribbon (concise non-clipping text on 390px mobile)
      const nodes = [
        {
          u: 0.0,
          title: compact ? 'KAFKA' : 'KAFKA CDC',
          sub: `+${(st.kafkaRateRowsSec / 1000).toFixed(1)}K/s`,
          color: isSurge ? '#FACC15' : '#10B981',
        },
        {
          u: 0.25,
          title: compact ? 'BRONZE' : 'BRONZE RAW',
          sub: `${(st.bronzeRawRows / 1000).toFixed(0)}K`,
          color: '#F59E0B',
        },
        {
          u: 0.50,
          title: compact ? 'SILVER' : 'SILVER CLEAN',
          sub: `${(st.silverCleanedRows / 1000).toFixed(0)}K`,
          color: '#38BDF8',
        },
        {
          u: 0.75,
          title: compact ? (isDrift ? 'DLQ GATE' : 'dbt GATE') : isDrift ? 'dbt QUARANTINE' : 'dbt-test GATE',
          sub: isDrift
            ? compact
              ? `${st.quarantineDlqRows.toLocaleString()} DLQ`
              : `DLQ ${st.quarantineDlqRows.toLocaleString()}`
            : compact
              ? 'PASS'
              : '100% PASS',
          color: isDrift ? '#F43F5E' : '#10B981',
        },
        {
          u: 1.0,
          title: compact ? 'GOLD' : 'GOLD MART',
          sub: compact ? '0 ERR' : `${(st.goldMartRows / 1000).toFixed(1)}K · 0 ERR`,
          color: '#FACC15',
        },
      ];

      // Draw glowing conduit pipe between nodes
      const grad = ctx.createLinearGradient(padX, pipeY, padX + spanW, pipeY);
      grad.addColorStop(0, isSurge ? 'rgba(250, 204, 21, 0.55)' : 'rgba(16, 185, 129, 0.42)');
      grad.addColorStop(0.28, 'rgba(245, 158, 11, 0.45)');
      grad.addColorStop(0.52, 'rgba(56, 189, 248, 0.48)');
      grad.addColorStop(0.74, isDrift ? 'rgba(244, 63, 94, 0.72)' : 'rgba(16, 185, 129, 0.50)');
      grad.addColorStop(1, 'rgba(250, 204, 21, 0.65)');

      ctx.strokeStyle = grad;
      ctx.lineWidth = (isSurge ? 3.2 : 2.2) * dpr;
      ctx.beginPath();
      ctx.moveTo(padX, pipeY);
      ctx.lineTo(padX + spanW, pipeY);
      ctx.stroke();

      // If schema drift is active (or DLQ has records), draw Quarantine DLQ branch off dbt-test gate
      const gateX = padX + spanW * 0.72;
      if (isDrift || st.quarantineDlqRows > 0) {
        ctx.strokeStyle = isDrift ? 'rgba(244, 63, 94, 0.75)' : 'rgba(244, 63, 94, 0.35)';
        ctx.lineWidth = 1.6 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(gateX, pipeY + 4 * dpr);
        ctx.quadraticCurveTo(gateX + 26 * dpr, h * 0.88, gateX + 68 * dpr, h * 0.85);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Target particle count surges 2.4x in SURGE mode
      const targetParticles = isSurge ? 88 : 42;
      const particles = ribbonParticlesRef.current;
      while (particles.length < targetParticles) {
        const idx = particles.length;
        particles.push({
          t: (idx * 0.137) % 1,
          speed: 0.22 + (idx % 7) * 0.025,
          lane: ((idx % 5) - 2) * 0.45,
          kind: isDrift && idx % 4 === 0 ? 'drift' : isSurge ? 'gold' : 'normal',
          deflected: false,
          dlqT: 0,
          size: 2.3 + (idx % 3) * 0.65,
        });
      }
      if (particles.length > targetParticles) {
        particles.length = targetParticles;
      }

      const speedMult = isSurge ? 2.15 : 1.0;

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        if (p.deflected) {
          p.dlqT += dt * 1.45;
          if (p.dlqT >= 1) {
            p.t = 0;
            p.deflected = false;
            p.dlqT = 0;
            p.kind = isDrift && i % 4 === 0 ? 'drift' : isSurge ? 'gold' : 'normal';
          }
        } else {
          p.t += dt * p.speed * speedMult;
          if (isDrift && p.kind === 'drift' && p.t >= 0.71) {
            // Physically intercepted at dbt-test GATE! Never enters Gold!
            p.deflected = true;
            p.dlqT = 0;
          } else if (p.t >= 1) {
            p.t = 0;
            p.deflected = false;
            p.dlqT = 0;
            p.kind = isDrift && i % 4 === 0 ? 'drift' : isSurge || i % 3 === 0 ? 'gold' : 'normal';
          }
        }

        let px: number;
        let py: number;
        let col: string;

        if (p.deflected) {
          // Quadratic curve downward into DLQ quarantine trap
          const u = p.dlqT;
          const x0 = gateX;
          const y0 = pipeY + 3 * dpr;
          const xc = gateX + 26 * dpr;
          const yc = h * 0.88;
          const x1 = gateX + 68 * dpr;
          const y1 = h * 0.85;
          px = (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * xc + u * u * x1;
          py = (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * yc + u * u * y1;
          col = '#FB7185';
        } else {
          px = padX + p.t * spanW;
          py = pipeY + p.lane * 7.5 * dpr * Math.sin(p.t * Math.PI * 5 + i);
          if (p.kind === 'drift') {
            col = '#F43F5E';
          } else if (p.t > 0.74) {
            col = '#FACC15'; // Pure Gold Mart arrival
          } else if (p.t > 0.48) {
            col = '#38BDF8'; // Silver Cleaned
          } else if (p.t > 0.24) {
            col = '#FBBF24'; // Bronze Raw
          } else {
            col = isSurge ? '#FDE047' : '#34D399'; // Kafka CDC
          }
        }

        // Glow halo + crisp droplet core
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.26;
        ctx.beginPath();
        ctx.arc(px, py, p.size * 2.15 * dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.arc(px, py, p.size * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Render illuminated node pills on top of conduit (guaranteed zero clipping on 390px mobile)
      const pillH = 34 * dpr;
      const pillW = compact ? Math.floor((w - 14 * dpr) / 5) - 4 * dpr : 116 * dpr;
      for (let i = 0; i < nodes.length; i += 1) {
        const nd = nodes[i];
        const cx = padX + nd.u * spanW;
        const left = Math.max(4 * dpr, Math.min(w - pillW - 4 * dpr, cx - pillW * 0.5));
        const top = pipeY - pillH * 0.5;

        ctx.fillStyle = '#0D1628';
        ctx.strokeStyle = nd.color;
        ctx.lineWidth = (i === 3 && isDrift ? 1.9 : 1.15) * dpr;
        ctx.beginPath();
        ctx.roundRect(left, top, pillW, pillH, 6 * dpr);
        ctx.fill();
        ctx.stroke();

        // Flashing gate pulse ring when dbt-test intercepts schema drift
        if (i === 3 && isDrift) {
          const pulse = 0.35 + 0.45 * Math.abs(Math.sin(now * 0.008));
          ctx.strokeStyle = `rgba(244, 63, 94, ${pulse.toFixed(2)})`;
          ctx.lineWidth = 3 * dpr;
          ctx.beginPath();
          ctx.roundRect(left - 3 * dpr, top - 3 * dpr, pillW + 6 * dpr, pillH + 6 * dpr, 8 * dpr);
          ctx.stroke();
        }

        // Status dot
        ctx.fillStyle = nd.color;
        ctx.beginPath();
        ctx.arc(left + (compact ? 6 : 8) * dpr, top + 11 * dpr, (compact ? 2.1 : 2.6) * dpr, 0, Math.PI * 2);
        ctx.fill();

        // Title & metric text
        ctx.fillStyle = '#F8FAFC';
        ctx.font = `700 ${(compact ? 7.4 : 9.2) * dpr}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(nd.title, left + (compact ? 11 : 14) * dpr, top + 11.5 * dpr);

        ctx.fillStyle = nd.color;
        ctx.font = `600 ${(compact ? 7.2 : 8.8) * dpr}px "JetBrains Mono", monospace`;
        ctx.fillText(nd.sub, left + (compact ? 6 : 8) * dpr, top + 24.5 * dpr);
      }

      rafId = requestAnimationFrame(drawRibbon);
    };

    rafId = requestAnimationFrame(drawRibbon);
    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, []);

  // ============================================================================
  // PRIMARY 60FPS GPU STAGE CANVAS (2D 100K LASSO SCATTER | 3D OLAP CUBE | MEDALLION)
  // ============================================================================
  const stageCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const offscreenCloudRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenHashRef = useRef<string>('');

  const stateRefs = useRef({
    stageMode,
    activeBox,
    activePolygon,
    dragBrush,
    hoverDomain,
    cubeCamera,
    autoOrbit,
    selectedBeaconId,
    hoveredBeaconId,
    selectedStageNode,
    indexVersion,
    clusterBeacons,
  });
  stateRefs.current = {
    stageMode,
    activeBox,
    activePolygon,
    dragBrush,
    hoverDomain,
    cubeCamera,
    autoOrbit,
    selectedBeaconId,
    hoveredBeaconId,
    selectedStageNode,
    indexVersion,
    clusterBeacons,
  };

  // Drag-orbit refs for 3D Cube mode
  const orbitDragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });
  const cubeLiveYawRef = useRef(cubeCamera.yaw);
  const cubeLivePitchRef = useRef(cubeCamera.pitch);
  const cubeLiveZoomRef = useRef(cubeCamera.zoom);

  useEffect(() => {
    cubeLiveYawRef.current = cubeCamera.yaw;
    cubeLivePitchRef.current = cubeCamera.pitch;
    cubeLiveZoomRef.current = cubeCamera.zoom;
  }, [cubeCamera]);

  useEffect(() => {
    const canvas = stageCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let lastTs = performance.now();

    const syncStageSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(320, Math.floor(rect.width * dpr));
      const h = Math.max(260, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return dpr;
    };

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncStageSize) : null;
    ro?.observe(canvas);

    /**
     * Ultra-fast direct Uint32Array RGBA pixel-splat rasterizer for ALL 100,000+ points
     * into a cached offscreen HiDPI canvas (~1.8ms for 100K points -> 60fps butter!).
     */
    const ensureOffscreenCloud = (w: number, h: number, dpr: number, hasSelection: boolean) => {
      const idx = indexRef.current!;
      const box = stateRefs.current.activeBox;
      const polyLen = stateRefs.current.activePolygon?.length ?? 0;
      const isCompact = w / dpr < 640;
      const hash = `${w}x${h}|${isCompact ? 1 : 0}|${stateRefs.current.indexVersion}|${hasSelection ? 1 : 0}|${box ? `${box.minLatencyMs},${box.maxLatencyMs},${box.minRevenueUsd},${box.maxRevenueUsd}` : 'none'}|${polyLen}`;

      if (offscreenCloudRef.current && offscreenHashRef.current === hash) {
        return offscreenCloudRef.current;
      }

      if (!offscreenCloudRef.current) {
        offscreenCloudRef.current = document.createElement('canvas');
      }
      const off = offscreenCloudRef.current;
      if (off.width !== w || off.height !== h) {
        off.width = w;
        off.height = h;
      }
      const octx = off.getContext('2d');
      if (!octx) return off;

      const img = octx.createImageData(w, h);
      const buf32 = new Uint32Array(img.data.buffer);

      const { padL, padR, padT, padB } = getPlotPads(isCompact);
      const x0 = Math.floor(padL * w);
      const xSpan = Math.floor((1 - padL - padR) * w);
      const y0 = Math.floor(padT * h);
      const ySpan = Math.floor((1 - padT - padB) * h);

      const n = idx.count;
      const nx = idx.normX;
      const ny = idx.normY;
      const risk = idx.riskScore;
      const live = idx.isStreamingLive;
      const mask = idx.selectedMask;

      // Vivid high-contrast RGBA colors for dark obsidian GPU viewport
      const colNominal = packAbgr(34, 211, 238, hasSelection ? 58 : 148); // cyan-teal
      const colWatch = packAbgr(251, 191, 36, hasSelection ? 64 : 185); // amber-gold
      const colAnomaly = packAbgr(251, 113, 133, hasSelection ? 75 : 235); // glowing crimson-coral
      const colLiveStream = packAbgr(52, 211, 153, hasSelection ? 110 : 245); // emerald live arrival
      const colSelected = packAbgr(250, 204, 21, 255); // electric gold selected!
      const colSelectedHot = packAbgr(254, 240, 138, 255); // incandescent gold core for selected anomalies

      for (let i = 0; i < n; i += 1) {
        const px = x0 + ((nx[i] * xSpan) | 0);
        const py = y0 + (((1 - ny[i]) * ySpan) | 0);
        if (px <= 1 || px >= w - 2 || py <= 1 || py >= h - 2) continue;

        const isSel = hasSelection && mask[i] === 1;
        const rVal = risk[i];
        const isLive = live[i] === 1;

        let color: number;
        let big = false;
        if (isSel) {
          color = rVal >= 0.75 ? colSelectedHot : colSelected;
          big = true;
        } else if (isLive) {
          color = colLiveStream;
          big = true;
        } else if (rVal >= 0.75) {
          color = colAnomaly;
          big = !hasSelection;
        } else if (rVal >= 0.45) {
          color = colWatch;
        } else {
          color = colNominal;
        }

        const row = py * w + px;
        buf32[row] = color;
        if (big) {
          buf32[row + 1] = color;
          buf32[row + w] = color;
          buf32[row + w + 1] = color;
        } else if (rVal >= 0.45) {
          buf32[row + 1] = color;
        }
      }

      octx.putImageData(img, 0, 0);
      offscreenHashRef.current = hash;
      return off;
    };

    const draw2dLassoScatter = (w: number, h: number, dpr: number, now: number) => {
      const idx = indexRef.current!;
      const st = stateRefs.current;
      const isCompact = w / dpr < 640;
      const hasSelection = Boolean(st.activeBox || (st.activePolygon && st.activePolygon.length >= 3));

      // Deep obsidian analytical gradient backdrop
      const bg = ctx.createRadialGradient(w * 0.68, h * 0.28, 12, w * 0.5, h * 0.5, w * 0.78);
      bg.addColorStop(0, '#0F1B33');
      bg.addColorStop(0.55, '#091122');
      bg.addColorStop(1, '#060B16');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const { padL, padR, padT, padB } = getPlotPads(isCompact);
      const x0 = padL * w;
      const x1 = (1 - padR) * w;
      const y0 = padT * h;
      const y1 = (1 - padB) * h;
      const plotW = x1 - x0;
      const plotH = y1 - y0;

      // Subtle analytical coordinate gridlines & tick labels
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      ctx.font = `500 ${(isCompact ? 8.5 : 9.5) * dpr}px "JetBrains Mono", monospace`;
      ctx.fillStyle = 'rgba(148, 163, 184, 0.78)';

      // Horizontal revenue ticks
      const revTicks = [0, 1500, 3000, 4500, 6000];
      for (const rev of revTicks) {
        const ty = y1 - (rev / MAX_OLAP_REVENUE_USD) * plotH;
        ctx.beginPath();
        ctx.moveTo(x0, ty);
        ctx.lineTo(x1, ty);
        ctx.stroke();

        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`$${rev === 0 ? '0' : `${(rev / 1000).toFixed(1)}K`}`, x0 - 6 * dpr, ty);
      }

      // Vertical latency ticks
      const latTicks = isCompact ? [0, 250, 500, 750, 1000] : [0, 200, 400, 600, 800, 1000];
      for (const lat of latTicks) {
        const tx = x0 + (lat / MAX_OLAP_LATENCY_MS) * plotW;
        ctx.beginPath();
        ctx.moveTo(tx, y0);
        ctx.lineTo(tx, y1);
        ctx.stroke();

        ctx.textAlign = lat === 1000 && isCompact ? 'right' : 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(`${lat}ms`, tx, y1 + 5 * dpr);
      }

      // SLA 400ms vertical warning threshold line
      const slaX = x0 + (400 / MAX_OLAP_LATENCY_MS) * plotW;
      ctx.save();
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.35)';
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      ctx.moveTo(slaX, y0);
      ctx.lineTo(slaX, y1);
      ctx.stroke();
      ctx.restore();

      if (!isCompact) {
        ctx.fillStyle = 'rgba(251, 113, 133, 0.78)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = `600 ${8.5 * dpr}px "JetBrains Mono", monospace`;
        ctx.fillText('P99 SLA BREACH >400ms', slaX + 5 * dpr, y0 + 4 * dpr);
      }

      // Axis Titles
      ctx.fillStyle = 'rgba(203, 213, 225, 0.80)';
      ctx.font = `600 ${(isCompact ? 8.5 : 9.5) * dpr}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('SETTLEMENT LATENCY (ms) ->', x0 + plotW * 0.5, h - 11 * dpr);

      // Composite cached 100,000-point ImageData cloud!
      const cloudCanvas = ensureOffscreenCloud(w, h, dpr, hasSelection);
      ctx.drawImage(cloudCanvas, 0, 0);

      // Subtle animated sonar pulses on recent live CDC golden arrivals (top 22 newest points)
      if (idx.streamingLiveCount > 0) {
        const pulsePhase = (now * 0.0022) % 1;
        const startSlot = Math.max(idx.baseCount, idx.count - 22);
        for (let i = startSlot; i < idx.count; i += 1) {
          const px = x0 + idx.normX[i] * plotW;
          const py = y0 + (1 - idx.normY[i]) * plotH;
          const localPhase = (pulsePhase + (i % 7) * 0.14) % 1;
          const rad = (2.5 + localPhase * 11) * dpr;
          ctx.strokeStyle =
            idx.isAnomaly[i] === 1
              ? `rgba(251, 113, 133, ${(1 - localPhase) * 0.75})`
              : `rgba(250, 204, 21, ${(1 - localPhase) * 0.78})`;
          ctx.lineWidth = 1.4 * dpr;
          ctx.beginPath();
          ctx.arc(px, py, rad, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Subtle glowing cluster annotations so clusters are immediately legible
      if (!hasSelection) {
        const whaleCenter = domainToUv(695, 4850, isCompact);
        const wx = whaleCenter.u * w;
        const wy = whaleCenter.v * h;
        const pulse = 1 + 0.07 * Math.sin(now * 0.004);

        ctx.strokeStyle = 'rgba(251, 113, 133, 0.55)';
        ctx.lineWidth = 1.3 * dpr;
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.ellipse(wx, wy, (isCompact ? 46 : 74) * dpr * pulse, (isCompact ? 28 : 44) * dpr * pulse, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        if (!isCompact) {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
          ctx.strokeStyle = 'rgba(251, 113, 133, 0.75)';
          ctx.lineWidth = 1 * dpr;
          const lblW = 152 * dpr;
          const lblH = 20 * dpr;
          ctx.beginPath();
          ctx.roundRect(wx - lblW * 0.5, wy - 64 * dpr, lblW, lblH, 4 * dpr);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#FDA4AF';
          ctx.font = `700 ${8.6 * dpr}px "JetBrains Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('WHALE ANOMALIES · DRAG LASSO', wx, wy - 54 * dpr);
        }
      }

      // Draw active locked or in-progress Cyan Lasso Box
      const drawCyanBox = (u1: number, v1: number, u2: number, v2: number, activeDrag: boolean) => {
        const bx = Math.min(u1, u2) * w;
        const by = Math.min(v1, v2) * h;
        const bw = Math.abs(u2 - u1) * w;
        const bh = Math.abs(v2 - v1) * h;
        if (bw < 4 || bh < 4) return;

        // Luminous cyan interior glow
        ctx.fillStyle = activeDrag ? 'rgba(34, 211, 238, 0.16)' : 'rgba(34, 211, 238, 0.13)';
        ctx.fillRect(bx, by, bw, bh);

        // Glowing cyan border
        ctx.save();
        ctx.shadowColor = '#22D3EE';
        ctx.shadowBlur = 12 * dpr;
        ctx.strokeStyle = '#22D3EE';
        ctx.lineWidth = 2.0 * dpr;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.restore();

        // Precision corner brackets
        const br = 9 * dpr;
        ctx.strokeStyle = '#67E8F9';
        ctx.lineWidth = 2.6 * dpr;
        const corners = [
          [bx, by, 1, 1],
          [bx + bw, by, -1, 1],
          [bx, by + bh, 1, -1],
          [bx + bw, by + bh, -1, -1],
        ];
        for (const [cx, cy, sx, sy] of corners) {
          ctx.beginPath();
          ctx.moveTo(cx + sx * br, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + sy * br);
          ctx.stroke();
        }
      };

      if (st.dragBrush?.dragging) {
        if (st.dragBrush.mode === 'box') {
          drawCyanBox(
            st.dragBrush.startU,
            st.dragBrush.startV,
            st.dragBrush.curU,
            st.dragBrush.curV,
            true,
          );
        } else if (st.dragBrush.polygonUv.length > 1) {
          ctx.save();
          ctx.shadowColor = '#22D3EE';
          ctx.shadowBlur = 10 * dpr;
          ctx.strokeStyle = '#22D3EE';
          ctx.fillStyle = 'rgba(34, 211, 238, 0.15)';
          ctx.lineWidth = 2.2 * dpr;
          ctx.beginPath();
          st.dragBrush.polygonUv.forEach((pt, i) => {
            if (i === 0) ctx.moveTo(pt.u * w, pt.v * h);
            else ctx.lineTo(pt.u * w, pt.v * h);
          });
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      } else if (st.activeBox) {
        const tl = domainToUv(st.activeBox.minLatencyMs, st.activeBox.maxRevenueUsd, isCompact);
        const br = domainToUv(st.activeBox.maxLatencyMs, st.activeBox.minRevenueUsd, isCompact);
        drawCyanBox(tl.u, tl.v, br.u, br.v, false);
      } else if (st.activePolygon && st.activePolygon.length >= 3) {
        ctx.save();
        ctx.shadowColor = '#22D3EE';
        ctx.shadowBlur = 10 * dpr;
        ctx.strokeStyle = '#22D3EE';
        ctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
        ctx.lineWidth = 2.2 * dpr;
        ctx.beginPath();
        st.activePolygon.forEach((pt, i) => {
          const uv = domainToUv(pt.latencyMs, pt.revenueUsd, isCompact);
          if (i === 0) ctx.moveTo(uv.u * w, uv.v * h);
          else ctx.lineTo(uv.u * w, uv.v * h);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Live subtle crosshair on pointer hover
      if (st.hoverDomain && !st.dragBrush?.dragging) {
        const huv = domainToUv(st.hoverDomain.latencyMs, st.hoverDomain.revenueUsd, isCompact);
        const hx = huv.u * w;
        const hy = huv.v * h;
        ctx.strokeStyle = 'rgba(103, 232, 249, 0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx, y0);
        ctx.lineTo(hx, y1);
        ctx.moveTo(x0, hy);
        ctx.lineTo(x1, hy);
        ctx.stroke();
      }
    };

    const draw3dOlapCube = (w: number, h: number, dpr: number, dt: number, now: number) => {
      const idx = indexRef.current!;
      const st = stateRefs.current;

      if (st.autoOrbit && !orbitDragRef.current.active) {
        cubeLiveYawRef.current += dt * 0.22;
      }

      const cam: Cube3dCamera = {
        yaw: cubeLiveYawRef.current,
        pitch: cubeLivePitchRef.current,
        zoom: cubeLiveZoomRef.current,
      };

      // Deep space analytical radial backdrop
      const bg = ctx.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, w * 0.72);
      bg.addColorStop(0, '#101C36');
      bg.addColorStop(0.58, '#081021');
      bg.addColorStop(1, '#050914');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const P = (nx: number, ny: number, nz: number) => project3dCubePoint(nx, ny, nz, cam, w, h);

      // Draw illuminated 3D floor grid (Risk Z = 0)
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.16)';
      ctx.lineWidth = 1 * dpr;
      for (let g = 0; g <= 5; g += 1) {
        const f = g / 5;
        const a1 = P(f, 0, 0);
        const b1 = P(f, 1, 0);
        ctx.beginPath();
        ctx.moveTo(a1.sx, a1.sy);
        ctx.lineTo(b1.sx, b1.sy);
        ctx.stroke();

        const a2 = P(0, f, 0);
        const b2 = P(1, f, 0);
        ctx.beginPath();
        ctx.moveTo(a2.sx, a2.sy);
        ctx.lineTo(b2.sx, b2.sy);
        ctx.stroke();
      }

      // Draw translucent 3D wireframe bounding cube
      const cubeEdges: [[number, number, number], [number, number, number]][] = [
        [[0, 0, 0], [1, 0, 0]],
        [[1, 0, 0], [1, 1, 0]],
        [[1, 1, 0], [0, 1, 0]],
        [[0, 1, 0], [0, 0, 0]],
        [[0, 0, 1], [1, 0, 1]],
        [[1, 0, 1], [1, 1, 1]],
        [[1, 1, 1], [0, 1, 1]],
        [[0, 1, 1], [0, 0, 1]],
        [[0, 0, 0], [0, 0, 1]],
        [[1, 0, 0], [1, 0, 1]],
        [[1, 1, 0], [1, 1, 1]],
        [[0, 1, 0], [0, 1, 1]],
      ];

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
      ctx.lineWidth = 1.15 * dpr;
      for (const [p0, p1] of cubeEdges) {
        const a = P(p0[0], p0[1], p0[2]);
        const b = P(p1[0], p1[1], p1[2]);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }

      // Risk = 0.75 Anomaly Elevation Plane (glowing crimson horizontal plane inside cube!)
      const planeCorners = [P(0, 0, 0.75), P(1, 0, 0.75), P(1, 1, 0.75), P(0, 1, 0.75)];
      ctx.fillStyle = 'rgba(244, 63, 94, 0.065)';
      ctx.strokeStyle = 'rgba(251, 113, 133, 0.34)';
      ctx.lineWidth = 1.1 * dpr;
      ctx.beginPath();
      ctx.moveTo(planeCorners[0].sx, planeCorners[0].sy);
      for (let c = 1; c < 4; c += 1) ctx.lineTo(planeCorners[c].sx, planeCorners[c].sy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Highlighted 3 Principal Axes (X: Latency Cyan, Y: Revenue Emerald, Z: Risk Coral)
      const origin = P(0, 0, 0);
      const axes = [
        { end: P(1.06, 0, 0), col: '#22D3EE', label: 'X · LATENCY (0-1000ms)' },
        { end: P(0, 1.06, 0), col: '#34D399', label: 'Y · REVENUE ($0-$6.5K)' },
        { end: P(0, 0, 1.08), col: '#FB7185', label: 'Z · RISK SCORE (0-1.0)' },
      ];
      for (const ax of axes) {
        ctx.strokeStyle = ax.col;
        ctx.lineWidth = 2.2 * dpr;
        ctx.beginPath();
        ctx.moveTo(origin.sx, origin.sy);
        ctx.lineTo(ax.end.sx, ax.end.sy);
        ctx.stroke();

        ctx.fillStyle = ax.col;
        ctx.font = `700 ${9.2 * dpr}px "JetBrains Mono", monospace`;
        ctx.textAlign = ax.end.sx >= origin.sx ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(ax.label, ax.end.sx + (ax.end.sx >= origin.sx ? 6 : -6) * dpr, ax.end.sy);
      }

      // Render high-density 3D OLAP point cloud (strided for crisp 60fps + 100% of anomalies & live gold!)
      const n = idx.count;
      const nx = idx.normX;
      const ny = idx.normY;
      const nz = idx.normZ;
      const risk = idx.riskScore;
      const live = idx.isStreamingLive;

      const cosY = Math.cos(cam.yaw);
      const sinY = Math.sin(cam.yaw);
      const cosP = Math.cos(cam.pitch);
      const sinP = Math.sin(cam.pitch);
      const focal = Math.min(w, h) * 0.98 * cam.zoom;
      const halfW = w > 720 * dpr ? w * 0.56 : w * 0.5;
      const halfH = h * 0.52;

      for (let i = 0; i < n; i += 1) {
        const rVal = risk[i];
        const isLive = live[i] === 1;
        // Include 100% of anomalies & live points, 1-in-4 watch, 1-in-7 nominal => ~22,000 crisp 3D points @ 60fps
        if (!isLive && rVal < 0.75) {
          if (rVal >= 0.45 && (i & 3) !== 0) continue;
          if (rVal < 0.45 && i % 7 !== 0) continue;
        }

        const cx = (nx[i] - 0.5) * 2.05;
        const cy = (nz[i] - 0.5) * 1.85;
        const cz = (ny[i] - 0.5) * 2.05;

        const rx = cx * cosY - cz * sinY;
        const rz0 = cx * sinY + cz * cosY;
        const ry = cy * cosP - rz0 * sinP;
        const rz = cy * sinP + rz0 * cosP;
        const zDepth = 3.95 - rz;
        if (zDepth <= 0.5) continue;

        const invZ = focal / zDepth;
        const sx = halfW + rx * invZ;
        const sy = halfH - ry * invZ;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;

        const depthFade = Math.max(0.30, Math.min(1, (5.5 - zDepth) / 3.2));
        const sz = (rVal >= 0.75 || isLive ? 2.6 : 1.7) * dpr * (0.72 + depthFade * 0.45);

        if (isLive) {
          ctx.fillStyle = `rgba(250, 204, 21, ${(0.90 * depthFade).toFixed(2)})`;
        } else if (rVal >= 0.75) {
          ctx.fillStyle = `rgba(251, 113, 133, ${(0.92 * depthFade).toFixed(2)})`;
        } else if (rVal >= 0.45) {
          ctx.fillStyle = `rgba(251, 191, 36, ${(0.62 * depthFade).toFixed(2)})`;
        } else {
          ctx.fillStyle = `rgba(34, 211, 238, ${(0.48 * depthFade).toFixed(2)})`;
        }
        ctx.fillRect(sx - sz * 0.5, sy - sz * 0.5, sz, sz);
      }

      // Draw interactive 3D Cluster Beacons with smart radial leader-line callouts (ZERO overlap!)
      const calloutOffsets: Record<string, { dx: number; dy: number }> = {
        'cluster-whale': { dx: 96, dy: -42 },
        'cluster-voucher-bots': { dx: 112, dy: 14 },
        'cluster-watch-band': { dx: -116, dy: -22 },
        'cluster-nominal-core': { dx: -110, dy: 28 },
      };

      const beacons = st.clusterBeacons;
      for (const b of beacons) {
        const pt = P(b.cx, b.cy, b.cz);
        const floorPt = P(b.cx, b.cy, 0);
        const isSelected = b.id === st.selectedBeaconId;
        const isHover = b.id === st.hoveredBeaconId;
        const col =
          b.severity === 'critical' ? '#FB7185' : b.severity === 'watch' ? '#FBBF24' : '#22D3EE';

        // Vertical drop line to floor
        ctx.strokeStyle = col;
        ctx.globalAlpha = isSelected ? 0.65 : 0.3;
        ctx.lineWidth = (isSelected ? 1.6 : 1) * dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(pt.sx, pt.sy);
        ctx.lineTo(floorPt.sx, floorPt.sy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // Pulsing beacon rings
        const ringPulse = 1 + 0.22 * Math.sin(now * 0.005 + (b.severity === 'critical' ? 0 : 2));
        ctx.strokeStyle = isSelected ? '#FACC15' : col;
        ctx.lineWidth = (isSelected || isHover ? 2.2 : 1.4) * dpr;
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, (isSelected ? 13 : 9.5) * dpr * ringPulse, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = isSelected ? '#FACC15' : col;
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, 4.4 * dpr, 0, Math.PI * 2);
        ctx.fill();

        // Crisp floating cluster pill label positioned along clean radial callout vector
        const off = calloutOffsets[b.id] ?? { dx: 0, dy: -30 };
        const scaleCompact = w / dpr < 640 ? 0.55 : 1.0;
        const tag = `${b.label.split(' ').slice(0, 2).join(' ')} (${b.count.toLocaleString()})`;
        ctx.font = `700 ${8.8 * dpr}px "JetBrains Mono", monospace`;
        const tw = ctx.measureText(tag).width + 14 * dpr;
        const th = 19 * dpr;
        const cxLbl = pt.sx + off.dx * dpr * scaleCompact;
        const cyLbl = pt.sy + off.dy * dpr * scaleCompact;
        const lx = Math.max(8 * dpr, Math.min(w - tw - 8 * dpr, cxLbl - tw * 0.5));
        const ly = Math.max(8 * dpr, Math.min(h - th - 8 * dpr, cyLbl - th * 0.5));

        // Subtle leader line connecting beacon core to pill
        ctx.strokeStyle = isSelected ? 'rgba(250, 204, 21, 0.72)' : col;
        ctx.globalAlpha = 0.65;
        ctx.lineWidth = 1.1 * dpr;
        ctx.beginPath();
        ctx.moveTo(pt.sx, pt.sy);
        ctx.lineTo(lx + tw * 0.5, ly + th * 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.fillStyle = 'rgba(9, 15, 30, 0.92)';
        ctx.strokeStyle = isSelected ? '#FACC15' : col;
        ctx.lineWidth = (isSelected ? 1.6 : 1.1) * dpr;
        ctx.beginPath();
        ctx.roundRect(lx, ly, tw, th, 4 * dpr);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isSelected ? '#FEF08A' : '#F8FAFC';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, lx + tw * 0.5, ly + th * 0.5);
      }
    };

    const drawFullMedallionStage = (w: number, h: number, dpr: number, now: number) => {
      const pState = pipelineRef.current;
      const isSurge = pState.streamingMode === 'SURGE';
      const isDrift = pState.schemaDriftActive;

      // Clean blueprint grid backdrop
      const bg = ctx.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, '#070E1D');
      bg.addColorStop(1, '#0C172E');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.07)';
      ctx.lineWidth = 1;
      const gridStep = 28 * dpr;
      for (let x = 0; x < w; x += gridStep) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const compact = w / dpr < 640;
      const mainY = h * 0.36;
      const dlqY = h * 0.78;
      const marginX = w * 0.08;
      const span = w - marginX * 2;

      const stageBoxes = [
        {
          id: 'kafka',
          x: marginX,
          y: mainY,
          title: 'KAFKA CDC',
          sub: `+${(pState.kafkaRateRowsSec / 1000).toFixed(1)}K rows/s`,
          detail: isSurge ? 'SURGE MODE · 4 PARTITIONS' : 'STEADY STREAM · P0-P3',
          color: isSurge ? '#FACC15' : '#10B981',
        },
        {
          id: 'bronze',
          x: marginX + span * 0.25,
          y: mainY,
          title: 'BRONZE RAW',
          sub: `${pState.bronzeRawRows.toLocaleString()} rows`,
          detail: 'Iceberg Append-Only Log',
          color: '#F59E0B',
        },
        {
          id: 'silver',
          x: marginX + span * 0.50,
          y: mainY,
          title: 'SILVER CLEAN',
          sub: `${pState.silverCleanedRows.toLocaleString()} rows`,
          detail: `Deduped ${pState.silverDedupedRows.toLocaleString()}`,
          color: '#38BDF8',
        },
        {
          id: 'dbt_gate',
          x: marginX + span * 0.75,
          y: mainY,
          title: 'dbt-test GATE',
          sub: isDrift ? 'INTERCEPTING DRIFT' : 'ALL CONTRACTS PASS',
          detail: isDrift ? '3 Rules Blocking Bad Rows' : 'not_null · range · schema',
          color: isDrift ? '#F43F5E' : '#10B981',
        },
        {
          id: 'gold',
          x: marginX + span,
          y: mainY,
          title: 'GOLD MART',
          sub: `${pState.goldMartRows.toLocaleString()} rows`,
          detail: '0 CORRUPTED · OLAP LIVE',
          color: '#FACC15',
        },
      ];

      // Draw primary multi-lane streaming highway
      for (let s = 0; s < stageBoxes.length - 1; s += 1) {
        const a = stageBoxes[s];
        const b = stageBoxes[s + 1];
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, a.color);
        g.addColorStop(1, b.color);
        ctx.strokeStyle = g;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = (isSurge ? 4.5 : 3) * dpr;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Draw Quarantine DLQ curved deflection branch into centered DLQ Vault (leaves right side clear for Active Interceptions card!)
      const gateNode = stageBoxes[3];
      const dlqX = compact ? w * 0.5 : w * 0.48;
      ctx.strokeStyle = isDrift ? '#F43F5E' : 'rgba(244, 63, 94, 0.4)';
      ctx.lineWidth = (isDrift ? 3 : 1.8) * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(gateNode.x, gateNode.y + 34 * dpr);
      ctx.quadraticCurveTo(gateNode.x, dlqY, dlqX + (compact ? 0 : 126 * dpr), dlqY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Animated high-visibility data droplets along the full Medallion highway
      const dropletCount = isSurge ? 76 : 38;
      for (let i = 0; i < dropletCount; i += 1) {
        const speed = (isSurge ? 0.44 : 0.22) + (i % 5) * 0.03;
        const rawT = (now * 0.001 * speed + i / dropletCount) % 1;
        const isDriftDrop = isDrift && i % 4 === 0;

        let px: number;
        let py: number;
        let col: string;

        if (isDriftDrop && rawT >= 0.72) {
          // Deflected smoothly along quadratic arc from dbt-test GATE into centered Quarantine DLQ vault!
          const u = Math.min(1, (rawT - 0.72) / 0.28);
          const x0 = gateNode.x;
          const y0 = mainY + 24 * dpr;
          const xc = gateNode.x;
          const yc = dlqY;
          const x1 = dlqX + (compact ? 0 : 118 * dpr);
          const y1 = dlqY;
          px = (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * xc + u * u * x1;
          py = (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * yc + u * u * y1;
          col = '#FB7185';
        } else {
          px = marginX + rawT * span;
          py = mainY + Math.sin(rawT * 14 + i) * 9 * dpr;
          col = isDriftDrop
            ? '#F43F5E'
            : rawT > 0.75
              ? '#FACC15'
              : rawT > 0.5
                ? '#38BDF8'
                : rawT > 0.25
                  ? '#FBBF24'
                  : '#34D399';
        }

        ctx.fillStyle = col;
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.arc(px, py, 6.2 * dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.98;
        ctx.beginPath();
        ctx.arc(px, py, 2.8 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Render large crisp architectural cards for each Medallion stage
      const boxW = (compact ? 68 : 138) * dpr;
      const boxH = (compact ? 60 : 72) * dpr;

      for (const node of stageBoxes) {
        const isSel = stateRefs.current.selectedStageNode === node.id;
        const left = Math.max(6 * dpr, Math.min(w - boxW - 6 * dpr, node.x - boxW * 0.5));
        const top = node.y - boxH * 0.5;

        ctx.fillStyle = '#0D172B';
        ctx.strokeStyle = isSel ? '#FFFFFF' : node.color;
        ctx.lineWidth = (isSel || (node.id === 'dbt_gate' && isDrift) ? 2.2 : 1.4) * dpr;
        ctx.beginPath();
        ctx.roundRect(left, top, boxW, boxH, 8 * dpr);
        ctx.fill();
        ctx.stroke();

        // Top color bar
        ctx.fillStyle = node.color;
        ctx.fillRect(left + 8 * dpr, top, boxW - 16 * dpr, 3 * dpr);

        ctx.fillStyle = '#F8FAFC';
        ctx.font = `700 ${(compact ? 8.5 : 10.5) * dpr}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.title, left + boxW * 0.5, top + 20 * dpr);

        ctx.fillStyle = node.color;
        ctx.font = `700 ${(compact ? 8 : 10.5) * dpr}px "JetBrains Mono", monospace`;
        ctx.fillText(node.sub, left + boxW * 0.5, top + 39 * dpr);

        if (!compact) {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.86)';
          ctx.font = `500 ${8.2 * dpr}px "JetBrains Mono", monospace`;
          ctx.fillText(node.detail, left + boxW * 0.5, top + 57 * dpr);
        }
      }

      // Quarantine DLQ Vault Card (generous width, zero overlap with right-hand alerts card!)
      const dlqW = (compact ? 250 : 276) * dpr;
      const dlqH = 62 * dpr;
      const dlqLeft = Math.max(8 * dpr, Math.min(w - dlqW - 8 * dpr, dlqX - dlqW * 0.5));
      const dlqTop = dlqY - dlqH * 0.5;

      ctx.fillStyle = isDrift ? 'rgba(127, 29, 29, 0.50)' : 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = isDrift ? '#F43F5E' : 'rgba(244, 63, 94, 0.45)';
      ctx.lineWidth = (isDrift ? 2 : 1.2) * dpr;
      ctx.beginPath();
      ctx.roundRect(dlqLeft, dlqTop, dlqW, dlqH, 8 * dpr);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FDA4AF';
      ctx.font = `700 ${9.4 * dpr}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('QUARANTINE DLQ VAULT (dbt-test)', dlqLeft + dlqW * 0.5, dlqTop + 20 * dpr);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = `700 ${10.2 * dpr}px "JetBrains Mono", monospace`;
      ctx.fillText(
        `${pState.quarantineDlqRows.toLocaleString()} ISOLATED · 0 GOLD CORRUPT`,
        dlqLeft + dlqW * 0.5,
        dlqTop + 42 * dpr,
      );

      // Left-side Live Throughput Sparkline Card inside Medallion View
      if (!compact) {
        const spW = 246 * dpr;
        const spH = 62 * dpr;
        const spX = Math.max(14 * dpr, marginX - 42 * dpr);
        const spY = dlqY - spH * 0.5;

        ctx.fillStyle = 'rgba(13, 23, 43, 0.9)';
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        ctx.roundRect(spX, spY, spW, spH, 8 * dpr);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
        ctx.font = `600 ${8.5 * dpr}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(
          `WATERMARK ${pState.watermarkIso} · E2E ${pState.latencyBronzeToGoldMs}ms`,
          spX + 10 * dpr,
          spY + 15 * dpr,
        );

        const rates = pState.rateSparkline;
        const maxR = Math.max(13_000, ...rates);
        ctx.strokeStyle = isSurge ? '#FACC15' : '#34D399';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        rates.forEach((val, idxR) => {
          const rx = spX + 10 * dpr + (idxR / Math.max(1, rates.length - 1)) * (spW - 20 * dpr);
          const ry = spY + spH - 10 * dpr - (val / maxR) * (spH - 30 * dpr);
          if (idxR === 0) ctx.moveTo(rx, ry);
          else ctx.lineTo(rx, ry);
        });
        ctx.stroke();
      }
    };

    const renderLoop = (now: number) => {
      const dpr = syncStageSize();
      const dt = Math.min(0.05, Math.max(0.004, (now - lastTs) / 1000));
      lastTs = now;
      const w = canvas.width;
      const h = canvas.height;
      const mode = stateRefs.current.stageMode;

      if (mode === 'scatter2d') {
        draw2dLassoScatter(w, h, dpr, now);
      } else if (mode === 'cube3d') {
        draw3dOlapCube(w, h, dpr, dt, now);
      } else {
        drawFullMedallionStage(w, h, dpr, now);
      }

      rafId = requestAnimationFrame(renderLoop);
    };

    rafId = requestAnimationFrame(renderLoop);
    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, []);

  // ============================================================================
  // POINTER INTERACTION HANDLERS (2D Direct Lasso Brush + 3D Orbit & Beacon Click)
  // ============================================================================
  const getPointerUv = (clientX: number, clientY: number) => {
    const el = stageWrapRef.current;
    if (!el) return { u: 0.5, v: 0.5, px: 0, py: 0, w: 1, h: 1 };
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return {
      u: Math.max(0, Math.min(1, px / Math.max(1, rect.width))),
      v: Math.max(0, Math.min(1, py / Math.max(1, rect.height))),
      px,
      py,
      w: rect.width,
      h: rect.height,
    };
  };

  const findNearestBeacon = (px: number, py: number, w: number, h: number): OlapClusterBeacon | null => {
    const cam: Cube3dCamera = {
      yaw: cubeLiveYawRef.current,
      pitch: cubeLivePitchRef.current,
      zoom: cubeLiveZoomRef.current,
    };
    let best: OlapClusterBeacon | null = null;
    let bestDist = 34;
    for (const b of clusterBeacons) {
      const pt = project3dCubePoint(b.cx, b.cy, b.cz, cam, w, h);
      const d = Math.hypot(pt.sx - px, pt.sy - py);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { u, v, px, py, w, h } = getPointerUv(e.clientX, e.clientY);

    if (stageMode === 'scatter2d') {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDragBrush({
        mode: lassoTool,
        startU: u,
        startV: v,
        curU: u,
        curV: v,
        polygonUv: [{ u, v }],
        dragging: true,
      });
    } else if (stageMode === 'cube3d') {
      const hit = findNearestBeacon(px, py, w, h);
      if (hit) {
        setSelectedBeaconId(hit.id);
        setActivePolygon(null);
        setActiveBox(hit.presetBox);
        return;
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setAutoOrbit(false);
      orbitDragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
    } else if (stageMode === 'medallion') {
      // Allow clicking stage columns to inspect telemetry
      if (v > 0.58) {
        setSelectedStageNode('dlq');
      } else if (u < 0.2) {
        setSelectedStageNode('kafka');
      } else if (u < 0.4) {
        setSelectedStageNode('bronze');
      } else if (u < 0.6) {
        setSelectedStageNode('silver');
      } else if (u < 0.82) {
        setSelectedStageNode('dbt_gate');
      } else {
        setSelectedStageNode('gold');
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const { u, v, px, py, w, h } = getPointerUv(e.clientX, e.clientY);

    if (stageMode === 'scatter2d') {
      setHoverDomain(uvToDomain(u, v, w < 640));
      if (!dragBrush?.dragging) return;
      if (dragBrush.mode === 'box') {
        setDragBrush((prev) => (prev ? { ...prev, curU: u, curV: v } : null));
      } else {
        setDragBrush((prev) => {
          if (!prev) return null;
          const last = prev.polygonUv[prev.polygonUv.length - 1];
          if (last && Math.hypot(u - last.u, v - last.v) < 0.012) return prev;
          return {
            ...prev,
            curU: u,
            curV: v,
            polygonUv: [...prev.polygonUv, { u, v }],
          };
        });
      }
    } else if (stageMode === 'cube3d') {
      if (orbitDragRef.current.active) {
        const dx = e.clientX - orbitDragRef.current.lastX;
        const dy = e.clientY - orbitDragRef.current.lastY;
        orbitDragRef.current.lastX = e.clientX;
        orbitDragRef.current.lastY = e.clientY;
        cubeLiveYawRef.current += dx * 0.008;
        cubeLivePitchRef.current = Math.max(
          -0.95,
          Math.min(1.15, cubeLivePitchRef.current + dy * 0.007),
        );
      } else {
        const hit = findNearestBeacon(px, py, w, h);
        setHoveredBeaconId(hit ? hit.id : null);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (stageMode === 'scatter2d' && dragBrush?.dragging) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      const { u, v, w } = getPointerUv(e.clientX, e.clientY);
      const isCompact = w < 640;

      if (dragBrush.mode === 'box') {
        const du = Math.abs(u - dragBrush.startU);
        const dv = Math.abs(v - dragBrush.startV);
        if (du > 0.014 && dv > 0.014) {
          const pA = uvToDomain(dragBrush.startU, dragBrush.startV, isCompact);
          const pB = uvToDomain(u, v, isCompact);
          setActivePolygon(null);
          setActiveBox({
            minLatencyMs: Math.min(pA.latencyMs, pB.latencyMs),
            maxLatencyMs: Math.max(pA.latencyMs, pB.latencyMs),
            minRevenueUsd: Math.min(pA.revenueUsd, pB.revenueUsd),
            maxRevenueUsd: Math.max(pA.revenueUsd, pB.revenueUsd),
            label: 'Custom Lasso Brush',
          });
        }
      } else if (dragBrush.polygonUv.length >= 4) {
        const polyDomain = dragBrush.polygonUv.map((pt) => uvToDomain(pt.u, pt.v, isCompact));
        setActiveBox(null);
        setActivePolygon(polyDomain);
      }
      setDragBrush(null);
    } else if (stageMode === 'cube3d' && orbitDragRef.current.active) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      orbitDragRef.current.active = false;
      setCubeCamera({
        yaw: cubeLiveYawRef.current,
        pitch: cubeLivePitchRef.current,
        zoom: cubeLiveZoomRef.current,
      });
    }
  };

  const activeBeacon = useMemo(
    () => clusterBeacons.find((b) => b.id === selectedBeaconId) ?? clusterBeacons[0],
    [clusterBeacons, selectedBeaconId],
  );

  const hasCustomBrush = Boolean(activeBox || (activePolygon && activePolygon.length >= 3));
  const totalPointsNow = indexRef.current?.count ?? 100_000;

  return (
    <section
      data-testid="interactive-olap-stage"
      className="nexus-panel rounded-lg overflow-hidden border border-[var(--border-strong)]/80"
    >
      {/* Top Analytical Control Header (Hex x MotherDuck Daylight Chrome) */}
      <div className="px-3 sm:px-4 py-2.5 bg-[var(--bg-surface)] nexus-hairline-b flex flex-wrap items-center justify-between gap-2">
        {/* Title & Live Telemetry Pill */}
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="w-2 h-2 rounded-full bg-[var(--accent-emerald)] animate-telemetry-dot shrink-0" />
            <h1 className="font-display font-bold text-xs sm:text-sm tracking-tight leading-snug text-[var(--text-primary)] m-0">
              {locale === 'vi'
                ? 'TRẠM KHÁM PHÁ OLAP GPU 100K ĐIỂM & MEDALLION CDC'
                : 'GPU 100K-ROW OLAP ANOMALY EXPLORER & MEDALLION CDC'}
            </h1>
          </div>
          <span
            data-testid="olap-point-count-badge"
            className="font-mono-tech text-[10px] px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-hairline)] text-[var(--text-secondary)] tabular-nums"
          >
            {totalPointsNow.toLocaleString()} PTS · {selectionResult.queryTimeMs.toFixed(1)}ms INDEX
          </span>
        </div>

        {/* 3-Way Interactive Mode Switcher */}
        <div
          role="tablist"
          aria-label="OLAP Stage View Mode"
          className="flex flex-wrap items-center gap-1 p-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--border-hairline)]"
        >
          {(
            [
              {
                id: 'scatter2d',
                label: '2D GPU LASSO BRUSH-TO-SQL',
                short: '2D LASSO',
                Icon: Crosshair,
              },
              {
                id: 'cube3d',
                label: '3D OLAP ANOMALY CUBE',
                short: '3D CUBE',
                Icon: Box,
              },
              {
                id: 'medallion',
                label: 'LIVE MEDALLION PIPELINE',
                short: 'MEDALLION',
                Icon: GitBranch,
              },
            ] as const
          ).map(({ id, label, short, Icon }) => {
            const active = stageMode === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`olap-mode-${id}`}
                onClick={() => setStageMode(id)}
                className={`px-2 sm:px-2.5 py-1 rounded-[5px] font-mono-tech text-[10px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                  active
                    ? 'bg-[var(--accent-signal)] text-white shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                }`}
              >
                <Icon className="w-3 h-3 shrink-0" />
                <span className="hidden xl:inline">{label}</span>
                <span className="xl:hidden">{short}</span>
              </button>
            );
          })}
        </div>

        {/* 1-Click Live Kafka CDC Surge & Schema Drift dbt Gate Controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="btn-surge-cdc"
            onClick={handleToggleSurge}
            className={`px-2.5 py-1 rounded-md border font-mono-tech text-[10px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              pipeline.streamingMode === 'SURGE'
                ? 'bg-[#D97706] border-[#B45309] text-white shadow-sm'
                : 'bg-[var(--accent-emerald-soft)] border-[var(--accent-emerald)]/40 text-[var(--accent-emerald)] hover:bg-[var(--accent-emerald)] hover:text-white'
            }`}
          >
            <Zap className="w-3 h-3 shrink-0" />
            <span>
              {pipeline.streamingMode === 'SURGE'
                ? `SURGING +${(pipeline.kafkaRateRowsSec / 1000).toFixed(1)}K/s`
                : 'SURGE KAFKA CDC (+10K/s)'}
            </span>
          </button>

          <button
            type="button"
            data-testid="btn-inject-drift"
            onClick={handleToggleSchemaDrift}
            className={`px-2.5 py-1 rounded-md border font-mono-tech text-[10px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              pipeline.schemaDriftActive
                ? 'bg-[#DC2626] border-[#991B1B] text-white shadow-sm'
                : 'bg-[var(--accent-crimson-soft)] border-[var(--accent-crimson)]/40 text-[var(--accent-crimson)] hover:bg-[var(--accent-crimson)] hover:text-white'
            }`}
          >
            <ShieldAlert className="w-3 h-3 shrink-0" />
            <span>
              {pipeline.schemaDriftActive
                ? `DRIFT ACTIVE · DLQ ${pipeline.quarantineDlqRows.toLocaleString()}`
                : 'INJECT SCHEMA DRIFT (DBT GATE)'}
            </span>
          </button>
        </div>
      </div>

      {/* Deep Obsidian GPU Analytical Viewport Frame */}
      <div className="bg-[#070C18] text-slate-100">
        {/* Continuous 60fps Animated Bronze -> Silver -> dbt-test Gate -> Gold Streaming Ribbon */}
        <div className="relative h-[56px] w-full overflow-hidden">
          <canvas
            ref={ribbonCanvasRef}
            data-testid="medallion-ribbon-canvas"
            className="w-full h-full block"
          />
        </div>

        {/* Dedicated Non-Overlapping dbt-test Quarantine Alert Banner when Schema Drift is active */}
        {pipeline.schemaDriftActive && (
          <div
            data-testid="dbt-quarantine-live-badge"
            className="px-3 py-1 bg-rose-950/90 border-y border-rose-500/60 font-mono-tech text-[10px] font-bold text-rose-100 flex flex-wrap items-center justify-between gap-2"
          >
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span>
                dbt-test QUARANTINE GATE INTERCEPTING DRIFT: {pipeline.quarantineDlqRows.toLocaleString()} DLQ
              </span>
            </span>
            <span className="text-emerald-300">0 GOLD CORRUPT · 100% CONTRACT PROTECTED</span>
          </div>
        )}

        {/* Interactive Stage Action Toolbar inside GPU Frame */}
        <div className="px-3 py-1.5 bg-[#0A1224] border-b border-slate-800/90 flex flex-wrap items-center justify-between gap-2">
          {stageMode === 'scatter2d' && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Box vs Freehand Lasso Selector */}
                <div className="inline-flex rounded bg-slate-900 border border-slate-700/80 p-0.5">
                  <button
                    type="button"
                    data-testid="tool-lasso-box"
                    onClick={() => setLassoTool('box')}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono-tech font-semibold flex items-center gap-1 cursor-pointer ${
                      lassoTool === 'box'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/50'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <SquareDashedMousePointer className="w-3 h-3" />
                    <span>Box</span>
                  </button>
                  <button
                    type="button"
                    data-testid="tool-lasso-freehand"
                    onClick={() => setLassoTool('polygon')}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono-tech font-semibold flex items-center gap-1 cursor-pointer ${
                      lassoTool === 'polygon'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/50'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Lasso className="w-3 h-3" />
                    <span>Freehand</span>
                  </button>
                </div>

                {/* 1-Click High-Value Preset Brushes */}
                {OLAP_BRUSH_PRESETS.map((preset) => {
                  const isActive = activeBox?.label === preset.box.label;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      data-testid={`preset-${preset.id}`}
                      onClick={() => handleApplyPreset(preset.box)}
                      title={preset.description}
                      className={`px-2 py-0.5 rounded font-mono-tech text-[10px] font-semibold border transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-amber-400/20 border-amber-400 text-amber-200'
                          : preset.id === 'whale_anomalies'
                            ? 'bg-rose-500/15 border-rose-400/50 text-rose-200 hover:bg-rose-500/25'
                            : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-cyan-400/60 hover:text-cyan-200'
                      }`}
                    >
                      <span className="hidden 2xl:inline">{preset.label}</span>
                      <span className="2xl:hidden">
                        {preset.id === 'whale_anomalies' ? 'Select Whale Anomalies' : preset.shortLabel}
                      </span>
                    </button>
                  );
                })}

                {hasCustomBrush && (
                  <button
                    type="button"
                    data-testid="btn-clear-brush"
                    onClick={handleClearBrush}
                    className="px-2 py-0.5 rounded font-mono-tech text-[10px] font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 flex items-center gap-1 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                    <span>Clear Brush</span>
                  </button>
                )}
              </div>

              {/* Compact Color Legend + Live Pointer Telemetry */}
              <div className="flex flex-wrap items-center gap-3 font-mono-tech text-[9.5px] text-slate-300">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-cyan-400" /> Nominal
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-400" /> Watch
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-rose-400" /> Anomaly
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-yellow-300" />
                  {hasCustomBrush ? 'Selected' : 'Live Gold'}
                </span>
                {hoverDomain && (
                  <span className="hidden lg:inline text-cyan-300 tabular-nums">
                    ({hoverDomain.latencyMs}ms, ${hoverDomain.revenueUsd.toFixed(0)})
                  </span>
                )}
              </div>
            </>
          )}

          {stageMode === 'cube3d' && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono-tech text-[10px] text-cyan-300 font-semibold">
                  DRAG TO ORBIT 3D CUBE · CLICK ANY CLUSTER BEACON TO INSPECT
                </span>
                {clusterBeacons.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    data-testid={`cube-beacon-${b.id}`}
                    onClick={() => {
                      setSelectedBeaconId(b.id);
                      setActivePolygon(null);
                      setActiveBox(b.presetBox);
                    }}
                    className={`px-2 py-0.5 rounded font-mono-tech text-[9.5px] font-semibold border cursor-pointer ${
                      selectedBeaconId === b.id
                        ? 'bg-amber-400/20 border-amber-400 text-amber-200'
                        : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-cyan-400/50'
                    }`}
                  >
                    {b.label.split(' ').slice(0, 2).join(' ')}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="cube-toggle-orbit"
                  onClick={() => setAutoOrbit((v) => !v)}
                  className={`px-2 py-0.5 rounded font-mono-tech text-[10px] border cursor-pointer ${
                    autoOrbit
                      ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
                      : 'bg-slate-900 border-slate-700 text-slate-300'
                  }`}
                >
                  {autoOrbit ? 'Auto-Orbit ON' : 'Auto-Orbit PAUSED'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const def = createDefaultCubeCamera();
                    setCubeCamera(def);
                    cubeLiveYawRef.current = def.yaw;
                    cubeLivePitchRef.current = def.pitch;
                    cubeLiveZoomRef.current = def.zoom;
                  }}
                  className="px-2 py-0.5 rounded font-mono-tech text-[10px] bg-slate-900 border border-slate-700 text-slate-300 hover:text-white flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset</span>
                </button>
              </div>
            </>
          )}

          {stageMode === 'medallion' && (
            <>
              <div className="flex flex-wrap items-center gap-2 font-mono-tech text-[10px]">
                <span className="text-emerald-300 font-semibold flex items-center gap-1">
                  <Activity className="w-3 h-3" />
                  LIVE ICEBERG CDC WATERMARK: {pipeline.watermarkIso}
                </span>
                <span className="text-slate-400">·</span>
                <span className="text-amber-300">
                  BATCH #{pipeline.batchSeq} ({pipeline.latencyBronzeToGoldMs}ms E2E)
                </span>
              </div>
              <div className="flex items-center gap-2 font-mono-tech text-[10px]">
                <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 font-semibold">
                  GOLD CORRUPTED: {pipeline.goldCorruptedRows}
                </span>
                <span
                  className={`px-2 py-0.5 rounded border font-semibold ${
                    pipeline.quarantineDlqRows > 0
                      ? 'bg-rose-500/20 border-rose-400/60 text-rose-200'
                      : 'bg-slate-900 border-slate-700 text-slate-300'
                  }`}
                >
                  DLQ QUARANTINE: {pipeline.quarantineDlqRows.toLocaleString()}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Main 60fps Canvas Container */}
        <div
          ref={stageWrapRef}
          data-testid="olap-stage-canvas-wrap"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            setHoverDomain(null);
            setHoveredBeaconId(null);
          }}
          className={`relative w-full h-[285px] sm:h-[330px] lg:h-[355px] select-none touch-none overflow-hidden ${
            stageMode === 'scatter2d'
              ? 'cursor-crosshair'
              : stageMode === 'cube3d'
                ? 'cursor-grab active:cursor-grabbing'
                : 'cursor-pointer'
          }`}
        >
          <canvas
            ref={stageCanvasRef}
            data-testid="olap-primary-canvas"
            className="w-full h-full block"
          />

          {/* Top-Left Floating Live Selection / Cluster HUD Overlay */}
          {stageMode === 'scatter2d' && (
            <div className="absolute top-2.5 left-2.5 sm:left-3 pointer-events-none flex flex-wrap items-center gap-1.5">
              <div className="px-2.5 py-1 rounded bg-slate-950/88 border border-cyan-500/40 backdrop-blur-sm font-mono-tech text-[10px] text-slate-100 flex items-center gap-2">
                <Sparkles className="w-3 h-3 text-cyan-400 shrink-0" />
                <span>
                  {hasCustomBrush ? (
                    <>
                      <strong className="text-yellow-300">
                        {selectionResult.selectedCount.toLocaleString()}
                      </strong>{' '}
                      brushed ({selectionResult.selectionSharePct}%) ·{' '}
                      <strong className="text-rose-300">{selectionResult.anomalyPct}% ANOMALY</strong>
                    </>
                  ) : (
                    <>
                      DRAG ACROSS CANVAS TO LASSO ·{' '}
                      <strong className="text-cyan-300">{totalPointsNow.toLocaleString()}</strong>{' '}
                      GPU POINTS LIVE
                    </>
                  )}
                </span>
              </div>
            </div>
          )}

          {stageMode === 'cube3d' && activeBeacon && (
            <div
              data-testid="cube-cluster-inspector"
              className="absolute top-2.5 left-2.5 max-w-[270px] px-3 py-2 rounded-md bg-slate-950/90 border border-amber-400/55 backdrop-blur-sm font-mono-tech text-[10px] space-y-1 pointer-events-none"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-amber-200">{activeBeacon.label}</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                    activeBeacon.severity === 'critical'
                      ? 'bg-rose-500/25 text-rose-200 border border-rose-400/50'
                      : activeBeacon.severity === 'watch'
                        ? 'bg-amber-500/25 text-amber-200 border border-amber-400/50'
                        : 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
                  }`}
                >
                  {activeBeacon.anomalyPct}% ANOMALY
                </span>
              </div>
              <p className="text-slate-400 text-[9.5px] m-0">{activeBeacon.subtitle}</p>
              <div className="grid grid-cols-3 gap-1.5 pt-1 border-t border-slate-800 tabular-nums">
                <div>
                  <div className="text-[8.5px] text-slate-400">POINTS</div>
                  <div className="text-slate-100 font-bold">
                    {activeBeacon.count.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-[8.5px] text-slate-400">AVG REV</div>
                  <div className="text-emerald-300 font-bold">
                    ${activeBeacon.avgRevenueUsd.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-[8.5px] text-slate-400">P99 LAT</div>
                  <div className="text-rose-300 font-bold">{activeBeacon.p99LatencyMs}ms</div>
                </div>
              </div>
            </div>
          )}

          {stageMode === 'medallion' && pipeline.activeDriftAlerts.length > 0 && (
            <div
              data-testid="medallion-drift-alert-overlay"
              className="absolute bottom-2.5 right-2.5 max-w-[330px] px-3 py-2 rounded-md bg-rose-950/92 border border-rose-500/75 backdrop-blur-sm font-mono-tech text-[9.5px] space-y-1 pointer-events-none"
            >
              <div className="flex items-center justify-between gap-2 text-rose-200 font-bold">
                <span className="flex items-center gap-1">
                  <Flame className="w-3 h-3 text-rose-400" />
                  ACTIVE dbt-test INTERCEPTIONS
                </span>
                <span className="text-emerald-300">0 GOLD CORRUPT</span>
              </div>
              {pipeline.activeDriftAlerts.slice(0, 2).map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-center justify-between gap-2 text-rose-100/90 border-t border-rose-800/70 pt-1"
                >
                  <span className="truncate">{alert.rule}</span>
                  <span className="shrink-0 font-bold text-rose-300 tabular-nums">
                    -{alert.interceptedCount.toLocaleString()} DLQ
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Interactive Deck: Auto-Generated Parameterized SQL Bar (7) + Real-Time Cohort Breakdown (5) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 bg-[var(--bg-surface)] nexus-hairline-t">
        {/* Left 7 Cols: Live Auto-Generated Parameterized Brush-to-SQL Bar */}
        <div
          data-testid="brush-sql-bar"
          className="xl:col-span-7 p-3 sm:px-4 sm:py-3 xl:nexus-hairline-r flex flex-col justify-between gap-2 min-w-0"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-[var(--accent-signal)] shrink-0" />
              <span className="font-mono-tech text-[10.5px] font-bold tracking-wide text-[var(--text-primary)]">
                LIVE AUTO-GENERATED BRUSH-TO-SQL
              </span>
              <span
                data-testid="sql-guard-badge"
                className="font-mono-tech text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] border border-[var(--accent-emerald)]/35 font-semibold inline-flex items-center gap-1"
              >
                <ShieldCheck className="w-3 h-3" />
                {compiledSql.guardrail.allowed ? 'AST GUARD: READ-ONLY' : 'AST BLOCKED'}
              </span>
              <span className="font-mono-tech text-[9.5px] text-[var(--text-muted)] tabular-nums">
                {selectionResult.queryTimeMs.toFixed(1)}ms scan
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="btn-copy-brush-sql"
                onClick={handleCopySql}
                className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10px] font-semibold text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
              >
                {copiedSql ? (
                  <>
                    <Check className="w-3 h-3 text-[var(--accent-emerald)]" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy SQL</span>
                  </>
                )}
              </button>

              <button
                type="button"
                data-testid="btn-run-brush-sql"
                onClick={handleDispatchToEditor}
                className="px-2.5 py-1 rounded bg-[var(--accent-signal)] hover:opacity-95 text-white font-mono-tech text-[10px] font-semibold flex items-center gap-1.5 shadow-sm cursor-pointer"
              >
                <Play className="w-3 h-3 fill-current" />
                <span>{dispatchedNotice ? 'Executed in Notebook!' : 'Run in SQL Editor'}</span>
              </button>
            </div>
          </div>

          {/* Crisp Parameterized SQL Code Surface */}
          <pre
            data-testid="generated-brush-sql-code"
            className="m-0 p-2.5 rounded-md bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[10.5px] leading-[1.45] text-[var(--text-primary)] overflow-x-auto whitespace-pre"
          >
            {renderHighlightedSql(compiledSql.sql)}
          </pre>

          {/* Compact Streaming Quarantine / SLA Verification Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px] text-[var(--text-muted)]">
            <div className="flex flex-wrap items-center gap-2.5 tabular-nums">
              <span>
                Bronze <strong className="text-[var(--text-primary)]">{pipeline.bronzeRawRows.toLocaleString()}</strong>
              </span>
              <span>-&gt;</span>
              <span>
                Silver <strong className="text-[var(--text-primary)]">{pipeline.silverCleanedRows.toLocaleString()}</strong>
              </span>
              <span>-&gt;</span>
              <span
                className={
                  pipeline.quarantineDlqRows > 0
                    ? 'text-[var(--accent-crimson)] font-semibold'
                    : 'text-[var(--accent-emerald)] font-semibold'
                }
              >
                DLQ {pipeline.quarantineDlqRows.toLocaleString()}
              </span>
              <span>-&gt;</span>
              <span className="text-[var(--accent-emerald)] font-semibold">
                Gold {pipeline.goldMartRows.toLocaleString()} (0 corrupt)
              </span>
            </div>
            <span className="tabular-nums">
              Watermark <strong className="text-[var(--text-secondary)]">{pipeline.watermarkIso}</strong>
            </span>
          </div>
        </div>

        {/* Right 5 Cols: Real-Time Cohort Breakdown Bars + P50/P95/P99 & Anomaly % */}
        <div
          data-testid="brush-cohort-metrics"
          className="xl:col-span-5 p-3 sm:px-4 sm:py-3 border-t xl:border-t-0 border-[var(--border-hairline)] flex flex-col justify-between gap-2.5 min-w-0"
        >
          {/* 4 Tight KPI Micro-Tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 tabular-nums">
            <div className="px-2 py-1.5 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)]">
              <div className="font-mono-tech text-[9px] text-[var(--text-muted)] uppercase">
                Selected Rows
              </div>
              <div
                data-testid="kpi-selected-rows"
                className="font-mono-tech text-xs font-bold text-[var(--text-primary)]"
              >
                {selectionResult.selectedCount.toLocaleString()}
              </div>
            </div>
            <div className="px-2 py-1.5 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)]">
              <div className="font-mono-tech text-[9px] text-[var(--text-muted)] uppercase">
                Anomaly Rate
              </div>
              <div
                data-testid="kpi-anomaly-pct"
                className={`font-mono-tech text-xs font-bold ${
                  selectionResult.anomalyPct >= 40
                    ? 'text-[var(--accent-crimson)]'
                    : selectionResult.anomalyPct >= 15
                      ? 'text-[var(--accent-amber)]'
                      : 'text-[var(--accent-emerald)]'
                }`}
              >
                {selectionResult.anomalyPct.toFixed(1)}%
              </div>
            </div>
            <div className="px-2 py-1.5 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)]">
              <div className="font-mono-tech text-[9px] text-[var(--text-muted)] uppercase">
                Avg Revenue
              </div>
              <div className="font-mono-tech text-xs font-bold text-[var(--accent-cyan)]">
                ${selectionResult.avgRevenueUsd.toLocaleString()}
              </div>
            </div>
            <div className="px-2 py-1.5 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)]">
              <div className="font-mono-tech text-[9px] text-[var(--text-muted)] uppercase">
                P50 / P95 / P99
              </div>
              <div
                data-testid="kpi-latency-quantiles"
                className="font-mono-tech text-[10.5px] font-bold text-[var(--text-primary)] whitespace-nowrap"
              >
                {selectionResult.p50LatencyMs}/{selectionResult.p95LatencyMs}/
                <span className="text-[var(--accent-crimson)]">{selectionResult.p99LatencyMs}</span>ms
              </div>
            </div>
          </div>

          {/* Regional Cohort Breakdown Horizontal Bars */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-mono-tech text-[9.5px] text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-secondary)]">
                LIVE REGIONAL COHORT BREAKDOWN ({selectionResult.box.label ?? 'ACTIVE BRUSH'})
              </span>
              <span>TX · AVG REV · P99</span>
            </div>
            {selectionResult.regionBreakdown.length === 0 ? (
              <div className="py-3 text-center font-mono-tech text-[10.5px] text-[var(--text-muted)] bg-[var(--bg-inset)] rounded border border-[var(--border-hairline)]">
                No points inside current brush bounds — drag across a cluster or select a preset.
              </div>
            ) : (
              <div className="space-y-1">
                {OLAP_REGIONS.map((reg) => {
                  const row = selectionResult.regionBreakdown.find((r) => r.region === reg);
                  if (!row) return null;
                  const maxCnt = selectionResult.regionBreakdown[0]?.txCount || 1;
                  const widthPct = Math.max(4, Math.round((row.txCount / maxCnt) * 100));
                  const barTone =
                    row.anomalyPct >= 50
                      ? 'bg-[#DC2626]'
                      : row.anomalyPct >= 20
                        ? 'bg-[#D97706]'
                        : 'bg-[#2563EB]';
                  return (
                    <div key={row.region} className="space-y-0.5">
                      <div className="flex items-center justify-between font-mono-tech text-[10px] tabular-nums">
                        <span className="font-semibold text-[var(--text-primary)]">{row.region}</span>
                        <span className="text-[var(--text-secondary)]">
                          <strong>{row.txCount.toLocaleString()}</strong> · $
                          {row.avgRevenueUsd.toFixed(0)} ·{' '}
                          <span
                            className={
                              row.p99LatencyMs >= 400
                                ? 'text-[var(--accent-crimson)] font-semibold'
                                : 'text-[var(--text-muted)]'
                            }
                          >
                            {row.p99LatencyMs}ms
                          </span>
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${barTone}`}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
