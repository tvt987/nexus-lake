import { describe, expect, it } from 'vitest';
import {
  buildEnterpriseVietQrUrl,
  ENTERPRISE_LICENSE_BANK,
  serializeRowsToCsvBom,
  serializeRowsToJson,
  UTF8_BOM,
} from '../engines/exportEngine';

describe('v3.0 UTF-8 BOM Export Pipeline & MBBank VietQR Builder', () => {
  it('prepends exact UTF-8 BOM and preserves Vietnamese diacritics in CSV export', () => {
    const csv = serializeRowsToCsvBom(
      ['city', 'revenue_vnd'],
      [{ city: 'TP. Hồ Chí Minh', revenue_vnd: 14_900_000 }],
    );
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('TP. Hồ Chí Minh,14900000');
  });

  it('escapes RFC-4180 commas, double quotes, and multiline strings properly', () => {
    const csv = serializeRowsToCsvBom(
      ['product', 'note'],
      [{ product: 'Aptamil, "Gold"', note: 'Line1\nLine2' }],
    );
    expect(csv).toContain('"Aptamil, ""Gold""","Line1\nLine2"');
  });

  it('neutralizes CSV formula injection while keeping negative numbers intact', () => {
    const csv = serializeRowsToCsvBom(
      ['formula', 'delta'],
      [{ formula: '=HYPERLINK("http://evil")', delta: -12.5 }],
    );
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain(',-12.5');
  });

  it('serializes rows to valid pretty-printed JSON', () => {
    const json = serializeRowsToJson([{ region: 'APAC-VN', amount: 420 }]);
    const parsed = JSON.parse(json) as { region: string; amount: number }[];
    expect(parsed[0]).toEqual({ region: 'APAC-VN', amount: 420 });
  });

  it('builds verified MBBank (970422) VietQR URL for 14.900.000 VND to TRUONG VAN TINH (0325456574)', () => {
    const url = buildEnterpriseVietQrUrl();
    expect(ENTERPRISE_LICENSE_BANK.bankBin).toBe('970422');
    expect(ENTERPRISE_LICENSE_BANK.accountNumber).toBe('0325456574');
    expect(ENTERPRISE_LICENSE_BANK.accountHolder).toBe('TRUONG VAN TINH');
    expect(ENTERPRISE_LICENSE_BANK.amountVnd).toBe(14_900_000);

    expect(url).toContain('https://img.vietqr.io/image/970422-0325456574-compact2.png?');
    expect(url).toContain('amount=14900000');
    expect(url).toContain('accountName=TRUONG+VAN+TINH');
  });

  it('sanitizes custom transfer memos and falls back safely on empty memo', () => {
    const custom = buildEnterpriseVietQrUrl('ACME CORP <script>alert(1)</script>');
    expect(custom).not.toContain('<script>');
    expect(custom).toContain('ACME+CORP');

    const fallback = buildEnterpriseVietQrUrl('   ');
    expect(fallback).toContain('NEXUS+LAKE+V3+ENTERPRISE');
  });
});
