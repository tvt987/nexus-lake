import React from 'react';
import { AlertTriangle, Download, Pause, Play, Radio } from 'lucide-react';
import type { CopyDict } from '../i18n';
import type { CdcTelemetryState } from '../types/lakehouse';

interface CdcSparklineProps {
  rates: number[];
  isStreaming: boolean;
  burstActive: boolean;
  width?: number;
  height?: number;
}

export const CdcSparklineSvg: React.FC<CdcSparklineProps> = ({
  rates,
  isStreaming,
  burstActive,
  width = 128,
  height = 24,
}) => {
  const safeRates = rates.length >= 2 ? rates : [0, 0];
  const maxRate = Math.max(6000, ...safeRates);
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const points = safeRates.map((val, idx) => {
    const x = pad + (idx / (safeRates.length - 1)) * innerW;
    const y = pad + innerH - (Math.max(0, val) / maxRate) * innerH;
    return { x, y };
  });

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L ${points[points.length - 1].x.toFixed(1)} ${(height - pad).toFixed(1)} L ${points[0].x.toFixed(1)} ${(height - pad).toFixed(1)} Z`;

  const strokeColor = !isStreaming
    ? 'var(--text-muted)'
    : burstActive
      ? 'var(--accent-signal)'
      : 'var(--accent-emerald)';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
      aria-label="Live CDC ingest rate sparkline"
    >
      <line
        x1={pad}
        y1={height - pad}
        x2={width - pad}
        y2={height - pad}
        stroke="var(--border-hairline)"
      />
      <path d={area} fill={strokeColor} opacity={isStreaming ? 0.18 : 0.08} />
      <path d={line} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinejoin="round" />
      {isStreaming && (
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r="2.4"
          fill={strokeColor}
        />
      )}
    </svg>
  );
};

interface CdcLiveStripProps {
  copy: CopyDict;
  telemetry: CdcTelemetryState;
  onToggleStream: () => void;
  onExportSnapshot: () => void;
}

export const CdcLiveStrip: React.FC<CdcLiveStripProps> = ({
  copy,
  telemetry,
  onToggleStream,
  onExportSnapshot,
}) => {
  return (
    <div
      data-testid="cdc-live-ribbon"
      className={`nexus-panel rounded-md px-3 py-2 flex flex-wrap items-center justify-between gap-2.5 transition-colors ${
        telemetry.burstAlertActive
          ? 'border-[var(--accent-signal)]'
          : 'border-[var(--accent-emerald)]/40'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2.5 min-w-0">
        <div className="flex items-center gap-1.5 font-mono-tech text-[11px] font-semibold">
          <span
            className={`w-2 h-2 rounded-full ${
              telemetry.isStreaming
                ? telemetry.burstAlertActive
                  ? 'bg-[var(--accent-signal)] animate-telemetry-dot'
                  : 'bg-[var(--accent-emerald)] animate-telemetry-dot'
                : 'bg-[var(--text-muted)]'
            }`}
          />
          <Radio
            className={`w-3.5 h-3.5 ${
              telemetry.isStreaming ? 'text-[var(--accent-emerald)]' : 'text-[var(--text-muted)]'
            }`}
          />
          <span className="text-[var(--text-primary)]">{telemetry.topicName}</span>
        </div>

        <CdcSparklineSvg
          rates={telemetry.rateHistory}
          isStreaming={telemetry.isStreaming}
          burstActive={telemetry.burstAlertActive}
        />

        <div className="flex flex-wrap items-center gap-3 font-mono-tech text-[10px]">
          <span className="text-[var(--text-muted)]">
            RATE:{' '}
            <strong className="text-[var(--accent-emerald)]">
              +{telemetry.currentRateTxSec.toLocaleString()} tx/s
            </strong>
          </span>
          <span className="text-[var(--text-muted)]">
            INGESTED:{' '}
            <strong className="text-[var(--text-primary)]">
              +{telemetry.totalIngestedRows.toLocaleString()}
            </strong>
          </span>
          <span className="hidden md:inline text-[var(--text-muted)]">
            BATCH:{' '}
            <strong className="text-[var(--accent-cyan)]">
              #{telemetry.batchCount} ({telemetry.lastIngestMs}ms)
            </strong>
          </span>
        </div>

        {telemetry.burstAlertActive && (
          <span
            data-testid="cdc-burst-alert"
            className="px-2 py-0.5 rounded border border-[var(--accent-signal)] bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] font-mono-tech text-[10px] font-semibold flex items-center gap-1"
          >
            <AlertTriangle className="w-3 h-3" />
            BURST SPIKE (+{telemetry.lastBatchAnomalies} ANOM)
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          data-testid="cdc-ribbon-toggle"
          onClick={onToggleStream}
          className={`px-2 py-1 rounded border font-mono-tech text-[10px] font-medium flex items-center gap-1 transition-colors cursor-pointer ${
            telemetry.isStreaming
              ? 'border-[var(--accent-amber)] bg-[var(--bg-inset)] text-[var(--accent-amber)] hover:brightness-110'
              : 'border-[var(--accent-emerald)] bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]'
          }`}
        >
          {telemetry.isStreaming ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          {telemetry.isStreaming ? 'Pause CDC' : 'Resume CDC'}
        </button>

        <button
          type="button"
          data-testid="export-snapshot-btn"
          onClick={onExportSnapshot}
          className="px-2.5 py-1 rounded border border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] hover:brightness-110 font-mono-tech text-[10px] font-semibold flex items-center gap-1 transition-all cursor-pointer"
        >
          <Download className="w-3 h-3" />
          <span className="hidden sm:inline">{copy.exportSnapshot}</span>
          <span className="sm:hidden">Snapshot</span>
        </button>
      </div>
    </div>
  );
};
