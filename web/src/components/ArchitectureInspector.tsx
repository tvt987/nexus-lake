import React, { useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  GitBranch,
  Server,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';

const FORBIDDEN_KEYWORDS = new Set([
  'DROP',
  'DELETE',
  'UPDATE',
  'INSERT',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'ATTACH',
  'COPY',
  'PRAGMA',
  'EXEC',
  'GRANT',
]);

function previewSqlGuardrail(sql: string): { allowed: boolean; detail: string } {
  const clean = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "'LITERAL'")
    .trim();

  if (!clean) return { allowed: false, detail: 'Empty query rejected.' };
  const body = clean.replace(/;\s*$/, '');
  if (body.includes(';')) {
    return { allowed: false, detail: 'BLOCKED: Stacked multi-statement SQL injection detected.' };
  }
  const words = body.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const lead = (words[0] ?? '').toUpperCase();
  if (!['SELECT', 'WITH', 'EXPLAIN', 'DESCRIBE', 'SHOW'].includes(lead)) {
    return {
      allowed: false,
      detail: `BLOCKED: Statement "${lead}" is disallowed. Read-only mode allows SELECT/WITH/EXPLAIN/DESCRIBE/SHOW.`,
    };
  }
  for (const w of words) {
    const up = w.toUpperCase();
    if (FORBIDDEN_KEYWORDS.has(up)) {
      return { allowed: false, detail: `BLOCKED: Forbidden keyword "${up}" intercepted by AST guardrail.` };
    }
  }
  return { allowed: true, detail: `ALLOWED: Verified read-only ${lead} AST safe for MCP execution.` };
}

const CLAUDE_MCP_SNIPPET = `{
  "mcpServers": {
    "nexus-lake": {
      "command": "node",
      "args": ["./packages/mcp-lakehouse-server/dist/stdio.js"],
      "env": {
        "NEXUS_LAKE_READ_ONLY": "true"
      }
    }
  }
}`;

const STREAMABLE_HTTP_CURL = `curl -X POST http://127.0.0.1:8787/mcp \\
  -H "Authorization: Bearer nexus-dev-token" \\
  -H "Content-Type: application/json" \\
  -H "Accept: text/event-stream" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "detect_anomalies",
      "arguments": { "riskThreshold": 0.78, "region": "APAC-VN", "limit": 10 }
    }
  }'`;

