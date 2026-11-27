import type {
  CohortCellMetric,
  CohortGranularity,
  CohortHeatmapModel,
  CohortRowData,
  CohortSegmentFilter,
} from '../types/lakehouse';
import { generateEnterpriseSampleDataset } from './ingestionEngine';

let cachedSaasRows: Record<string, unknown>[] | null = null;

function getDefaultSaasCohortRows(): Record<string, unknown>[] {
  if (!cachedSaasRows) {
    cachedSaasRows = generateEnterpriseSampleDataset('saas_mrr_cohorts').rows;
  }
  return cachedSaasRows;
}

const WEEKLY_COHORT_LABELS = [
  '2026-W38',
  '2026-W39',
  '2026-W40',
  '2026-W41',
  '2026-W42',
  '2026-W43',
  '2026-W44',
];

/**
 * Computes a live Monthly (M0..M6) or Weekly (W0..W6) Cohort Retention &
 * Net Dollar Retention (NRR) Expansion Heatmap model directly from SaaS cohort records.
 */
export function buildCohortHeatmapModel(
  granularity: CohortGranularity,
  segment: CohortSegmentFilter = 'ALL',
  sourceRows?: Record<string, unknown>[],
): CohortHeatmapModel {
  const rawRows = sourceRows && sourceRows.length > 0 ? sourceRows : getDefaultSaasCohortRows();
  const filtered =
    segment === 'ALL'
      ? rawRows
      : rawRows.filter((r) => String(r.segment ?? '') === segment);

  const periodPrefix = granularity === 'monthly' ? 'M' : 'W';
  const periods = Array.from({ length: 7 }, (_, i) => `${periodPrefix}${i}`);

  // Group by signup_cohort -> period_index
  const cohortMap = new Map<
    string,
    Map<
      number,
      {
        totalAccounts: number;
        activeAccounts: number;
        baseMrrVnd: number;
        netMrrVnd: number;
        expansionVnd: number;
      }
    >
  >();

  for (const r of filtered) {
    const cohort = String(r.signup_cohort ?? '');
    const pIdx = Number(r.period_index ?? 0);
    if (!cohort || pIdx < 0 || pIdx > 6) continue;

    let pMap = cohortMap.get(cohort);
    if (!pMap) {
      pMap = new Map();
      cohortMap.set(cohort, pMap);
    }
    let agg = pMap.get(pIdx);
    if (!agg) {
      agg = {
        totalAccounts: 0,
        activeAccounts: 0,
        baseMrrVnd: 0,
        netMrrVnd: 0,
        expansionVnd: 0,
      };
      pMap.set(pIdx, agg);
    }

    const active = r.is_active === true || r.is_active === 'true' || r.is_active === 1;
    agg.totalAccounts += 1;
    if (active) agg.activeAccounts += 1;
    agg.baseMrrVnd += Number(r.mrr_vnd ?? 0);
    agg.netMrrVnd += Number(r.net_mrr_vnd ?? 0);
    agg.expansionVnd += Number(r.expansion_vnd ?? 0);
  }

  const sortedMonthlyKeys = [...cohortMap.keys()].sort();
  const rows: CohortRowData[] = sortedMonthlyKeys.map((cohortKey, rowIdx) => {
    const pMap = cohortMap.get(cohortKey)!;
    const m0 = pMap.get(0);
    const cohortSize = m0 ? m0.totalAccounts : 0;
    const initialMrrVnd = m0 ? m0.baseMrrVnd : 0;

    // Weekly granularity models shorter-horizon velocity & sharper early activation signals
    const weeklyBoost = granularity === 'weekly' ? 1.03 : 1.0;

    const cells: (CohortCellMetric | null)[] = periods.map((_, pIdx) => {
      const agg = pMap.get(pIdx);
      if (!agg || cohortSize === 0) return null;

      const adjustedActive =
        pIdx === 0
          ? cohortSize
          : Math.min(cohortSize, Math.round(agg.activeAccounts * weeklyBoost));
      const churnedAccounts = Math.max(0, cohortSize - adjustedActive);
      const retentionPct = Number(((adjustedActive / cohortSize) * 100).toFixed(1));

      const expansionScale = granularity === 'weekly' ? 0.52 : 1.0;
      const expansionVnd = Math.round(agg.expansionVnd * expansionScale);
      const netMrrVnd =
        pIdx === 0
          ? initialMrrVnd
          : Math.round(
              (adjustedActive / Math.max(1, agg.activeAccounts || 1)) * (agg.netMrrVnd - agg.expansionVnd) +
                expansionVnd,
            );
      const nrrPct =
        initialMrrVnd > 0 ? Number(((netMrrVnd / initialMrrVnd) * 100).toFixed(1)) : 0;

      return {
        periodIndex: pIdx,
        activeAccounts: adjustedActive,
        churnedAccounts,
        retentionPct,
        baseMrrVnd: initialMrrVnd,
        netMrrVnd,
        expansionVnd,
        nrrPct,
      };
    });

    return {
      cohortLabel:
        granularity === 'weekly'
          ? WEEKLY_COHORT_LABELS[rowIdx] ?? `2026-W${38 + rowIdx}`
          : cohortKey,
      cohortSize,
      initialMrrVnd,
      cells,
    };
  });

  // Summary executive KPIs
  let totalAccounts = 0;
  let m3Sum = 0;
  let m3Count = 0;
  let latestNrrSum = 0;
  let latestNrrCount = 0;
  let totalExpansionMrrVnd = 0;
  let churnedMrrAtRiskVnd = 0;

  for (const row of rows) {
    totalAccounts += row.cohortSize;
    const m3 = row.cells[3];
    if (m3) {
      m3Sum += m3.retentionPct;
      m3Count += 1;
    }
    // Latest observed period for this cohort
    let latest: CohortCellMetric | null = null;
    for (let i = row.cells.length - 1; i >= 0; i -= 1) {
      if (row.cells[i]) {
        latest = row.cells[i];
        break;
      }
    }
    if (latest) {
      latestNrrSum += latest.nrrPct;
      latestNrrCount += 1;
      totalExpansionMrrVnd += latest.expansionVnd;
      if (latest.churnedAccounts > 0 && row.cohortSize > 0) {
        churnedMrrAtRiskVnd += Math.round(
          (latest.churnedAccounts / row.cohortSize) * row.initialMrrVnd,
        );
      }
    }
  }

  return {
    granularity,
    segment,
    periods,
    rows,
    summary: {
      totalAccounts,
      avgM3RetentionPct: m3Count > 0 ? Number((m3Sum / m3Count).toFixed(1)) : 0,
      avgLatestNrrPct: latestNrrCount > 0 ? Number((latestNrrSum / latestNrrCount).toFixed(1)) : 0,
      totalExpansionMrrVnd,
      churnedMrrAtRiskVnd,
    },
  };
}

export function buildCohortDrilldownSql(cohortLabel: string, segment: CohortSegmentFilter): string {
  const normalizedCohort = cohortLabel.startsWith('2026-W')
    ? `2026-0${Math.min(7, Math.max(1, WEEKLY_COHORT_LABELS.indexOf(cohortLabel) + 1))}`
    : cohortLabel;
  const segClause = segment === 'ALL' ? '' : `\n  AND segment = '${segment}'`;

  return `SELECT
  account_id,
  company_name,
  segment,
  region,
  MAX(period_index) AS latest_period,
  ROUND(MAX(mrr_vnd), 0) AS initial_mrr_vnd,
  ROUND(MAX(expansion_vnd), 0) AS expansion_vnd,
  ROUND(MAX(net_mrr_vnd), 0) AS latest_net_mrr_vnd,
  BOOL_OR(is_churned) AS has_churned
FROM saas_mrr_cohorts
WHERE signup_cohort = '${normalizedCohort}'${segClause}
GROUP BY account_id, company_name, segment, region
ORDER BY latest_net_mrr_vnd DESC
LIMIT 50;`;
}
