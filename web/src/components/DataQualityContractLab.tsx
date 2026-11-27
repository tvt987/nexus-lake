import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Download,
  FileCode2,
  Filter,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import {
  CHAOS_INJECTOR_CATALOG,
  createCleanChaosState,
  evaluateDataQualityContracts,
  filterQualityAssertions,
  formatAssertionStatusBadge,
  isChaosFaultActive,
  toggleChaosFault,
} from '../engines/dataQualityEngine';
import { triggerBrowserDownload } from '../engines/exportEngine';
import type {
  DataQualityChaosState,
  DataQualityRuleType,
  DataQualityStatus,
  Locale,
  QualityChaosId,
  QualityContractTableId,
} from '../types/lakehouse';

interface DataQualityContractLabProps {
  copy: CopyDict;
  locale: Locale;
  datasetRowCount: number;
  onRunAuditSql: (sql: string, title: string) => void;
}

const RULE_TYPE_LABELS: Record<DataQualityRuleType, string> = {
  not_null: 'not_null',
  unique: 'unique',
  accepted_range: 'accepted_range',
  referential_integrity: 'relationships (FK)',
  freshness_sla_minutes: 'freshness_sla',
};

function statusBadgeStyle(status: DataQualityStatus): string {
  if (status === 'PASS') {
    return 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] border-[var(--accent-emerald)]/35';
  }
  if (status === 'WARN') {
    return 'bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border-[var(--accent-amber)]/40';
  }
  return 'bg-[var(--accent-crimson-soft)] text-[var(--accent-crimson)] border-[var(--accent-crimson)]/45';
}

function layerBadgeStyle(layer: 'bronze' | 'silver' | 'gold'): string {
  if (layer === 'bronze') {
    return 'bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border-[var(--accent-amber)]/35';
  }
  if (layer === 'silver') {
    return 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] border-[var(--accent-cyan)]/35';
  }
  return 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] border-[var(--accent-emerald)]/35';
}

function trustColorVar(score: number): string {
  if (score >= 98) return 'var(--accent-emerald)';
  if (score >= 82) return 'var(--accent-amber)';
  return 'var(--accent-crimson)';
}

