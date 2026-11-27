import React, { useEffect, useMemo, useState } from 'react';
import {
  Database,
  FileUp,
  Flame,
  GitBranch,
  GitFork,
  Layers,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { SQL_PRESETS } from '../engine/sqlPresets';
import type { LocalSemanticVectorIndex } from '../engine/vectorIndex';
import type { WorkspaceTab } from '../types/lakehouse';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  vectorIndex: LocalSemanticVectorIndex;
  onRunPresetSql: (sql: string) => void;
  onSwitchTab: (tab: WorkspaceTab) => void;
  onSwitchRowScale: (rows: number) => void;
  onOpenEnterpriseLicense: () => void;
}

interface PaletteAction {
  id: string;
  group: string;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  vectorIndex,
  onRunPresetSql,
  onSwitchTab,
  onSwitchRowScale,
  onOpenEnterpriseLicense,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
    }
  }, [open]);

  const actions = useMemo<PaletteAction[]>(() => {
    const base: PaletteAction[] = [
      ...SQL_PRESETS.map((p) => ({
        id: `preset-${p.id}`,
        group: 'SQL PRESET',
        label: p.label,
        hint: p.shortTag,
        icon: Terminal,
        run: () => {
          onSwitchTab('workbench');
          onRunPresetSql(p.sql);
          onClose();
        },
      })),
      {
        id: 'nav-workbench',
        group: 'VIEW',
        label: 'Open Multi-Cell SQL Notebook & WebGPU Workbench',
        hint: 'TAB 1',
        icon: Database,
        run: () => {
          onSwitchTab('workbench');
          onClose();
        },
      },
      {
        id: 'nav-lineage',
        group: 'VIEW',
        label: 'Open Medallion Schema Lineage ERD & Materialized View Cost Inspector',
        hint: 'TAB 2',
        icon: GitFork,
        run: () => {
          onSwitchTab('lineage');
          onClose();
        },
      },
      {
        id: 'nav-ingest',
        group: 'VIEW',
        label: 'Open Local CSV/JSON Ingest & Column Profiler Studio',
        hint: 'TAB 2',
        icon: FileUp,
        run: () => {
          onSwitchTab('ingest');
          onClose();
        },
      },
      {
        id: 'nav-cohorts',
        group: 'VIEW',
        label: 'Open Live Cohort Retention & NRR Heatmap',
        hint: 'TAB 3',
        icon: Flame,
        run: () => {
          onSwitchTab('cohorts');
          onClose();
        },
      },
      {
        id: 'nav-multiplayer',
        group: 'VIEW',
        label: 'Open Split CRDT Multiplayer Lab',
        hint: 'TAB 4',
        icon: GitBranch,
        run: () => {
          onSwitchTab('multiplayer');
          onClose();
        },
      },
      {
        id: 'nav-arch',
        group: 'VIEW',
        label: 'Open MCP Server & Architecture Inspector',
        hint: 'TAB 5',
        icon: Layers,
        run: () => {
          onSwitchTab('architecture');
          onClose();
        },
      },
      {
        id: 'open-enterprise-license',
        group: 'LICENSE',
        label: 'Enterprise Lakehouse Commissioning (MBBank VietQR · 14.9M VND)',
        hint: 'PRO',
        icon: ShieldCheck,
        run: () => {
          onClose();
          onOpenEnterpriseLicense();
        },
      },
      ...[100_000, 250_000, 500_000].map((rows) => ({
        id: `scale-${rows}`,
        group: 'SCALE',
        label: `Scale Lakehouse Dataset to ${(rows / 1000).toLocaleString()}K rows`,
        hint: `${rows / 1000}K`,
        icon: Database,
        run: () => {
          onSwitchRowScale(rows);
          onClose();
        },
      })),
    ];

    const q = query.trim().toLowerCase();
    if (!q) return base;

    const filtered = base.filter(
      (a) => a.label.toLowerCase().includes(q) || a.group.toLowerCase().includes(q),
    );

    // Augment with local 128-d semantic vector catalog hits
    const semantic = vectorIndex.search(q, 4).map((hit) => ({
      id: `vec-${hit.id}`,
      group: `VECTOR ${hit.score.toFixed(2)}`,
      label: hit.title,
      hint: hit.kind.toUpperCase(),
      icon: Sparkles,
      run: () => {
        if (hit.sqlSnippet) {
          onSwitchTab('workbench');
          onRunPresetSql(hit.sqlSnippet);
        }
        onClose();
      },
    }));

    return [...semantic, ...filtered];
  }, [query, vectorIndex, onClose, onOpenEnterpriseLicense, onRunPresetSql, onSwitchRowScale, onSwitchTab]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] px-4"
      onClick={onClose}
    >
      <div
        data-testid="command-palette-modal"
        className="w-full max-w-xl nexus-panel rounded-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3.5 py-2.5 nexus-hairline-b flex items-center gap-2.5 bg-[var(--bg-surface)]">
          <Search className="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIdx((i) => Math.min(actions.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIdx((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter' && actions[selectedIdx]) {
                e.preventDefault();
                actions[selectedIdx].run();
              }
            }}
            placeholder="Search presets, semantic catalog, views, or dataset scale..."
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto p-2 bg-[var(--bg-inset)] space-y-1">
          {actions.length === 0 ? (
            <p className="p-4 text-center font-mono-tech text-xs text-[var(--text-muted)]">
              No matching commands or semantic entries.
            </p>
          ) : (
            actions.map((action, idx) => {
              const Icon = action.icon;
              const active = idx === selectedIdx;
              return (
                <button
                  key={action.id}
                  type="button"
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={action.run}
                  className={`w-full px-3 py-2 rounded flex items-center justify-between gap-2 text-left transition-colors cursor-pointer ${
                    active
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon className="w-3.5 h-3.5 text-[var(--accent-cyan)] shrink-0" />
                    <span className="text-xs font-medium truncate">{action.label}</span>
                  </div>
                  <span className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-hairline)] text-[var(--text-muted)] shrink-0">
                    {action.group}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
