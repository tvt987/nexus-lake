import React from 'react';
import {
  Command,
  Cpu,
  Database,
  GitBranch,
  Globe,
  Layers,
  Moon,
  Sun,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import type {
  EngineBackend,
  Locale,
  ThemeMode,
  WorkspaceTab,
} from '../types/lakehouse';

interface TopBarProps {
  copy: CopyDict;
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  engine: EngineBackend;
  rowScale: number;
  isLoadingScale: boolean;
  onRowScaleChange: (rows: number) => void;
  theme: ThemeMode;
  onToggleTheme: (e: React.MouseEvent<HTMLButtonElement>) => void;
  locale: Locale;
  onToggleLocale: () => void;
  onOpenCommandPalette: () => void;
}

const SCALES = [100_000, 250_000, 500_000];

export const TopBar: React.FC<TopBarProps> = ({
  copy,
  activeTab,
  onTabChange,
  engine,
  rowScale,
  isLoadingScale,
  onRowScaleChange,
  theme,
  onToggleTheme,
  locale,
  onToggleLocale,
  onOpenCommandPalette,
}) => {
  return (
    <header className="h-12 shrink-0 px-3 sm:px-4 flex items-center justify-between gap-2 nexus-hairline-b bg-[var(--bg-surface)] select-none">
      {/* Brand + Tabs */}
      <div className="flex items-center gap-4 min-w-0">
        <div className="flex items-center gap-2.5 shrink-0">
          <svg
            width="24"
            height="24"
            viewBox="0 0 64 64"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            <rect width="64" height="64" rx="12" fill="var(--bg-canvas)" />
            <rect
              x="1.5"
              y="1.5"
              width="61"
              height="61"
              rx="10.5"
              stroke="var(--border-strong)"
              strokeWidth="2"
            />
            <path
              d="M32 11L51 21.5L32 32L13 21.5L32 11Z"
              stroke="var(--accent-cyan)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
            <path
              d="M13 32L32 42.5L51 32"
              stroke="var(--text-primary)"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M13 42.5L32 53L51 42.5"
              stroke="var(--accent-signal)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="32" cy="21.5" r="3.5" fill="var(--accent-signal)" />
          </svg>
          <div className="leading-none">
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-sm tracking-tight text-[var(--text-primary)]">
                NEXUS LAKE
              </span>
              <span className="hidden xl:inline-block font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] border border-[var(--border-hairline)]">
                v1.0
              </span>
            </div>
            <p className="hidden 2xl:block text-[9px] font-mono-tech tracking-wider text-[var(--text-muted)] mt-0.5">
              {copy.subtitle}
            </p>
          </div>
        </div>

        <nav className="flex items-center gap-1" aria-label="Workspace views">
          <button
            type="button"
            data-testid="tab-workbench"
            onClick={() => onTabChange('workbench')}
            className={`px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeTab === 'workbench'
                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-strong)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-transparent'
            }`}
          >
            <Database className="w-3.5 h-3.5 stroke-[1.6]" />
            <span className="hidden sm:inline">{copy.tabWorkbench}</span>
          </button>

          <button
            type="button"
            data-testid="tab-multiplayer"
            onClick={() => onTabChange('multiplayer')}
            className={`px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeTab === 'multiplayer'
                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-strong)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-transparent'
            }`}
          >
            <GitBranch className="w-3.5 h-3.5 stroke-[1.6]" />
            <span className="hidden sm:inline">{copy.tabMultiplayer}</span>
          </button>

          <button
            type="button"
            data-testid="tab-architecture"
            onClick={() => onTabChange('architecture')}
            className={`px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeTab === 'architecture'
                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-strong)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-transparent'
            }`}
          >
            <Layers className="w-3.5 h-3.5 stroke-[1.6]" />
            <span className="hidden md:inline">{copy.tabArchitecture}</span>
          </button>
        </nav>
      </div>

      {/* Right Instrument Controls */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Live OLAP Engine Badge */}
        <div
          data-testid="engine-badge"
          className="hidden lg:flex items-center gap-1.5 px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-mono-tech text-[11px]"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full animate-telemetry-dot ${
              engine === 'DUCKDB-WASM'
                ? 'bg-[var(--accent-emerald)]'
                : 'bg-[var(--accent-amber)]'
            }`}
          />
          <Cpu className="w-3 h-3 text-[var(--text-muted)]" />
          <span className="text-[var(--text-secondary)]">{engine}</span>
        </div>

        {/* Dataset Row Scale Selector */}
        <div
          className="hidden md:flex items-center rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] p-0.5"
          title={copy.datasetScale}
        >
          {SCALES.map((scale) => {
            const active = rowScale === scale;
            const label = `${scale / 1000}K`;
            return (
              <button
                key={scale}
                type="button"
                disabled={isLoadingScale}
                onClick={() => onRowScaleChange(scale)}
                className={`px-2 py-0.5 rounded-[3px] font-mono-tech text-[10px] transition-colors cursor-pointer ${
                  active
                    ? 'bg-[var(--accent-signal)] text-white font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                } ${isLoadingScale ? 'opacity-50 cursor-wait' : ''}`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* CMD+K Button */}
        <button
          type="button"
          data-testid="cmd-palette-trigger"
          onClick={onOpenCommandPalette}
          className="flex items-center gap-1.5 px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          <Command className="w-3 h-3" />
          <span className="hidden xl:inline">{copy.cmdPalette}</span>
          <kbd className="font-mono-tech text-[10px] px-1 py-0.2 rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)]">
            K
          </kbd>
        </button>

        {/* EN / VI Toggle */}
        <button
          type="button"
          data-testid="locale-toggle"
          onClick={onToggleLocale}
          className="flex items-center gap-1 px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[11px] text-[var(--text-secondary)] transition-colors cursor-pointer"
          title="Switch UI language (EN / VI)"
        >
          <Globe className="w-3 h-3 text-[var(--text-muted)]" />
          <span>{locale.toUpperCase()}</span>
        </button>

        {/* Theme View Transition Wipe Toggle */}
        <button
          type="button"
          data-testid="theme-toggle"
          onClick={onToggleTheme}
          aria-label="Toggle dark and light theme"
          className="p-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          {theme === 'dark' ? (
            <Sun className="w-3.5 h-3.5 stroke-[1.7]" />
          ) : (
            <Moon className="w-3.5 h-3.5 stroke-[1.7]" />
          )}
        </button>
      </div>
    </header>
  );
};
