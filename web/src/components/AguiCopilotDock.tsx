import React, { useState } from 'react';
import {
  Activity,
  AlertOctagon,
  BarChart3,
  Bookmark,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import { runAguiCopilotSession } from '../engine/aguiCopilot';
import type {
  AguiWireEvent,
  ByokConfig,
  GenerativeWidget,
  SqlQueryResult,
} from '../types/lakehouse';

interface AguiCopilotDockProps {
  copy: CopyDict;
  executeSql: (sql: string) => Promise<SqlQueryResult>;
  onApplySql: (sql: string) => void;
  pinnedWidgets: GenerativeWidget[];
  onPinWidget: (widget: GenerativeWidget) => void;
  onUnpinWidget: (id: string) => void;
}

const QUICK_PROMPTS = [
  'Show fraud spikes by region',
  'Detect voucher abuse bursts',
  'Compute P99 latency SLA by category',
  'Rolling 24h moving average trend',
];

const EVENT_COLORS: Record<string, string> = {
  RUN_STARTED: 'text-[var(--accent-cyan)]',
  STEP_STARTED: 'text-[var(--text-secondary)]',
  TOOL_CALL_START: 'text-[var(--accent-amber)]',
  TOOL_CALL_RESULT: 'text-[var(--accent-emerald)]',
  STATE_DELTA: 'text-[var(--accent-cyan)]',
  UI_WIDGET_EMIT: 'text-[var(--accent-signal)]',
  TEXT_MESSAGE_CONTENT: 'text-[var(--text-primary)]',
  RUN_FINISHED: 'text-[var(--accent-emerald)]',
};

export const AguiCopilotDock: React.FC<AguiCopilotDockProps> = ({
  copy,
  executeSql,
  onApplySql,
  pinnedWidgets,
  onPinWidget,
  onUnpinWidget,
}) => {
  const [prompt, setPrompt] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [assistantText, setAssistantText] = useState<string>(
    'Nexus AG-UI Copilot ready. Dispatch a natural-language analytics question (EN/VI) to trigger MCP tool invocation, live SQL execution, and generative BI widgets.',
  );
  const [events, setEvents] = useState<AguiWireEvent[]>([]);
  const [widgets, setWidgets] = useState<GenerativeWidget[]>([]);
  const [showWire, setShowWire] = useState(false);
  const [showByok, setShowByok] = useState(false);
  const [byok, setByok] = useState<ByokConfig>({
    provider: 'local-planner',
    apiKey: '',
    model: 'gemini-2.0-flash',
  });

  const dispatchPrompt = async (textOverride?: string) => {
    const input = (textOverride ?? prompt).trim();
    if (!input || isRunning) return;
    setIsRunning(true);
    setEvents([]);
    setWidgets([]);
    setAssistantText('');

    try {
      await runAguiCopilotSession(
        input,
        {
          executeSql,
          onEvent: (ev) => setEvents((prev) => [...prev, ev]),
          onWidget: (w) => setWidgets((prev) => [...prev, w]),
          onMessageChunk: (chunk) => setAssistantText(chunk),
          onSqlApplied: onApplySql,
        },
        byok,
      );
      setPrompt('');
    } finally {
      setIsRunning(false);
    }
  };

  const renderWidget = (w: GenerativeWidget, isPinned = false) => {
    const pinnedExists = pinnedWidgets.some((p) => p.id === w.id);

    if (w.kind === 'kpi_anomaly_alert') {
      return (
        <div
          key={w.id}
          data-testid="widget-kpi-anomaly"
          className="p-3 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] flex flex-col justify-between"
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
              <AlertOctagon className="w-3.5 h-3.5 text-[var(--accent-signal)]" />
              {w.title}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono-tech text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] uppercase">
                {w.severity}
              </span>
              <button
                type="button"
                title={isPinned ? 'Unpin widget' : 'Pin widget to IndexedDB'}
                onClick={() => (isPinned ? onUnpinWidget(w.id) : onPinWidget(w))}
                className={`p-1 rounded hover:bg-[var(--bg-elevated)] cursor-pointer ${
                  pinnedExists || isPinned
                    ? 'text-[var(--accent-signal)]'
                    : 'text-[var(--text-muted)]'
                }`}
              >
                <Bookmark className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 mt-1">
            <div className="p-2 rounded bg-[var(--bg-surface)] border border-[var(--border-hairline)]">
              <p className="font-mono-tech text-[9px] text-[var(--text-muted)]">ANOMALY BURSTS</p>
              <p className="font-mono-tech text-base font-bold text-[var(--accent-signal)] mt-0.5">
                {w.anomalyCount.toLocaleString()}
              </p>
            </div>
            <div className="p-2 rounded bg-[var(--bg-surface)] border border-[var(--border-hairline)]">
              <p className="font-mono-tech text-[9px] text-[var(--text-muted)]">ANOMALY RATE</p>
              <p className="font-mono-tech text-base font-bold text-[var(--text-primary)] mt-0.5">
                {w.anomalyRatePct.toFixed(2)}%
              </p>
            </div>
            <div className="p-2 rounded bg-[var(--bg-surface)] border border-[var(--border-hairline)]">
              <p className="font-mono-tech text-[9px] text-[var(--text-muted)]">EXPOSURE USD</p>
              <p className="font-mono-tech text-sm font-semibold text-[var(--accent-cyan)] mt-0.5">
                ${w.totalExposureUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </p>
            </div>
            <div className="p-2 rounded bg-[var(--bg-surface)] border border-[var(--border-hairline)]">
              <p className="font-mono-tech text-[9px] text-[var(--text-muted)]">P99 LATENCY</p>
              <p className="font-mono-tech text-sm font-semibold text-[var(--accent-emerald)] mt-0.5">
                {w.p99LatencyMs} ms
              </p>
            </div>
          </div>
        </div>
      );
    }

    if (w.kind === 'regional_bar_chart') {
      const maxVal = Math.max(1, ...w.bars.map((b) => b.value));
      return (
        <div
          key={w.id}
          data-testid="widget-regional-bar"
          className="p-3 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)]"
        >
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <span className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              {w.title}
            </span>
            <button
              type="button"
              onClick={() => (isPinned ? onUnpinWidget(w.id) : onPinWidget(w))}
              className={`p-1 rounded hover:bg-[var(--bg-elevated)] cursor-pointer ${
                pinnedExists || isPinned
                  ? 'text-[var(--accent-signal)]'
                  : 'text-[var(--text-muted)]'
              }`}
            >
              <Bookmark className="w-3 h-3" />
            </button>
          </div>
          <div className="space-y-2">
            {w.bars.map((bar) => {
              const pct = Math.max(4, (bar.value / maxVal) * 100);
              return (
                <div key={bar.region} className="space-y-0.5">
                  <div className="flex items-center justify-between font-mono-tech text-[10px]">
                    <span className="text-[var(--text-primary)] font-medium">{bar.region}</span>
                    <span className="text-[var(--text-secondary)]">
                      ${bar.value.toLocaleString('en-US', { maximumFractionDigits: 0 })}{' '}
                      <span className="text-[var(--accent-signal)]">
                        ({bar.anomalies} anom)
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[var(--accent-cyan)] to-[var(--accent-signal)]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (w.kind === 'sql_explain_plan') {
      return (
        <div
          key={w.id}
          data-testid="widget-sql-explain"
          className="p-3 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent-emerald)]" />
              {w.title}
            </span>
            <span className="font-mono-tech text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]">
              {w.guardrailStatus}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {w.operators.map((op, i) => (
              <React.Fragment key={op}>
                <span className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-hairline)] text-[var(--text-secondary)]">
                  {op}
                </span>
                {i < w.operators.length - 1 && (
                  <span className="font-mono-tech text-[10px] text-[var(--text-muted)]">-&gt;</span>
                )}
              </React.Fragment>
            ))}
          </div>
          <div className="flex items-center justify-between font-mono-tech text-[10px] text-[var(--text-muted)] pt-1">
            <span>
              {w.engine} · {w.executionMs}ms · {w.scannedRows.toLocaleString()} scanned
            </span>
            <button
              type="button"
              onClick={() => onApplySql(w.sql)}
              className="text-[var(--accent-cyan)] hover:underline cursor-pointer"
            >
              Inspect SQL
            </button>
          </div>
        </div>
      );
    }

    // compact_table
    return (
      <div
        key={w.id}
        data-testid="widget-compact-table"
        className="p-3 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] overflow-hidden"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
            <Terminal className="w-3 h-3 text-[var(--accent-cyan)]" />
            {w.title}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono-tech text-[10px] border-collapse">
            <thead>
              <tr className="border-b border-[var(--border-hairline)] text-[var(--text-muted)]">
                {w.columns.map((c) => (
                  <th key={c} className="py-1 pr-2 font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {w.rows.map((r, idx) => (
                <tr key={idx} className="border-b border-[var(--border-hairline)]/50">
                  {w.columns.map((c) => (
                    <td key={c} className="py-1 pr-2 text-[var(--text-secondary)] whitespace-nowrap">
                      {String(r[c] ?? '--')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <section className="nexus-panel rounded-md overflow-hidden flex flex-col">
      {/* Copilot Header + Prompt Bar */}
      <div className="px-3 py-2 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
          <span className="font-mono-tech text-[11px] font-semibold tracking-wide text-[var(--text-primary)]">
            AG-UI GENERATIVE BI COPILOT
          </span>
          <span className="font-mono-tech text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-hairline)] text-[var(--text-muted)]">
            {byok.provider === 'local-planner' ? 'DETERMINISTIC + MCP' : `BYOK: ${byok.provider.toUpperCase()}`}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowByok((s) => !s)}
            className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
          >
            <KeyRound className="w-3 h-3" />
            {copy.byokSettings}
          </button>

          <button
            type="button"
            data-testid="agui-wire-toggle"
            onClick={() => setShowWire((s) => !s)}
            className={`px-2 py-1 rounded border font-mono-tech text-[10px] flex items-center gap-1 cursor-pointer ${
              showWire
                ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)]'
                : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
            }`}
          >
            <Activity className="w-3 h-3" />
            {copy.wireInspector} ({events.length})
            {showWire ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Optional BYOK Config Strip */}
      {showByok && (
        <div className="px-3 py-2.5 nexus-hairline-b bg-[var(--bg-elevated)] flex flex-wrap items-center gap-2 text-xs">
          <select
            value={byok.provider}
            onChange={(e) =>
              setByok((prev) => ({
                ...prev,
                provider: e.target.value as ByokConfig['provider'],
                model: e.target.value === 'openai' ? 'gpt-4o-mini' : 'gemini-2.0-flash',
              }))
            }
            className="px-2 py-1 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[11px] text-[var(--text-primary)]"
          >
            <option value="local-planner">Local Deterministic Planner (Zero API Cost)</option>
            <option value="gemini">Google Gemini (BYOK)</option>
            <option value="openai">OpenAI (BYOK)</option>
          </select>

          {byok.provider !== 'local-planner' && (
            <>
              <input
                type="password"
                value={byok.apiKey}
                onChange={(e) => setByok((prev) => ({ ...prev, apiKey: e.target.value }))}
                placeholder={`Enter ${byok.provider} API key (in-memory only)...`}
                className="flex-1 min-w-[200px] px-2.5 py-1 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[11px] text-[var(--text-primary)]"
              />
              <input
                type="text"
                value={byok.model}
                onChange={(e) => setByok((prev) => ({ ...prev, model: e.target.value }))}
                className="w-36 px-2 py-1 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[11px] text-[var(--text-primary)]"
              />
            </>
          )}
          <button
            type="button"
            onClick={() => setShowByok(false)}
            className="ml-auto p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Input Form + Quick Prompt Chips */}
      <div className="p-3 space-y-2 bg-[var(--bg-surface)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void dispatchPrompt();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            data-testid="copilot-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={copy.copilotPlaceholder}
            className="flex-1 px-3 py-1.5 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] focus:border-[var(--accent-cyan)] focus:outline-none text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <button
            type="submit"
            data-testid="copilot-submit-btn"
            disabled={isRunning}
            className="px-3 py-1.5 rounded bg-[var(--accent-cyan)] hover:brightness-110 text-[var(--text-on-cyan)] font-mono-tech text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shrink-0"
          >
            <Send className="w-3 h-3" />
            {isRunning ? 'STREAMING...' : copy.copilotRun}
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK_PROMPTS.map((qp) => (
            <button
              key={qp}
              type="button"
              onClick={() => void dispatchPrompt(qp)}
              className="px-2 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)] font-mono-tech text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              {qp}
            </button>
          ))}
        </div>

        {/* Streamed Assistant Narrative */}
        <p
          data-testid="copilot-response-text"
          className="text-xs text-[var(--text-secondary)] leading-relaxed pt-1"
        >
          {assistantText}
        </p>

        {/* Emitted Generative UI Widgets */}
        {widgets.length > 0 && (
          <div
            data-testid="copilot-widgets-grid"
            className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2"
          >
            {widgets.map((w) => renderWidget(w, false))}
          </div>
        )}

        {/* Pinned Widgets persisted in IndexedDB */}
        {pinnedWidgets.length > 0 && (
          <div className="pt-3 mt-2 nexus-hairline-t">
            <p className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2">
              PINNED BI WIDGETS (INDEXEDDB PERSISTENT)
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {pinnedWidgets.map((w) => renderWidget(w, true))}
            </div>
          </div>
        )}
      </div>

      {/* Collapsible Live AG-UI Protocol Wire Inspector */}
      {showWire && (
        <div
          data-testid="agui-wire-inspector"
          className="nexus-hairline-t bg-[var(--bg-inset)] p-3 max-h-60 overflow-y-auto space-y-1.5"
        >
          {events.length === 0 ? (
            <p className="font-mono-tech text-[11px] text-[var(--text-muted)]">
              No AG-UI events recorded yet. Dispatch a copilot prompt above to inspect live protocol frames.
            </p>
          ) : (
            events.map((ev) => (
              <div
                key={ev.id}
                className="p-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] font-mono-tech text-[10px]"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className={`font-semibold ${EVENT_COLORS[ev.type] ?? 'text-[var(--text-primary)]'}`}>
                    #{String(ev.seq).padStart(2, '0')} {ev.type}
                  </span>
                  <span className="text-[var(--text-muted)]">{ev.timestamp.slice(11, 23)}Z</span>
                </div>
                <pre className="m-0 text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap break-all">
                  {JSON.stringify(ev.payload)}
                </pre>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
};
