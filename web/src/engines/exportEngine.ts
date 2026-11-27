export const UTF8_BOM = '\uFEFF';

export const ENTERPRISE_LICENSE_BANK = {
  bankBin: '970422',
  bankName: 'MBBank (Military Commercial Joint Stock Bank)',
  bankShort: 'MBBank',
  accountNumber: '0325456574',
  accountHolder: 'TRUONG VAN TINH',
  amountVnd: 14_900_000,
  amountFormatted: '14.900.000 VND',
  defaultMemo: 'NEXUS LAKE V3 ENTERPRISE',
  template: 'compact2',
} as const;

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  let str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  // Mitigate spreadsheet CSV formula injection on string cells
  if (/^[=+@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serializes query results into RFC-4180 CSV with UTF-8 BOM (\uFEFF)
 * so Vietnamese diacritics open cleanly in Microsoft Excel and BI tools.
 */
export function serializeRowsToCsvBom(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  if (columns.length === 0) return UTF8_BOM;
  const headerLine = columns.map((c) => escapeCsvCell(c)).join(',');
  const bodyLines = rows.map((row) =>
    columns.map((col) => escapeCsvCell(row[col])).join(','),
  );
  return `${UTF8_BOM}${[headerLine, ...bodyLines].join('\r\n')}`;
}

/**
 * Serializes query results into clean UTF-8 pretty JSON.
 */
export function serializeRowsToJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * Builds the live VietQR compact2 image URL for MBBank (970422) commissioning.
 */
export function buildEnterpriseVietQrUrl(memoOverride?: string): string {
  const cleanMemo = (memoOverride?.trim() || ENTERPRISE_LICENSE_BANK.defaultMemo)
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .slice(0, 50)
    .trim() || ENTERPRISE_LICENSE_BANK.defaultMemo;

  const params = new URLSearchParams({
    amount: String(ENTERPRISE_LICENSE_BANK.amountVnd),
    addInfo: cleanMemo,
    accountName: ENTERPRISE_LICENSE_BANK.accountHolder,
  });

  return `https://img.vietqr.io/image/${ENTERPRISE_LICENSE_BANK.bankBin}-${ENTERPRISE_LICENSE_BANK.accountNumber}-${ENTERPRISE_LICENSE_BANK.template}.png?${params.toString()}`;
}

export function triggerBrowserDownload(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
