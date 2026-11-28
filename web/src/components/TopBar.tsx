import React from 'react';
import {
  BadgeCheck,
  Command,
  Cpu,
  Database,
  FileUp,
  Flame,
  GitBranch,
  GitFork,
  Globe,
  Layers,
  Moon,
  Radio,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import type {
  CdcTelemetryState,
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
  cdcTelemetry: CdcTelemetryState;
  onToggleCdcStream: () => void;
  theme: ThemeMode;
  onToggleTheme: (e: React.MouseEvent<HTMLButtonElement>) => void;
  locale: Locale;
  onToggleLocale: () => void;
  onOpenCommandPalette: () => void;
  onOpenEnterpriseLicense: () => void;
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
  cdcTelemetry,
  onToggleCdcStream,
  theme,
  onToggleTheme,
  locale,
  onToggleLocale,
  onOpenCommandPalette,
  onOpenEnterpriseLicense,
}) => {
  const navItems: {
    id: WorkspaceTab;
    label: string;
    shortLabel: string;
    Icon: React.ComponentType<{ className?: string }>;
  }[] = [
    { id: 'workbench', label: copy.tabWorkbench, shortLabel: 'SQL', Icon: Database },
    { id: 'quality', label: copy.tabQuality, shortLabel: 'Quality', Icon: BadgeCheck },
    { id: 'lineage', label: copy.tabLineage, shortLabel: 'Lineage', Icon: GitFork },
    { id: 'ingest', label: copy.tabIngest, shortLabel: 'Ingest', Icon: FileUp },
    { id: 'cohorts', label: copy.tabCohorts, shortLabel: 'Cohort', Icon: Flame },
    { id: 'multiplayer', label: copy.tabMultiplayer, shortLabel: 'CRDT', Icon: GitBranch },
    { id: 'architecture', label: copy.tabArchitecture, shortLabel: 'Arch', Icon: Layers },
  ];

  return (
    <header className="h-[52px] shrink-0 px-2.5 sm:px-4 flex items-center justify-between gap-2 nexus-hairline-b bg-[var(--bg-surface)] select-none overflow-hidden">
      {/* Brand + Clean Single-Row Tabs */}
      <div className="flex items-center gap-2 sm:gap-3.5 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <svg
            width="24"
            height="24"
            viewBox="0 0 64 64"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            <rect width="64" height="64" rx="14" fill="var(--bg-inset)" />
            <rect
              x="1.5"
              y="1.5"
              width="61"
              height="61"
              rx="12.5"
              stroke="var(--border-strong)"
              strokeWidth="2"
            />
            <path
              d="M32 11L51 21.5L32 32L13 21.5L32 11Z"
              stroke="var(--accent-cyan)"
              strokeWidth="3.2"
              strokeLinejoin="round"
            />
            <path
              d="M13 32L32 42.5L51 32"
              stroke="var(--text-primary)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M13 42.5L32 53L51 42.5"
              stroke="var(--accent-signal)"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="32" cy="21.5" r="3.6" fill="var(--accent-signal)" />
          </svg>
          <div className="hidden sm:block leading-none">
            <div className="flex items-center gap-1.5">
              <span className="font-display font-bold text-xs sm:text-sm tracking-tight text-[var(--text-primary)] whitespace-nowrap">
                NEXUS LAKE
              </span>
              <span
                data-testid="version-badge"
                className="inline-block font-mono-tech text-[9.5px] px-1.5 py-0.5 rounded-full bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] border border-[var(--accent-signal)]/30 whitespace-nowrap font-semibold"
              >
                v6.0
              </span>
            </div>
            <p className="hidden 2xl:block text-[9px] font-mono-tech tracking-wider text-[var(--text-muted)] mt-0.5 m-0">
              {copy.subtitle}
            </p>
          </div>
        </div>

        <nav
          className="flex items-center gap-0.5 sm:gap-1 min-w-0"
          aria-label="Workspace views"
        >
          {navItems.map(({ id, label, shortLabel, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                data-testid={`tab-${id}`}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                title={label}
                onClick={() => onTabChange(id)}
                className={`p-1.5 sm:px-2.5 sm:py-1.5 rounded-md text-[11.5px] font-medium flex items-center gap-1.5 transition-all cursor-pointer shrink-0 ${
                  active
                    ? 'bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] border border-[var(--accent-signal)]/30 font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] border border-transparent'
                }`}
              >
                <Icon
                  className={`w-3.5 h-3.5 stroke-[1.8] shrink-0 ${
                    active ? 'text-[var(--accent-signal)]' : 'text-[var(--text-muted)]'
                  }`}
                />
                <span className="hidden 2xl:inline whitespace-nowrap">{label}</span>
                <span className="hidden md:inline 2xl:hidden whitespace-nowrap">{shortLabel}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Right Instrument Controls */}
      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
        {/* Live Streaming CDC Toggle */}
        <button
          type="button"
          data-testid="cdc-stream-toggle"
          onClick={onToggleCdcStream}
          title="Toggle +5,000 tx/sec Simulated Kafka CDC Ingest"
          className={`hidden lg:flex items-center gap-1 px-2 py-1 rounded-md border font-mono-tech text-[10px] font-medium transition-colors cursor-pointer ${
            cdcTelemetry.isStreaming
              ? cdcTelemetry.burstAlertActive
                ? 'border-[var(--accent-crimson)] bg-[var(--accent-crimson-soft)] text-[var(--accent-crimson)]'
                : 'border-[var(--accent-emerald)] bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]'
              : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              cdcTelemetry.isStreaming
                ? cdcTelemetry.burstAlertActive
                  ? 'bg-[var(--accent-crimson)] animate-telemetry-dot'
                  : 'bg-[var(--accent-emerald)] animate-telemetry-dot'
                : 'bg-[var(--text-muted)]'
            }`}
          />
          <Radio className="w-3 h-3 shrink-0" />
          <span className="hidden 2xl:inline">
            {cdcTelemetry.isStreaming
              ? `${copy.liveCdcActive} +${(cdcTelemetry.currentRateTxSec / 1000).toFixed(1)}K/s`
              : copy.liveCdcLabel}
          </span>
          <span className="2xl:hidden">{cdcTelemetry.isStreaming ? 'LIVE' : 'CDC'}</span>
        </button>

        {/* Live OLAP Engine Badge */}
        <div
          data-testid="engine-badge"
          className="hidden 2xl:flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-inset)] font-mono-tech text-[10.5px]"
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
          className="hidden xl:flex items-center rounded-md border border-[var(--border-hairline)] bg-[var(--bg-inset)] p-0.5"
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
                className={`px-1.5 py-0.5 rounded-[4px] font-mono-tech text-[9.5px] transition-colors cursor-pointer ${
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

        {/* Enterprise License Commissioning VietQR CTA */}
        <button
          type="button"
          data-testid="enterprise-license-btn"
          onClick={onOpenEnterpriseLicense}
          title={copy.enterpriseModalTitle}
          className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--accent-signal)]/45 bg-[var(--accent-signal-soft)] hover:bg-[var(--accent-signal)] hover:text-white text-[var(--accent-signal)] font-mono-tech text-[10px] font-semibold transition-colors cursor-pointer whitespace-nowrap"
        >
          <ShieldCheck className="w-3 h-3 shrink-0" />
          <span className="hidden xl:inline">{copy.enterpriseLicenseBtn}</span>
          <span className="xl:hidden">PRO</span>
        </button>

        {/* CMD+K Button */}
        <button
          type="button"
          data-testid="cmd-palette-trigger"
          onClick={onOpenCommandPalette}
          aria-label="Open command palette"
          className="hidden lg:flex items-center gap-1 px-1.5 py-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          <Command className="w-3 h-3" />
          <kbd className="font-mono-tech text-[9.5px] px-1 rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)]">
            K
          </kbd>
        </button>

        {/* EN / VI Toggle */}
        <button
          type="button"
          data-testid="locale-toggle"
          onClick={onToggleLocale}
          className="flex items-center gap-1 px-1.5 py-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10.5px] text-[var(--text-secondary)] transition-colors cursor-pointer"
          title="Switch UI language (EN / VI)"
        >
          <Globe className="hidden sm:block w-3 h-3 text-[var(--text-muted)]" />
          <span>{locale.toUpperCase()}</span>
        </button>

        {/* Crisp Daylight Paper <-> Obsidian Lakehouse Dual-Theme Toggle */}
        <button
          type="button"
          data-testid="theme-toggle"
          data-active-theme={theme}
          onClick={onToggleTheme}
          aria-label={
            theme === 'light'
              ? 'Switch to Obsidian Lakehouse dark theme'
              : 'Switch to Daylight Paper light theme'
          }
          title={
            theme === 'light'
              ? 'Daylight Paper active — click for Obsidian Lakehouse'
              : 'Obsidian Lakehouse active — click for Daylight Paper'
          }
          className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:border-[var(--accent-signal)] text-[var(--text-primary)] font-mono-tech text-[10.5px] font-medium transition-colors cursor-pointer shrink-0"
        >
          {theme === 'light' ? (
            <>
              <Sun className="w-3.5 h-3.5 text-[var(--accent-amber)] stroke-[1.9]" />
              <span className="hidden sm:inline">{copy.themeDaylight}</span>
            </>
          ) : (
            <>
              <Moon className="w-3.5 h-3.5 text-[var(--accent-cyan)] stroke-[1.9]" />
              <span className="hidden sm:inline">{copy.themeObsidian}</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
};
