import { describe, expect, it } from 'vitest';
import {
  isReadOnlySafeSql,
  NL_TO_SQL_PRESETS,
  translateNlToSql,
} from '../engines/nlToSqlEngine';
import type { TableSchemaInfo } from '../types/lakehouse';

describe('v3.0 Offline VI/EN Natural-Language-to-SQL Compiler', () => {
  it('compiles "Top 10 products by gross margin" to vn_retail_pos_50k with LIMIT 10', () => {
    const res = translateNlToSql('Top 10 products by gross margin');
    expect(res.intent).toBe('top_products_gross_margin');
    expect(res.targetTable).toBe('vn_retail_pos_50k');
    expect(res.requiredSampleDataset).toBe('vn_retail_pos_50k');
    expect(res.sql).toContain('gross_margin_vnd');
    expect(res.sql).toContain('LIMIT 10');
    expect(isReadOnlySafeSql(res.sql)).toBe(true);
  });

  it('compiles Vietnamese prompt with diacritics and dynamic top-N extraction', () => {
    const res = translateNlToSql('Top 5 sản phẩm biên lợi nhuận cao nhất');
    expect(res.intent).toBe('top_products_gross_margin');
    expect(res.sql).toContain('LIMIT 5');
    expect(isReadOnlySafeSql(res.sql)).toBe(true);
  });

  it('compiles "Monthly revenue MoM growth" into DuckDB LAG() window SQL', () => {
    const res = translateNlToSql('Monthly revenue MoM growth');
    expect(res.intent).toBe('monthly_revenue_mom_growth');
    expect(res.requiredSampleDataset).toBe('vn_retail_pos_50k');
    expect(res.sql).toContain('LAG(revenue_vnd)');
    expect(res.sql).toContain('mom_growth_pct');
    expect(isReadOnlySafeSql(res.sql)).toBe(true);
  });

  it('compiles "Churned enterprise accounts > 50M VND" with exact 50000000 threshold', () => {
    const res = translateNlToSql('Churned enterprise accounts > 50M VND');
    expect(res.intent).toBe('churned_enterprise_accounts');
    expect(res.requiredSampleDataset).toBe('saas_mrr_cohorts');
    expect(res.sql).toContain("segment = 'Enterprise'");
    expect(res.sql).toContain('is_churned = true');
    expect(res.sql).toContain('mrr_vnd > 50000000');
  });

  it('extracts custom Vietnamese VND thresholds (e.g. > 80 triệu VND -> 80000000)', () => {
    const res = translateNlToSql('Tài khoản doanh nghiệp rời bỏ > 80 triệu VND');
    expect(res.intent).toBe('churned_enterprise_accounts');
    expect(res.sql).toContain('mrr_vnd > 80000000');
  });

  it('compiles freight carrier SLA delay questions onto supply_chain_freight', () => {
    const res = translateNlToSql('Phân tích độ trễ SLA theo nhà vận chuyển');
    expect(res.intent).toBe('freight_carrier_sla');
    expect(res.requiredSampleDataset).toBe('supply_chain_freight');
    expect(res.sql).toContain('FROM supply_chain_freight');
  });

  it('compiles dynamic schema-aware aggregation against custom uploaded tables', () => {
    const customTables: TableSchemaInfo[] = [
      {
        name: 'custom_merchants',
        rowCount: 120,
        source: 'uploaded',
        columns: [
          { name: 'tier', type: 'VARCHAR' },
          { name: 'monthly_gmv', type: 'DOUBLE' },
        ],
      },
    ];
    const res = translateNlToSql('Top 7 rows in custom_merchants', customTables);
    expect(res.intent).toBe('custom_table_aggregation');
    expect(res.targetTable).toBe('custom_merchants');
    expect(res.sql).toContain('FROM "custom_merchants"');
    expect(res.sql).toContain('GROUP BY tier');
    expect(res.sql).toContain('LIMIT 7');
  });

  it('verifies every EN & VI enterprise preset compiles cleanly and passes read-only guardrail', () => {
    expect(NL_TO_SQL_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const preset of NL_TO_SQL_PRESETS) {
      const en = translateNlToSql(preset.promptEn);
      const vi = translateNlToSql(preset.promptVi);
      expect(isReadOnlySafeSql(en.sql)).toBe(true);
      expect(isReadOnlySafeSql(vi.sql)).toBe(true);
      expect(en.confidence).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('blocks destructive DDL/DML SQL statements via read-only guardrail', () => {
    expect(isReadOnlySafeSql('SELECT * FROM transactions LIMIT 10;')).toBe(true);
    expect(isReadOnlySafeSql('WITH t AS (SELECT 1) SELECT * FROM t;')).toBe(true);
    expect(isReadOnlySafeSql('DROP TABLE transactions;')).toBe(false);
    expect(isReadOnlySafeSql('DELETE FROM transactions WHERE 1=1;')).toBe(false);
    expect(isReadOnlySafeSql('SELECT * FROM transactions; INSERT INTO x VALUES (1);')).toBe(false);
    expect(isReadOnlySafeSql('UPDATE transactions SET risk_score = 0;')).toBe(false);
  });
});
