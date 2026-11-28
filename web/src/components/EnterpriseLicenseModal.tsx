import React, { useMemo, useState } from 'react';
import {
  Building2,
  Check,
  CheckCircle2,
  Copy,
  Mail,
  Phone,
  QrCode,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import {
  buildEnterpriseVietQrUrl,
  ENTERPRISE_LICENSE_BANK,
} from '../engines/exportEngine';
import type { Locale } from '../types/lakehouse';

interface EnterpriseLicenseModalProps {
  open: boolean;
  onClose: () => void;
  copy: CopyDict;
  locale: Locale;
}

const DELIVERABLES = {
  en: [
    'Complete NEXUS LAKE v6.0 GPU 100K-Row OLAP & Daylight Analytics Studio (Python 3.12 FastAPI + DuckDB-WASM + Live Medallion CDC + Data Quality Contracts)',
    'Production MCP Lakehouse Server (stdio + Streamable HTTP) + Dual-Layer Read-Only SQL Guardrail',
    'Custom Parquet / S3 / PostgreSQL / SQL Server CDC Connector Setup & Docker VPC Hardening',
    '90-Day Direct Solution Architect SLA Support (Truong Van Tinh · TVT Studio)',
  ],
  vi: [
    'Bàn giao trọn bộ mã nguồn NEXUS LAKE v6.0 Full-Stack (GPU 100K OLAP + Python 3.12 FastAPI + DuckDB-WASM + Live Medallion CDC + dbt-test)',
    'MCP Lakehouse Server chuẩn doanh nghiệp (stdio + Streamable HTTP) kèm tường lửa SQL AST 2 lớp',
    'Tích hợp kết nối Parquet / S3 / PostgreSQL / SQL Server CDC & triển khai Docker VPC bảo mật',
    '90 ngày đồng hành SLA trực tiếp cùng Solution Architect (Trương Văn Tình · TVT Studio)',
  ],
};

export const EnterpriseLicenseModal: React.FC<EnterpriseLicenseModalProps> = ({
  open,
  onClose,
  copy,
  locale,
}) => {
  const [companyMemo, setCompanyMemo] = useState<string>(ENTERPRISE_LICENSE_BANK.defaultMemo);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [qrError, setQrError] = useState<boolean>(false);

  const vietQrUrl = useMemo(() => buildEnterpriseVietQrUrl(companyMemo), [companyMemo]);

  if (!open) return null;

  const copyText = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 1800);
    } catch {
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 1800);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[3px] flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="enterprise-license-heading"
    >
      <div
        data-testid="enterprise-license-modal"
        className="w-full max-w-3xl nexus-panel rounded-lg overflow-hidden my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-4 py-3 nexus-hairline-b bg-[var(--bg-surface)] flex items-start justify-between gap-3">
          <div className="space-y-0.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[var(--accent-signal)] shrink-0" />
              <h2
                id="enterprise-license-heading"
                className="font-display font-bold text-sm sm:text-base tracking-tight text-[var(--text-primary)] m-0"
              >
                {copy.enterpriseModalTitle}
              </h2>
              <span className="font-mono-tech text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--accent-signal-soft)] text-[var(--accent-signal)] border border-[var(--accent-signal)]/35 font-semibold">
                TVT STUDIO FLAGSHIP
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] m-0">{copy.enterpriseModalSubtitle}</p>
          </div>

          <button
            type="button"
            data-testid="close-license-modal-btn"
            aria-label="Close enterprise license modal"
            onClick={onClose}
            className="p-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 grid grid-cols-1 md:grid-cols-12 gap-4 bg-[var(--bg-inset)]">
          {/* Left Column: Live MBBank VietQR */}
          <div className="md:col-span-5 flex flex-col items-center justify-between p-3.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] space-y-3">
            <div className="w-full flex items-center justify-between font-mono-tech text-[10px]">
              <span className="flex items-center gap-1.5 text-[var(--accent-cyan)] font-semibold">
                <QrCode className="w-3.5 h-3.5" />
                VIETQR 24/7 INSTANT
              </span>
              <span className="text-[var(--accent-emerald)] font-semibold">MBBANK · 970422</span>
            </div>

            <div className="w-full max-w-[236px] aspect-square rounded-md bg-white p-2 flex items-center justify-center border border-[var(--border-hairline)] overflow-hidden">
              {!qrError ? (
                <img
                  src={vietQrUrl}
                  alt="MBBank VietQR 14.900.000 VND - TRUONG VAN TINH - 0325456574"
                  data-testid="vietqr-image"
                  onError={() => setQrError(true)}
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="text-center p-3 text-slate-700 space-y-1">
                  <QrCode className="w-10 h-10 mx-auto text-slate-400" />
                  <p className="font-mono-tech text-[10px] font-semibold">MBBank (970422)</p>
                  <p className="font-mono-tech text-xs font-bold">0325456574</p>
                  <p className="font-mono-tech text-[10px]">14.900.000 VND</p>
                </div>
              )}
            </div>

            <div className="w-full text-center space-y-0.5">
              <div className="font-display font-bold text-lg text-[var(--accent-signal)] tabular-nums">
                {ENTERPRISE_LICENSE_BANK.amountFormatted}
              </div>
              <p className="font-mono-tech text-[9.5px] text-[var(--text-muted)] m-0">
                {locale === 'vi'
                  ? 'Thanh toán một lần · Sở hữu vĩnh viễn mã nguồn'
                  : 'One-time commissioning · Perpetual enterprise license'}
              </p>
            </div>
          </div>

          {/* Right Column: Bank Transfer Details + Deliverables */}
          <div className="md:col-span-7 flex flex-col justify-between space-y-3">
            {/* Bank Info Rows with 1-click Copy */}
            <div className="p-3 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] space-y-2">
              <div className="flex items-center gap-1.5 font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                <Building2 className="w-3 h-3 text-[var(--accent-cyan)]" />
                <span>
                  {locale === 'vi' ? 'THÔNG TIN CHUYỂN KHOẢN TRỰC TIẾP' : 'DIRECT BANK TRANSFER DETAILS'}
                </span>
              </div>

              {(
                [
                  {
                    key: 'bank',
                    label: locale === 'vi' ? 'Ngân hàng' : 'Bank',
                    value: `${ENTERPRISE_LICENSE_BANK.bankShort} (BIN ${ENTERPRISE_LICENSE_BANK.bankBin})`,
                    copyVal: ENTERPRISE_LICENSE_BANK.bankBin,
                  },
                  {
                    key: 'account',
                    label: locale === 'vi' ? 'Số tài khoản' : 'Account No.',
                    value: ENTERPRISE_LICENSE_BANK.accountNumber,
                    copyVal: ENTERPRISE_LICENSE_BANK.accountNumber,
                    highlight: true,
                  },
                  {
                    key: 'holder',
                    label: locale === 'vi' ? 'Chủ tài khoản' : 'Account Holder',
                    value: ENTERPRISE_LICENSE_BANK.accountHolder,
                    copyVal: ENTERPRISE_LICENSE_BANK.accountHolder,
                  },
                  {
                    key: 'amount',
                    label: locale === 'vi' ? 'Số tiền' : 'Amount',
                    value: ENTERPRISE_LICENSE_BANK.amountFormatted,
                    copyVal: String(ENTERPRISE_LICENSE_BANK.amountVnd),
                  },
                ] as const
              ).map((item) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[11px]"
                >
                  <span className="text-[var(--text-muted)] text-[10px]">{item.label}</span>
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        'highlight' in item && item.highlight
                          ? 'font-bold text-[var(--accent-cyan)]'
                          : 'font-semibold text-[var(--text-primary)]'
                      }
                    >
                      {item.value}
                    </span>
                    <button
                      type="button"
                      data-testid={`copy-${item.key}-btn`}
                      onClick={() => void copyText(item.key, item.copyVal)}
                      className="p-1 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                      title={`Copy ${item.label}`}
                    >
                      {copiedField === item.key ? (
                        <Check className="w-3 h-3 text-[var(--accent-emerald)]" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                </div>
              ))}

              {/* Editable Transfer Reference Memo */}
              <div className="space-y-1 pt-1">
                <label className="block font-mono-tech text-[9.5px] uppercase text-[var(--text-muted)]">
                  {locale === 'vi'
                    ? 'Nội dung chuyển khoản (Tự động cập nhật mã QR)'
                    : 'Transfer Reference Memo (Live VietQR Sync)'}
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    data-testid="license-memo-input"
                    value={companyMemo}
                    onChange={(e) => {
                      setQrError(false);
                      setCompanyMemo(e.target.value);
                    }}
                    maxLength={50}
                    className="flex-1 px-2.5 py-1 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] focus:border-[var(--accent-cyan)] focus:outline-none font-mono-tech text-[11px] text-[var(--text-primary)]"
                  />
                  <button
                    type="button"
                    onClick={() => void copyText('memo', companyMemo)}
                    className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--accent-cyan)] font-mono-tech text-[10px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
                  >
                    {copiedField === 'memo' ? (
                      <Check className="w-3 h-3 text-[var(--accent-emerald)]" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    <span>{copiedField === 'memo' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Commissioning Deliverables */}
            <div className="p-3 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] space-y-1.5">
              <p className="font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] m-0">
                {locale === 'vi' ? 'GÓI BÀN GIAO DOANH NGHIỆP' : 'ENTERPRISE COMMISSIONING PACKAGE'}
              </p>
              <ul className="m-0 p-0 list-none space-y-1">
                {DELIVERABLES[locale].map((line) => (
                  <li
                    key={line}
                    className="flex items-start gap-2 text-[11px] text-[var(--text-secondary)] leading-snug"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent-emerald)] shrink-0 mt-0.5" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Architect Contact Footer */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] font-mono-tech text-[10px] text-[var(--text-muted)]">
              <span className="flex items-center gap-1.5">
                <Mail className="w-3 h-3 text-[var(--accent-cyan)]" />
                tinhkun102@gmail.com
              </span>
              <span className="flex items-center gap-1.5">
                <Phone className="w-3 h-3 text-[var(--accent-emerald)]" />
                0931 467 024
              </span>
              <span className="text-[var(--text-primary)] font-semibold">TVT STUDIO · HCMC</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