export const DataQualityContractLab: React.FC<DataQualityContractLabProps> = ({
  copy,
  locale,
  datasetRowCount,
  onRunAuditSql,
}) => {
  const [chaos, setChaos] = useState<DataQualityChaosState>(() => createCleanChaosState());
  const [tableFilter, setTableFilter] = useState<QualityContractTableId | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<DataQualityStatus | 'ALL'>('ALL');
  const [hoveredHourIdx, setHoveredHourIdx] = useState<number>(23);
  const [showYamlDrawer, setShowYamlDrawer] = useState<boolean>(false);
  const [copiedYaml, setCopiedYaml] = useState<boolean>(false);

  const report = useMemo(
    () => evaluateDataQualityContracts(datasetRowCount, chaos),
    [datasetRowCount, chaos],
  );

  const visibleAssertions = useMemo(
    () => filterQualityAssertions(report.assertions, tableFilter, statusFilter),
    [report.assertions, tableFilter, statusFilter],
  );

  const hoveredPoint = report.timeline24h[hoveredHourIdx] ?? report.timeline24h[23];

  const handleToggleChaos = (faultId: QualityChaosId) => {
    setChaos((prev) => toggleChaosFault(prev, faultId));
    setHoveredHourIdx(23);
  };

  const handleResetBaseline = () => {
    setChaos(createCleanChaosState());
    setStatusFilter('ALL');
    setHoveredHourIdx(23);
  };

  const handleCopyYaml = async () => {
    try {
      await navigator.clipboard.writeText(report.dbtSchemaYaml);
      setCopiedYaml(true);
      window.setTimeout(() => setCopiedYaml(false), 1800);
    } catch {
      setShowYamlDrawer(true);
    }
  };

  const handleExportYaml = () => {
    triggerBrowserDownload('schema.yml', report.dbtSchemaYaml, 'text/yaml;charset=utf-8');
  };

  // SVG Timeline geometry
  const svgW = 840;
  const svgH = 228;
  const padL = 46;
  const padR = 52;
  const padT = 22;
  const padB = 34;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;
  const lagCeiling = Math.max(60, Math.ceil(Math.max(...report.timeline24h.map((p) => p.freshnessLagMinutes)) / 10) * 10);
  const slaY = padT + plotH * (1 - 15 / lagCeiling);

  const timelineCoords = useMemo(() => {
    return report.timeline24h.map((pt, idx) => {
      const x = padL + (idx / Math.max(1, report.timeline24h.length - 1)) * plotW;
      const trustY = padT + plotH * (1 - pt.trustScore / 100);
      const lagBarH = Math.max(2, (Math.min(lagCeiling, pt.freshnessLagMinutes) / lagCeiling) * plotH);
      const lagY = padT + plotH - lagBarH;
      return { pt, x, trustY, lagBarH, lagY };
    });
  }, [report.timeline24h, lagCeiling, padL, padT, plotH, plotW]);

  const trustLinePath = timelineCoords
    .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.trustY.toFixed(1)}`)
    .join(' ');
  const trustAreaPath = `${trustLinePath} L ${(padL + plotW).toFixed(1)} ${(padT + plotH).toFixed(1)} L ${padL.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  // Radial gauge geometry
  const gaugeR = 26;
  const gaugeCirc = 2 * Math.PI * gaugeR;
  const gaugeOffset = gaugeCirc * (1 - report.dataTrustScore / 100);
  const scoreStroke = trustColorVar(report.dataTrustScore);

  const peakLagMin = Math.max(...report.tableSummaries.map((t) => t.freshnessLagMinutes));

  return (
    <div data-testid="data-quality-contract-lab" className="space-y-5">
      {/* Header & Export Toolbar */}
      <section className="nexus-panel rounded-lg overflow-hidden">
        <div className="px-4 py-3.5 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-[var(--accent-signal-soft)] border border-[var(--accent-signal)]/25 flex items-center justify-center shrink-0 mt-0.5">
              <ShieldCheck className="w-4.5 h-4.5 text-[var(--accent-signal)]" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display font-bold text-base text-[var(--text-primary)] m-0 tracking-tight">
                  {copy.qualityTitle}
                </h2>
                <span className="font-mono-tech text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] border border-[var(--accent-cyan)]/30 font-semibold">
                  dbt-test · Great Expectations
                </span>
                <span
                  data-testid="dq-overall-status-badge"
                  className={`font-mono-tech text-[10px] px-2 py-0.5 rounded-full border font-semibold ${
                    report.overallStatus === 'HEALTHY'
                      ? 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] border-[var(--accent-emerald)]/35'
                      : report.overallStatus === 'DEGRADED'
                        ? 'bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border-[var(--accent-amber)]/35'
                        : 'bg-[var(--accent-crimson-soft)] text-[var(--accent-crimson)] border-[var(--accent-crimson)]/40'
                  }`}
                >
                  {report.overallStatus}
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)] m-0 mt-1 leading-relaxed">
                {locale === 'vi'
                  ? 'Thực thi hợp đồng chất lượng dữ liệu thời gian thực trên bronze_orders, silver_vouchers và gold_store_kpis. Tiêm lỗi hỗn loạn 1-click để kiểm chứng điểm tin cậy, cách ly dòng lỗi và xuất dbt schema.yml.'
                  : 'Real-time assertion contracts across bronze_orders, silver_vouchers, and gold_store_kpis. Trigger 1-click chaos injectors to stress-test trust scoring, quarantine routing, freshness SLAs, and dbt schema.yml generation.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="toggle-dbt-yaml-btn"
              onClick={() => setShowYamlDrawer((v) => !v)}
              className={`px-2.5 py-1.5 rounded-md border font-mono-tech text-[11px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
                showYamlDrawer
                  ? 'border-[var(--accent-signal)] bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
              }`}
            >
              <FileCode2 className="w-3.5 h-3.5" />
              <span>{showYamlDrawer ? 'Hide schema.yml' : 'Inspect schema.yml'}</span>
            </button>

            <button
              type="button"
              data-testid="copy-dbt-yaml-btn"
              onClick={() => void handleCopyYaml()}
              className="px-2.5 py-1.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] font-mono-tech text-[11px] text-[var(--text-secondary)] flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              {copiedYaml ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[var(--accent-emerald)]" />
                  <span className="text-[var(--accent-emerald)]">Copied YAML</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy YAML</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="export-dbt-yaml-btn"
              onClick={handleExportYaml}
              className="px-3 py-1.5 rounded-md bg-[var(--accent-signal)] hover:brightness-110 text-white font-mono-tech text-[11px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer shadow-xs"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export schema.yml</span>
            </button>
          </div>
        </div>

        {/* 1-Click Chaos Injector Controls */}
        <div className="px-4 py-3 bg-[var(--bg-inset)] flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 shrink-0">
            <Zap className="w-3.5 h-3.5 text-[var(--accent-amber)]" />
            <span className="font-mono-tech text-[10.5px] font-semibold tracking-wider uppercase text-[var(--text-secondary)]">
              {locale === 'vi' ? 'Bơm Lỗi Hỗn Loạn (1-Click Chaos)' : '1-Click Chaos Injectors'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {CHAOS_INJECTOR_CATALOG.map((item) => {
              const active = isChaosFaultActive(chaos, item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`chaos-${item.id.replace(/_/g, '-')}`}
                  aria-pressed={active}
                  title={locale === 'vi' ? item.summaryVi : item.summaryEn}
                  onClick={() => handleToggleChaos(item.id)}
                  className={`px-3 py-1.5 rounded-md border font-mono-tech text-[11px] font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                    active
                      ? 'border-[var(--accent-crimson)] bg-[var(--accent-crimson-soft)] text-[var(--accent-crimson)] font-semibold shadow-xs'
                      : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:border-[var(--accent-signal)] hover:text-[var(--accent-signal)]'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      active
                        ? 'bg-[var(--accent-crimson)] animate-telemetry-dot'
                        : 'bg-[var(--text-muted)]/50'
                    }`}
                  />
                  <span>{locale === 'vi' ? item.labelVi : item.labelEn}</span>
                </button>
              );
            })}

            <button
              type="button"
              data-testid="chaos-reset-baseline"
              onClick={handleResetBaseline}
              className="px-3 py-1.5 rounded-md border border-[var(--accent-emerald)]/45 bg-[var(--accent-emerald-soft)] hover:brightness-105 text-[var(--accent-emerald)] font-mono-tech text-[11px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{locale === 'vi' ? 'Khôi Phục Chuẩn 100%' : 'Reset Clean Baseline'}</span>
            </button>
          </div>
        </div>
      </section>

      {/* Expandable dbt schema.yml Preview Drawer */}
      {showYamlDrawer && (
        <section
          data-testid="dbt-yaml-preview"
          className="nexus-panel rounded-lg overflow-hidden"
        >
          <div className="px-4 py-2.5 nexus-hairline-b bg-[var(--bg-surface)] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-mono-tech text-xs font-semibold text-[var(--text-primary)]">
              <FileCode2 className="w-4 h-4 text-[var(--accent-cyan)]" />
              <span>models/retail_lakehouse/schema.yml</span>
              <span className="text-[10px] font-normal text-[var(--text-muted)]">
                dbt Core v1.9 · Contract Enforced
              </span>
            </div>
            <span className="font-mono-tech text-[10px] text-[var(--accent-emerald)]">
              {report.dbtSchemaYaml.split('\n').length} lines
            </span>
          </div>
          <pre className="m-0 p-4 bg-[var(--bg-inset)] font-mono-tech text-[11.5px] leading-relaxed text-[var(--text-primary)] overflow-x-auto max-h-72">
            <code>{report.dbtSchemaYaml}</code>
          </pre>
        </section>
      )}

      {/* 4 Hero Telemetry KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* KPI 1: Overall Data Trust Score */}
        <div className="nexus-panel rounded-lg p-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] m-0">
              {locale === 'vi' ? 'Điểm Tin Cậy Dữ Liệu' : 'Overall Data Trust Score'}
            </p>
            <div className="flex items-baseline gap-2 mt-1.5">
              <span
                data-testid="dq-trust-score"
                className="font-display font-bold text-3xl tabular-nums tracking-tight"
                style={{ color: scoreStroke }}
              >
                {report.dataTrustScore.toFixed(1)}%
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] m-0 mt-1">
              {report.activeChaosIds.length === 0
                ? 'Clean baseline · Zero contract drift'
                : `${report.activeChaosIds.length} active chaos fault(s) injected`}
            </p>
          </div>
          <svg width="68" height="68" viewBox="0 0 68 68" className="shrink-0" aria-hidden="true">
            <circle
              cx="34"
              cy="34"
              r={gaugeR}
              fill="none"
              stroke="var(--border-hairline)"
              strokeWidth="6"
            />
            <circle
              cx="34"
              cy="34"
              r={gaugeR}
              fill="none"
              stroke={scoreStroke}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={gaugeCirc}
              strokeDashoffset={gaugeOffset}
              transform="rotate(-90 34 34)"
              style={{ transition: 'stroke-dashoffset 280ms ease, stroke 220ms ease' }}
            />
            <text
              x="34"
              y="38"
              textAnchor="middle"
              fill="var(--text-primary)"
              fontSize="11"
              fontFamily="JetBrains Mono, monospace"
              fontWeight="700"
            >
              {Math.round(report.dataTrustScore)}
            </text>
          </svg>
        </div>

        {/* KPI 2: Assertions Pass / Warn / Fail */}
        <div className="nexus-panel rounded-lg p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] m-0">
              {locale === 'vi' ? 'Trạng Thái Kiểm Định dbt' : 'Active dbt Assertions'}
            </p>
            <CheckCircle2 className="w-4 h-4 text-[var(--accent-cyan)]" />
          </div>
          <div
            data-testid="dq-assertions-summary"
            className="font-display font-bold text-2xl tabular-nums text-[var(--text-primary)] mt-2"
          >
            {report.passedRules} / {report.totalRules}{' '}
            <span className="text-xs font-mono-tech font-semibold text-[var(--accent-emerald)]">
              PASS
            </span>
          </div>
          <div className="flex items-center gap-2 mt-2 font-mono-tech text-[10.5px]">
            <span className="px-1.5 py-0.5 rounded bg-[var(--accent-crimson-soft)] text-[var(--accent-crimson)] font-semibold">
              {report.failedRules} FAIL
            </span>
            <span className="px-1.5 py-0.5 rounded bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] font-semibold">
              {report.warnRules} WARN
            </span>
            <span className="text-[var(--text-muted)]">5 rule types</span>
          </div>
        </div>

        {/* KPI 3: Quarantined Rows */}
        <div className="nexus-panel rounded-lg p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] m-0">
              {locale === 'vi' ? 'Dòng Đã Cách Ly (Quarantine)' : 'Quarantined Rows'}
            </p>
            <ShieldAlert
              className={`w-4 h-4 ${
                report.totalQuarantinedRows > 0
                  ? 'text-[var(--accent-crimson)]'
                  : 'text-[var(--accent-emerald)]'
              }`}
            />
          </div>
          <div
            data-testid="dq-quarantined-rows"
            className={`font-display font-bold text-2xl tabular-nums mt-2 ${
              report.totalQuarantinedRows > 0
                ? 'text-[var(--accent-crimson)]'
                : 'text-[var(--text-primary)]'
            }`}
          >
            {report.totalQuarantinedRows.toLocaleString('en-US')}
          </div>
          <p className="text-[11px] text-[var(--text-muted)] m-0 mt-1.5">
            {report.totalQuarantinedRows > 0
              ? 'Isolated to dead_letter_quarantine before Gold merge'
              : 'Zero corrupted records intercepted'}
          </p>
        </div>

        {/* KPI 4: Freshness SLA Health */}
        <div className="nexus-panel rounded-lg p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] m-0">
              {locale === 'vi' ? 'Vi Phạm SLA Độ Tươi' : 'Freshness SLA Breaches'}
            </p>
            <Clock
              className={`w-4 h-4 ${
                report.slaBreachCount > 0
                  ? 'text-[var(--accent-crimson)]'
                  : 'text-[var(--accent-emerald)]'
              }`}
            />
          </div>
          <div
            data-testid="dq-sla-breaches"
            className={`font-display font-bold text-2xl tabular-nums mt-2 ${
              report.slaBreachCount > 0
                ? 'text-[var(--accent-crimson)]'
                : 'text-[var(--accent-emerald)]'
            }`}
          >
            {report.slaBreachCount} / 3{' '}
            <span className="text-xs font-mono-tech font-medium text-[var(--text-muted)]">
              Peak {peakLagMin.toFixed(1)}m
            </span>
          </div>
          <p className="text-[11px] text-[var(--text-muted)] m-0 mt-1.5">
            {report.slaBreachCount > 0
              ? 'Kafka CDC pipeline lag exceeding freshness contract'
              : 'All Bronze / Silver / Gold SLAs within budget'}
          </p>
        </div>
      </div>

      {/* Interactive SVG 24-Hour Freshness & Quality Health Timeline */}
      <section className="nexus-panel rounded-lg overflow-hidden">
        <div className="px-4 py-3 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[var(--accent-signal)]" />
            <h3 className="font-display font-semibold text-sm text-[var(--text-primary)] m-0">
              {locale === 'vi'
                ? 'Biểu Đồ Sức Khỏe Chất Lượng & Độ Trễ CDC 24 Giờ'
                : '24-Hour Freshness & Quality Health Timeline'}
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-3 font-mono-tech text-[10.5px]">
            <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span className="w-2.5 h-0.5 rounded bg-[var(--accent-cyan)] inline-block" />
              Trust Score (%)
            </span>
            <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span className="w-2.5 h-2.5 rounded-xs bg-[var(--accent-signal)]/35 border border-[var(--accent-signal)] inline-block" />
              CDC Lag (min)
            </span>
            <span className="flex items-center gap-1.5 text-[var(--accent-amber)]">
              <span className="w-3 border-t border-dashed border-[var(--accent-amber)] inline-block" />
              15m SLA Limit
            </span>
          </div>
        </div>

        {/* Live Hovered Bucket Telemetry Bar */}
        <div className="px-4 py-2 nexus-hairline-b bg-[var(--bg-inset)] flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[11px]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[var(--text-muted)]">
              BUCKET:{' '}
              <strong className="text-[var(--text-primary)]">{hoveredPoint.hourLabel}</strong>
            </span>
            <span className="text-[var(--text-muted)]">
              TRUST:{' '}
              <strong style={{ color: trustColorVar(hoveredPoint.trustScore) }}>
                {hoveredPoint.trustScore.toFixed(1)}%
              </strong>
            </span>
            <span className="text-[var(--text-muted)]">
              MAX LAG:{' '}
              <strong
                className={
                  hoveredPoint.slaBreached
                    ? 'text-[var(--accent-crimson)]'
                    : 'text-[var(--accent-cyan)]'
                }
              >
                {hoveredPoint.freshnessLagMinutes.toFixed(1)} min
              </strong>
            </span>
            <span className="text-[var(--text-muted)]">
              QUARANTINED:{' '}
              <strong className="text-[var(--text-primary)]">
                {hoveredPoint.quarantinedRows.toLocaleString('en-US')}
              </strong>
            </span>
          </div>
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
              hoveredPoint.slaBreached
                ? 'bg-[var(--accent-crimson-soft)] text-[var(--accent-crimson)]'
                : 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)]'
            }`}
          >
            {hoveredPoint.slaBreached ? 'SLA BREACHED' : 'WITHIN SLA'}
          </span>
        </div>

        <div className="p-3 bg-[var(--bg-surface)] overflow-x-auto">
          <svg
            data-testid="dq-health-timeline-svg"
            viewBox={`0 0 ${svgW} ${svgH}`}
            className="w-full h-auto min-w-[540px] block"
            role="img"
            aria-label="24-Hour Freshness and Data Quality Health Timeline"
          >
            <defs>
              <linearGradient id="dqTrustAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.26" />
                <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.01" />
              </linearGradient>
            </defs>

            {/* Horizontal Grid Lines */}
            {[0, 25, 50, 75, 100].map((pct) => {
              const y = padT + plotH * (1 - pct / 100);
              const lagTick = Math.round((pct / 100) * lagCeiling);
              return (
                <g key={pct}>
                  <line
                    x1={padL}
                    y1={y}
                    x2={padL + plotW}
                    y2={y}
                    stroke="var(--border-hairline)"
                    strokeWidth="1"
                  />
                  <text
                    x={padL - 8}
                    y={y + 3.5}
                    textAnchor="end"
                    fill="var(--text-muted)"
                    fontSize="9.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {pct}%
                  </text>
                  <text
                    x={padL + plotW + 8}
                    y={y + 3.5}
                    textAnchor="start"
                    fill="var(--text-muted)"
                    fontSize="9.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {lagTick}m
                  </text>
                </g>
              );
            })}

            {/* 15-Minute Freshness SLA Threshold Dashed Line */}
            <line
              x1={padL}
              y1={slaY}
              x2={padL + plotW}
              y2={slaY}
              stroke="var(--accent-amber)"
              strokeWidth="1.4"
              strokeDasharray="5 4"
            />
            <text
              x={padL + 6}
              y={Math.max(padT + 10, slaY - 5)}
              fill="var(--accent-amber)"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
              fontWeight="600"
            >
              15m FRESHNESS SLA LIMIT
            </text>

            {/* Trust Score Area & Polyline */}
            <path d={trustAreaPath} fill="url(#dqTrustAreaGrad)" />
            <path
              d={trustLinePath}
              fill="none"
              stroke="var(--accent-cyan)"
              strokeWidth="2.4"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* CDC Lag Bars & Interactive Hover Columns */}
            {timelineCoords.map(({ pt, x, trustY, lagBarH, lagY }) => {
              const slotW = plotW / 23;
              const barW = Math.max(8, Math.min(18, slotW * 0.42));
              const isHovered = hoveredHourIdx === pt.hourIndex;
              const showTick = pt.hourIndex % 3 === 0 || pt.hourIndex === 23;

              return (
                <g
                  key={pt.hourIndex}
                  onMouseEnter={() => setHoveredHourIdx(pt.hourIndex)}
                  onClick={() => setHoveredHourIdx(pt.hourIndex)}
                  className="cursor-pointer"
                >
                  {/* Hover column highlight */}
                  <rect
                    x={x - slotW / 2}
                    y={padT}
                    width={slotW}
                    height={plotH}
                    fill={isHovered ? 'var(--bg-elevated)' : 'transparent'}
                    opacity={isHovered ? 0.65 : 0}
                  />

                  {/* CDC Lag vertical bar */}
                  <rect
                    x={x - barW / 2}
                    y={lagY}
                    width={barW}
                    height={lagBarH}
                    rx="2"
                    fill={pt.slaBreached ? 'var(--accent-crimson)' : 'var(--accent-signal)'}
                    opacity={pt.slaBreached ? 0.78 : isHovered ? 0.48 : 0.25}
                  />

                  {/* Trust Score Point */}
                  <circle
                    cx={x}
                    cy={trustY}
                    r={isHovered || pt.hourIndex === 23 ? 4.5 : 2.8}
                    fill={
                      pt.trustScore < 85
                        ? 'var(--accent-crimson)'
                        : pt.trustScore < 98
                          ? 'var(--accent-amber)'
                          : 'var(--accent-emerald)'
                    }
                    stroke="var(--bg-surface)"
                    strokeWidth="1.6"
                  />

                  {/* X-axis tick label */}
                  {showTick && (
                    <text
                      x={x}
                      y={svgH - 10}
                      textAnchor="middle"
                      fill={pt.hourIndex === 23 ? 'var(--accent-signal)' : 'var(--text-muted)'}
                      fontSize="9.5"
                      fontFamily="JetBrains Mono, monospace"
                      fontWeight={pt.hourIndex === 23 ? '700' : '500'}
                    >
                      {pt.hourLabel}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </section>

      {/* Per-Table Medallion Contract Health Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {report.tableSummaries.map((tbl) => {
          const isSelected = tableFilter === tbl.table;
          return (
            <button
              key={tbl.table}
              type="button"
              data-testid={`dq-table-card-${tbl.table}`}
              onClick={() => setTableFilter((prev) => (prev === tbl.table ? 'ALL' : tbl.table))}
              className={`nexus-panel rounded-lg p-4 text-left transition-all cursor-pointer ${
                isSelected
                  ? 'ring-2 ring-[var(--accent-signal)] border-[var(--accent-signal)]'
                  : 'hover:border-[var(--border-strong)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Database className="w-4 h-4 text-[var(--accent-signal)] shrink-0" />
                  <span className="font-mono-tech text-xs font-bold text-[var(--text-primary)] truncate">
                    {tbl.table}
                  </span>
                </div>
                <span
                  className={`font-mono-tech text-[9.5px] px-1.5 py-0.5 rounded border uppercase font-semibold shrink-0 ${layerBadgeStyle(tbl.layer)}`}
                >
                  {tbl.layer}
                </span>
              </div>

              <p className="text-[11.5px] text-[var(--text-muted)] m-0 mt-1.5 line-clamp-2">
                {tbl.description}
              </p>

              <div className="grid grid-cols-3 gap-2 mt-3 pt-3 nexus-hairline-t font-mono-tech">
                <div>
                  <div className="text-[9.5px] uppercase text-[var(--text-muted)]">Trust</div>
                  <div
                    className="text-sm font-bold tabular-nums"
                    style={{ color: trustColorVar(tbl.trustScore) }}
                  >
                    {tbl.trustScore.toFixed(1)}%
                  </div>
                </div>
                <div>
                  <div className="text-[9.5px] uppercase text-[var(--text-muted)]">Freshness</div>
                  <div
                    className={`text-sm font-bold tabular-nums ${
                      tbl.freshnessLagMinutes > tbl.slaLimitMinutes
                        ? 'text-[var(--accent-crimson)]'
                        : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {tbl.freshnessLagMinutes.toFixed(1)}m
                    <span className="text-[10px] font-normal text-[var(--text-muted)]">
                      /{tbl.slaLimitMinutes}m
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-[9.5px] uppercase text-[var(--text-muted)]">Quarantine</div>
                  <div
                    className={`text-sm font-bold tabular-nums ${
                      tbl.quarantinedRows > 0
                        ? 'text-[var(--accent-crimson)]'
                        : 'text-[var(--accent-emerald)]'
                    }`}
                  >
                    {tbl.quarantinedRows.toLocaleString('en-US')}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Live dbt-test / Great Expectations Assertion Matrix */}
      <section className="nexus-panel rounded-lg overflow-hidden">
        <div className="px-4 py-3 nexus-hairline-b bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-[var(--accent-cyan)]" />
            <h3 className="font-display font-semibold text-sm text-[var(--text-primary)] m-0">
              {locale === 'vi'
                ? 'Ma Trận Kiểm Định Hợp Đồng Dữ Liệu'
                : 'Contract Assertion Matrix (dbt-test & Great Expectations)'}
            </h3>
            <span className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)]">
              {visibleAssertions.length} / {report.totalRules} rules
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {(['ALL', 'bronze_orders', 'silver_vouchers', 'gold_store_kpis'] as const).map(
              (tbl) => (
                <button
                  key={tbl}
                  type="button"
                  onClick={() => setTableFilter(tbl)}
                  className={`px-2 py-1 rounded font-mono-tech text-[10px] border transition-colors cursor-pointer ${
                    tableFilter === tbl
                      ? 'border-[var(--accent-signal)] bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] font-semibold'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  {tbl === 'ALL' ? 'All Tables' : tbl}
                </button>
              ),
            )}

            <span className="w-px h-4 bg-[var(--border-hairline)] mx-1 hidden sm:inline-block" />

            {(['ALL', 'CRITICAL_FAIL', 'WARN', 'PASS'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-2 py-1 rounded font-mono-tech text-[10px] border transition-colors cursor-pointer ${
                  statusFilter === st
                    ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] font-semibold'
                    : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                }`}
              >
                {st === 'ALL' ? 'All Status' : formatAssertionStatusBadge(st)}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto bg-[var(--bg-surface)]">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="nexus-hairline-b bg-[var(--bg-inset)] font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Table · Column</th>
                <th className="px-4 py-2.5">Assertion Rule (dbt / GE)</th>
                <th className="px-4 py-2.5">Contract SLA / Bound</th>
                <th className="px-4 py-2.5">Observed Telemetry</th>
                <th className="px-4 py-2.5 text-right">Quarantine</th>
                <th className="px-4 py-2.5 text-right">Audit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-hairline)] text-xs">
              {visibleAssertions.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center font-mono-tech text-xs text-[var(--text-muted)]"
                  >
                    No assertions match the active table/status filter.
                  </td>
                </tr>
              ) : (
                visibleAssertions.map((rule) => (
                  <tr
                    key={rule.ruleId}
                    data-testid={`dq-rule-row-${rule.ruleId}`}
                    className={`transition-colors ${
                      rule.status === 'CRITICAL_FAIL'
                        ? 'bg-[var(--accent-crimson-soft)]/50 hover:bg-[var(--accent-crimson-soft)]'
                        : rule.status === 'WARN'
                          ? 'bg-[var(--accent-amber-soft)]/40 hover:bg-[var(--accent-amber-soft)]/70'
                          : 'hover:bg-[var(--bg-elevated)]/65'
                    }`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span
                        data-testid="dq-assertion-status"
                        data-status={rule.status}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-mono-tech text-[10px] font-semibold ${statusBadgeStyle(rule.status)}`}
                      >
                        {rule.status === 'PASS' ? (
                          <CheckCircle2 className="w-3 h-3" />
                        ) : rule.status === 'WARN' ? (
                          <AlertTriangle className="w-3 h-3" />
                        ) : (
                          <AlertOctagon className="w-3 h-3" />
                        )}
                        {formatAssertionStatusBadge(rule.status)}
                      </span>
                    </td>

                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <div className="font-mono-tech font-semibold text-[11.5px] text-[var(--text-primary)]">
                        {rule.table}
                      </div>
                      <div className="font-mono-tech text-[10.5px] text-[var(--text-muted)]">
                        .{rule.column}
                      </div>
                    </td>

                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--accent-signal)] font-semibold">
                          {RULE_TYPE_LABELS[rule.ruleType]}
                        </span>
                        <span className="font-mono-tech text-[11px] text-[var(--text-primary)]">
                          {rule.dbtTestName}
                        </span>
                      </div>
                      <div className="font-mono-tech text-[10px] text-[var(--text-muted)] mt-0.5">
                        GE: {rule.geExpectation}
                      </div>
                    </td>

                    <td className="px-4 py-2.5 font-mono-tech text-[11px] text-[var(--text-secondary)]">
                      {rule.thresholdLabel}
                    </td>

                    <td className="px-4 py-2.5 font-mono-tech text-[11px] font-medium text-[var(--text-primary)] whitespace-nowrap">
                      {rule.observedLabel}
                    </td>

                    <td className="px-4 py-2.5 text-right font-mono-tech text-[11.5px] tabular-nums whitespace-nowrap">
                      <span
                        className={
                          rule.quarantinedRows > 0
                            ? 'text-[var(--accent-crimson)] font-bold'
                            : 'text-[var(--text-muted)]'
                        }
                      >
                        {rule.quarantinedRows.toLocaleString('en-US')}
                      </span>
                    </td>

                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() =>
                          onRunAuditSql(
                            rule.remediationSql,
                            `DQ Audit · ${rule.table}.${rule.column}`,
                          )
                        }
                        className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-signal)] hover:text-[var(--accent-signal)] font-mono-tech text-[10px] text-[var(--text-secondary)] inline-flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <Play className="w-2.5 h-2.5 fill-current" />
                        <span>SQL</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
