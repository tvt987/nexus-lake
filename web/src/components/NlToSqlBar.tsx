import React, { useState } from 'react';
import { ArrowRight, CheckCircle2, Sparkles, Terminal } from 'lucide-react';
import type { CopyDict } from '../i18n';
import { NL_TO_SQL_PRESETS, translateNlToSql } from '../engines/nlToSqlEngine';
import type { Locale, NlSqlTranslation, TableSchemaInfo } from '../types/lakehouse';

interface NlToSqlBarProps {
  copy: CopyDict;
  locale: Locale;
  tables: TableSchemaInfo[];
  isBusy: boolean;
  onCompileAndRun: (translation: NlSqlTranslation) => Promise<void>;
}

export const NlToSqlBar: React.FC<NlToSqlBarProps> = ({
  copy,
  locale,
  tables,
  isBusy,
  onCompileAndRun,
}) => {
  const [prompt, setPrompt] = useState('');
  const [lastTranslation, setLastTranslation] = useState<NlSqlTranslation | null>(null);

  const handleDispatch = async (inputOverride?: string) => {
    const text = (inputOverride ?? prompt).trim();
    if (!text || isBusy) return;
    const translated = translateNlToSql(text, tables);
    setLastTranslation(translated);
    setPrompt(text);
    await onCompileAndRun(translated);
  };

  return (
    <section
      data-testid="nl2sql-copilot-bar"
      className="nexus-panel rounded-md overflow-hidden"
    >
      <div className="px-3 py-2 bg-[var(--bg-surface)] flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-3.5 h-3.5 text-[var(--accent-cyan)] shrink-0" />
            <span className="font-mono-tech text-[10.5px] font-semibold tracking-wide text-[var(--text-primary)]">
              {copy.nl2sqlTitle}
            </span>
            <span className="hidden sm:inline-flex items-center gap-1 font-mono-tech text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] border border-[var(--accent-emerald)]/30">
              ZERO-API · READ-ONLY GUARDRAIL
            </span>
          </div>

          {lastTranslation && (
            <div
              data-testid="nl2sql-last-intent"
              className="flex items-center gap-1.5 font-mono-tech text-[9.5px] text-[var(--text-secondary)] min-w-0"
            >
              <CheckCircle2 className="w-3 h-3 text-[var(--accent-emerald)] shrink-0" />
              <span className="text-[var(--accent-cyan)] font-semibold">
                {lastTranslation.targetTable}
              </span>
              <span className="hidden md:inline text-[var(--text-muted)]">·</span>
              <span className="hidden md:inline truncate max-w-[300px]">
                {locale === 'vi' ? lastTranslation.explanationVi : lastTranslation.explanationEn}
              </span>
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleDispatch();
          }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1 min-w-0">
            <Terminal className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              data-testid="nl2sql-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={copy.nl2sqlPlaceholder}
              className="w-full pl-8 pr-3 py-1.5 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] focus:border-[var(--accent-cyan)] focus:outline-none text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
          <button
            type="submit"
            data-testid="nl2sql-compile-btn"
            disabled={isBusy || !prompt.trim()}
            className="px-3 py-1.5 rounded bg-[var(--accent-cyan)] hover:brightness-110 text-[#07080B] font-mono-tech text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-45 transition-all cursor-pointer shrink-0"
          >
            <span>{copy.nl2sqlCompileRun}</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </form>

        {/* Smart Enterprise Preset Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {NL_TO_SQL_PRESETS.map((preset) => {
            const label = locale === 'vi' ? preset.labelVi : preset.labelEn;
            const queryText = locale === 'vi' ? preset.promptVi : preset.promptEn;
            return (
              <button
                key={preset.id}
                type="button"
                data-testid={`nl2sql-preset-${preset.id}`}
                disabled={isBusy}
                onClick={() => void handleDispatch(queryText)}
                className="px-2 py-0.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)] hover:text-[var(--text-primary)] font-mono-tech text-[10px] text-[var(--text-secondary)] whitespace-nowrap flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                <span className="text-[8.5px] px-1 rounded bg-[var(--bg-elevated)] text-[var(--accent-cyan)] font-semibold">
                  {preset.badge}
                </span>
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};
