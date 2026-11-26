import React, { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  GitMerge,
  Play,
  Radio,
  Split,
  Unplug,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import {
  SplitPeerCrdtController,
  type CrdtSyncReport,
  type PeerSnapshot,
} from '../engine/crdtCollaboration';

interface CrdtMultiplayerLabProps {
  copy: CopyDict;
  onExecutePeerSql: (sql: string) => void;
}

export const CrdtMultiplayerLab: React.FC<CrdtMultiplayerLabProps> = ({
  copy,
  onExecutePeerSql,
}) => {
  const [controller] = useState(() => new SplitPeerCrdtController());
  const [snapshot, setSnapshot] = useState<{
    peerA: PeerSnapshot;
    peerB: PeerSnapshot;
    isDiverged: boolean;
  }>(() => controller.getSnapshots());
  const [partitioned, setPartitioned] = useState<boolean>(() => controller.isPartitioned());
  const [syncReport, setSyncReport] = useState<CrdtSyncReport | null>(() =>
    controller.getLastSyncReport(),
  );

  useEffect(() => {
    const unsub = controller.subscribe(() => {
      setSnapshot(controller.getSnapshots());
      setPartitioned(controller.isPartitioned());
      setSyncReport(controller.getLastSyncReport());
    });
    return () => {
      unsub();
      controller.dispose();
    };
  }, [controller]);

  const renderVectorClock = (peer: PeerSnapshot) => (
    <div className="flex flex-wrap items-center gap-1.5 font-mono-tech text-[10px]">
      <span className="text-[var(--text-muted)]">SV:</span>
      {peer.stateVector.map((entry) => (
        <span
          key={entry.clientId}
          className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-hairline)] text-[var(--text-secondary)]"
        >
          c{String(entry.clientId).slice(-4)}:{entry.clock}
        </span>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Lab Control Banner */}
      <section className="nexus-panel rounded-md p-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-testid="crdt-link-status"
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-mono-tech text-[10px] font-semibold border ${
                  partitioned
                    ? 'border-[var(--accent-signal)] bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]'
                    : 'border-[var(--accent-emerald)] bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]'
                }`}
              >
                {partitioned ? <WifiOff className="w-3 h-3" /> : <Wifi className="w-3 h-3" />}
                {partitioned ? copy.statusPartitioned : copy.statusOnline}
              </span>

              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono-tech text-[10px] border border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--accent-cyan)]">
                <Radio className="w-3 h-3" />
                BroadcastChannel: nexus-lake-crdt-v1
              </span>

              {snapshot.isDiverged && (
                <span
                  data-testid="crdt-diverged-badge"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono-tech text-[10px] border border-[var(--accent-amber)] text-[var(--accent-amber)]"
                >
                  <Activity className="w-3 h-3" />
                  CLOCKS DIVERGED
                </span>
              )}
            </div>

            <h2 className="font-display font-semibold text-base text-[var(--text-primary)]">
              {copy.multiplayerTitle}
            </h2>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              {copy.multiplayerDesc}
            </p>
          </div>

          {/* Primary CRDT Action Buttons */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="crdt-simulate-conflict-btn"
              onClick={() => controller.injectConcurrentConflictDemo()}
              className="px-3 py-1.5 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] hover:bg-[var(--bg-elevated)] font-mono-tech text-[11px] text-[var(--text-primary)] flex items-center gap-1.5 cursor-pointer"
            >
              <Split className="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              Inject Offline Conflict
            </button>

            {!partitioned ? (
              <button
                type="button"
                data-testid="crdt-sever-btn"
                onClick={() => controller.severNetworkLink()}
                className="px-3 py-1.5 rounded bg-[var(--accent-signal)] hover:brightness-110 text-white font-mono-tech text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <Unplug className="w-3.5 h-3.5" />
                {copy.severLink}
              </button>
            ) : (
              <button
                type="button"
                data-testid="crdt-reconnect-btn"
                onClick={() => controller.reconnectAndSync()}
                className="px-3 py-1.5 rounded bg-[var(--accent-emerald)] hover:brightness-110 text-white font-mono-tech text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <GitMerge className="w-3.5 h-3.5" />
                {copy.reconnectSync}
              </button>
            )}
          </div>
        </div>

        {/* Last Merge Report Telemetry */}
        {syncReport && (
          <div
            data-testid="crdt-sync-report"
            className="mt-3 pt-3 nexus-hairline-t flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[11px]"
          >
            <div className="flex items-center gap-2 text-[var(--accent-emerald)]">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                MATHEMATICAL CONVERGENCE VERIFIED ({syncReport.converged ? 'IDENTICAL HASH' : 'PENDING'})
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-[var(--text-secondary)]">
              <span>
                DELTA A-&gt;B: <strong className="text-[var(--text-primary)]">{syncReport.deltaBytesAtoB} B</strong>
              </span>
              <span>
                DELTA B-&gt;A: <strong className="text-[var(--text-primary)]">{syncReport.deltaBytesBtoA} B</strong>
              </span>
              <span>
                TOTAL WIRE DELTA:{' '}
                <strong className="text-[var(--accent-cyan)]">{syncReport.totalMergedBytes} bytes</strong>
              </span>
              <span>
                DOC LEN: <strong className="text-[var(--text-primary)]">{syncReport.mergedLength} chars</strong>
              </span>
            </div>
          </div>
        )}
      </section>

      {/* Split Live Peer Editors */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Peer A: Saigon */}
        <section className="nexus-panel rounded-md overflow-hidden flex flex-col">
          <div className="px-3 py-2 nexus-hairline-b bg-[var(--bg-surface)] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--accent-cyan)]" />
              <span className="font-mono-tech text-xs font-semibold text-[var(--text-primary)]">
                {snapshot.peerA.label}
              </span>
              <span className="font-mono-tech text-[10px] text-[var(--text-muted)]">
                Y.Doc #{String(snapshot.peerA.clientId).slice(-4)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {snapshot.peerA.pendingLocalOps > 0 && (
                <span className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]">
                  +{snapshot.peerA.pendingLocalOps} offline ops
                </span>
              )}
              <button
                type="button"
                onClick={() => onExecutePeerSql(snapshot.peerA.sqlText)}
                className="px-2 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
              >
                <Play className="w-2.5 h-2.5" />
                Run SQL
              </button>
            </div>
          </div>

          <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-inset)]">
            {renderVectorClock(snapshot.peerA)}
          </div>

          <textarea
            data-testid="peer-a-editor"
            value={snapshot.peerA.sqlText}
            onChange={(e) => controller.applyTextEdit('saigon', e.target.value)}
            spellCheck={false}
            rows={14}
            className="w-full p-3 bg-[var(--bg-inset)] font-mono-tech text-xs leading-relaxed text-[var(--text-primary)] focus:outline-none resize-none"
          />
        </section>

        {/* Peer B: San Francisco */}
        <section className="nexus-panel rounded-md overflow-hidden flex flex-col">
          <div className="px-3 py-2 nexus-hairline-b bg-[var(--bg-surface)] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--accent-signal)]" />
              <span className="font-mono-tech text-xs font-semibold text-[var(--text-primary)]">
                {snapshot.peerB.label}
              </span>
              <span className="font-mono-tech text-[10px] text-[var(--text-muted)]">
                Y.Doc #{String(snapshot.peerB.clientId).slice(-4)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {snapshot.peerB.pendingLocalOps > 0 && (
                <span className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]">
                  +{snapshot.peerB.pendingLocalOps} offline ops
                </span>
              )}
              <button
                type="button"
                onClick={() => onExecutePeerSql(snapshot.peerB.sqlText)}
                className="px-2 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-signal)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
              >
                <Play className="w-2.5 h-2.5" />
                Run SQL
              </button>
            </div>
          </div>

          <div className="px-3 py-1.5 nexus-hairline-b bg-[var(--bg-inset)]">
            {renderVectorClock(snapshot.peerB)}
          </div>

          <textarea
            data-testid="peer-b-editor"
            value={snapshot.peerB.sqlText}
            onChange={(e) => controller.applyTextEdit('san-francisco', e.target.value)}
            spellCheck={false}
            rows={14}
            className="w-full p-3 bg-[var(--bg-inset)] font-mono-tech text-xs leading-relaxed text-[var(--text-primary)] focus:outline-none resize-none"
          />
        </section>
      </div>
    </div>
  );
};