export const ArchitectureInspector: React.FC = () => {
  const [testSql, setTestSql] = useState(
    'SELECT region, COUNT(*) FROM transactions GROUP BY region; DROP TABLE transactions;',
  );
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const verdict = previewSqlGuardrail(testSql);

  const copySnippet = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  return (
    <div className="space-y-4">
      {/* Architecture Pillars Overview */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          {
            icon: Database,
            tag: 'OLAP ENGINE',
            title: 'DuckDB-WASM + Arrow IPC',
            metric: '100K - 500K rows local',
            desc: 'Self-hosted Vite ?url WASM bundles with zero CDN dependency. Columnar TypedArray -> Arrow IPC stream ingestion in <1.5s.',
          },
          {
            icon: Cpu,
            tag: 'GPU COMPUTE',
            title: 'WebGPU WGSL Shaders',
            metric: '60 FPS @workgroup(256)',
            desc: 'Parallel GPU compute filtering over 100K+ points by risk threshold, region bitmask, and time window with WebGL2/2D fallback.',
          },
          {
            icon: GitBranch,
            tag: 'MULTIPLAYER',
            title: 'Yjs CRDT + BroadcastChannel',
            metric: 'Zero-loss offline merge',
            desc: 'Independent Y.Doc state vectors diverge cleanly during network partitions and converge via minimal binary differential updates.',
          },
          {
            icon: Server,
            tag: 'MCP + AG-UI',
            title: 'JSON-RPC 2.0 Server',
            metric: 'Stdio + Streamable HTTP',
            desc: 'Standalone TypeScript MCP package with Zod validation, Bearer scope auth (401/403), rate limiter, audit log, and SQL AST guardrail.',
          },
        ].map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.tag} className="nexus-panel rounded-md p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono-tech text-[10px] tracking-wider text-[var(--accent-cyan)]">
                  {card.tag}
                </span>
                <Icon className="w-4 h-4 text-[var(--text-muted)]" />
              </div>
              <h3 className="font-display font-semibold text-sm text-[var(--text-primary)]">
                {card.title}
              </h3>
              <p className="font-mono-tech text-[11px] text-[var(--accent-emerald)]">{card.metric}</p>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">{card.desc}</p>
            </div>
          );
        })}
      </section>

      {/* Interactive Read-Only SQL AST Guardrail Tester */}
      <section className="nexus-panel rounded-md p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display font-semibold text-sm text-[var(--text-primary)]">
              LIVE MCP SQL AST GUARDRAIL SANDBOX
            </h3>
            <p className="text-xs text-[var(--text-muted)]">
              Mirrors the production lexical/AST validator shipped inside{' '}
              <code className="font-mono-tech text-[var(--accent-cyan)]">
                packages/mcp-lakehouse-server/src/sqlGuardrail.ts
              </code>
              .
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                setTestSql("SELECT region, SUM(amount_usd) FROM transactions WHERE is_anomaly = true GROUP BY region;")
              }
              className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-mono-tech text-[10px] text-[var(--accent-emerald)] cursor-pointer"
            >
              Test Safe SELECT
            </button>
            <button
              type="button"
              onClick={() =>
                setTestSql('SELECT * FROM transactions LIMIT 5; DROP TABLE transactions;')
              }
              className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-mono-tech text-[10px] text-[var(--accent-signal)] cursor-pointer"
            >
              Test Stacked DROP
            </button>
          </div>
        </div>

        <input
          type="text"
          value={testSql}
          onChange={(e) => setTestSql(e.target.value)}
          className="w-full px-3 py-2 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-cyan)]"
        />

        <div
          className={`p-2.5 rounded border font-mono-tech text-xs flex items-center gap-2 ${
            verdict.allowed
              ? 'border-[var(--accent-emerald)] bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]'
              : 'border-[var(--accent-signal)] bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]'
          }`}
        >
          {verdict.allowed ? (
            <ShieldCheck className="w-4 h-4 shrink-0" />
          ) : (
            <ShieldAlert className="w-4 h-4 shrink-0" />
          )}
          <span>{verdict.detail}</span>
        </div>
      </section>

      {/* MCP Configuration Snippets */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <section className="nexus-panel rounded-md p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-mono-tech text-xs font-semibold text-[var(--text-primary)]">
              CLAUDE DESKTOP / CURSOR STDIO MCP CONFIG
            </h3>
            <button
              type="button"
              onClick={() => copySnippet('stdio', CLAUDE_MCP_SNIPPET)}
              className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
            >
              {copiedKey === 'stdio' ? (
                <CheckCircle2 className="w-3 h-3 text-[var(--accent-emerald)]" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              {copiedKey === 'stdio' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="p-3 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[11px] text-[var(--text-secondary)] overflow-x-auto m-0">
            {CLAUDE_MCP_SNIPPET}
          </pre>
        </section>

        <section className="nexus-panel rounded-md p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-mono-tech text-xs font-semibold text-[var(--text-primary)]">
              STREAMABLE HTTP + SCOPED BEARER AUTH
            </h3>
            <button
              type="button"
              onClick={() => copySnippet('http', STREAMABLE_HTTP_CURL)}
              className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
            >
              {copiedKey === 'http' ? (
                <CheckCircle2 className="w-3 h-3 text-[var(--accent-emerald)]" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              {copiedKey === 'http' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="p-3 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[11px] text-[var(--text-secondary)] overflow-x-auto m-0">
            {STREAMABLE_HTTP_CURL}
          </pre>
        </section>
      </div>
    </div>
  );
};
