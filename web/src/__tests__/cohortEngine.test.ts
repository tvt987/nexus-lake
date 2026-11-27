import { describe, expect, it } from 'vitest';
import { buildCohortDrilldownSql, buildCohortHeatmapModel } from '../engines/cohortEngine';
import { isReadOnlySafeSql } from '../engines/nlToSqlEngine';

describe('v3.0 Live Cohort Retention & Revenue Expansion Engine', () => {
  it('builds a triangular Monthly M0-M6 cohort heatmap with 100% M0 logo retention', () => {
    const model = buildCohortHeatmapModel('monthly', 'ALL');
    expect(model.granularity).toBe('monthly');
    expect(model.periods).toEqual(['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
    expect(model.rows.length).toBe(7);

    // Triangular shape: first cohort has 7 periods, last cohort has 1 period
    expect(model.rows[0].cells.filter(Boolean).length).toBe(7);
    expect(model.rows[6].cells.filter(Boolean).length).toBe(1);

    for (const row of model.rows) {
      expect(row.cells[0]?.retentionPct).toBe(100);
      expect(row.cells[0]?.activeAccounts).toBe(row.cohortSize);
    }
  });

  it('switches cleanly to Weekly W0-W6 cohort granularity with ISO week labels', () => {
    const model = buildCohortHeatmapModel('weekly', 'ALL');
    expect(model.periods).toEqual(['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6']);
    expect(model.rows[0].cohortLabel).toMatch(/^2026-W\d{2}$/);
    expect(model.summary.totalAccounts).toBeGreaterThan(0);
  });

  it('filters cohorts by segment and demonstrates higher Enterprise NRR expansion than Growth', () => {
    const enterprise = buildCohortHeatmapModel('monthly', 'Enterprise');
    const growth = buildCohortHeatmapModel('monthly', 'Growth');

    expect(enterprise.summary.totalAccounts).toBeGreaterThan(0);
    expect(growth.summary.totalAccounts).toBeGreaterThan(0);
    expect(enterprise.summary.avgLatestNrrPct).toBeGreaterThan(growth.summary.avgLatestNrrPct);
    expect(enterprise.summary.totalExpansionMrrVnd).toBeGreaterThan(0);
  });

  it('maintains conservation invariant activeAccounts + churnedAccounts === cohortSize', () => {
    const model = buildCohortHeatmapModel('monthly', 'Mid-Market');
    for (const row of model.rows) {
      for (const cell of row.cells) {
        if (!cell) continue;
        expect(cell.activeAccounts + cell.churnedAccounts).toBe(row.cohortSize);
        expect(cell.retentionPct).toBeGreaterThanOrEqual(0);
        expect(cell.retentionPct).toBeLessThanOrEqual(100);
      }
    }
  });

  it('computes non-zero executive summary KPIs across cohorts', () => {
    const model = buildCohortHeatmapModel('monthly', 'ALL');
    expect(model.summary.avgM3RetentionPct).toBeGreaterThan(50);
    expect(model.summary.avgLatestNrrPct).toBeGreaterThan(60);
    expect(model.summary.totalExpansionMrrVnd).toBeGreaterThan(0);
    expect(model.summary.churnedMrrAtRiskVnd).toBeGreaterThan(0);
  });

  it('builds read-only safe drilldown SQL for monthly and weekly cohorts', () => {
    const monthlySql = buildCohortDrilldownSql('2026-02', 'Enterprise');
    expect(isReadOnlySafeSql(monthlySql)).toBe(true);
    expect(monthlySql).toContain("signup_cohort = '2026-02'");
    expect(monthlySql).toContain("segment = 'Enterprise'");

    const weeklySql = buildCohortDrilldownSql('2026-W40', 'ALL');
    expect(isReadOnlySafeSql(weeklySql)).toBe(true);
    expect(weeklySql).toContain("signup_cohort = '2026-03'");
    expect(weeklySql).not.toContain('AND segment =');
  });

  it('accepts custom source cohort rows directly', () => {
    const customRows = [
      { signup_cohort: '2026-01', period_index: 0, segment: 'Enterprise', is_active: true, mrr_vnd: 100_000_000, expansion_vnd: 0, net_mrr_vnd: 100_000_000 },
      { signup_cohort: '2026-01', period_index: 1, segment: 'Enterprise', is_active: true, mrr_vnd: 100_000_000, expansion_vnd: 25_000_000, net_mrr_vnd: 125_000_000 },
    ];
    const model = buildCohortHeatmapModel('monthly', 'Enterprise', customRows);
    expect(model.rows.length).toBe(1);
    expect(model.rows[0].cells[1]?.nrrPct).toBe(125);
    expect(model.rows[0].cells[1]?.expansionVnd).toBe(25_000_000);
  });
});
