import { describe, expect, it } from 'vitest';
import {
  applyChaosFault,
  CHAOS_INJECTOR_CATALOG,
  CLEAN_CHAOS_STATE,
  createCleanChaosState,
  evaluateDataQualityContracts,
  filterQualityAssertions,
  formatAssertionStatusBadge,
  generateDbtSchemaYaml,
  getActiveChaosIds,
  isChaosFaultActive,
  toggleChaosFault,
} from '../engines/dataQualityEngine';

describe('v5.0 Data Quality & Freshness SLA Contract Engine (dbt-test / Great Expectations)', () => {
  it('evaluates clean baseline to 100.0% Data Trust Score with 0 quarantined rows and 0 SLA breaches', () => {
    const report = evaluateDataQualityContracts(100_000, CLEAN_CHAOS_STATE, '2026-11-28T00:00:00.000Z');
    expect(report.dataTrustScore).toBe(100);
    expect(report.overallStatus).toBe('HEALTHY');
    expect(report.totalRules).toBe(12);
    expect(report.passedRules).toBe(12);
    expect(report.warnRules).toBe(0);
    expect(report.failedRules).toBe(0);
    expect(report.totalQuarantinedRows).toBe(0);
    expect(report.slaBreachCount).toBe(0);
    expect(report.activeChaosIds).toEqual([]);
  });

  it('covers all 5 required assertion types across bronze_orders, silver_vouchers, and gold_store_kpis', () => {
    const report = evaluateDataQualityContracts(100_000, CLEAN_CHAOS_STATE);
    const ruleTypes = new Set(report.assertions.map((a) => a.ruleType));
    expect(ruleTypes).toEqual(
      new Set([
        'not_null',
        'unique',
        'accepted_range',
        'referential_integrity',
        'freshness_sla_minutes',
      ]),
    );
    const tables = new Set(report.assertions.map((a) => a.table));
    expect(tables).toEqual(new Set(['bronze_orders', 'silver_vouchers', 'gold_store_kpis']));
  });

  it('produces 3 Medallion table summaries ordered Bronze -> Silver -> Gold', () => {
    const report = evaluateDataQualityContracts(100_000, CLEAN_CHAOS_STATE);
    expect(report.tableSummaries.map((t) => t.table)).toEqual([
      'bronze_orders',
      'silver_vouchers',
      'gold_store_kpis',
    ]);
    expect(report.tableSummaries.map((t) => t.layer)).toEqual(['bronze', 'silver', 'gold']);
    expect(report.tableSummaries[0].rowCount).toBe(100_000);
    expect(report.tableSummaries[1].rowCount).toBe(32_400);
    expect(report.tableSummaries[2].rowCount).toBe(720);
  });

  it('inject_null_store_id (1.8%) drops Data Trust Score, fails not_null, and cascades Gold FK failure', () => {
    const chaos = applyChaosFault(createCleanChaosState(), 'null_store_id');
    const report = evaluateDataQualityContracts(100_000, chaos);

    expect(report.dataTrustScore).toBeLessThan(85);
    expect(report.overallStatus).toBe('CRITICAL');
    expect(report.failedRules).toBe(2);
    expect(report.activeChaosIds).toEqual(['null_store_id']);

    const storeNullRule = report.assertions.find(
      (a) => a.ruleId === 'dq-bronze-orders-store-id-not-null',
    );
    const storeFkRule = report.assertions.find((a) => a.ruleId === 'dq-gold-store-kpis-store-fk');
    expect(storeNullRule?.status).toBe('CRITICAL_FAIL');
    expect(storeNullRule?.quarantinedRows).toBe(1800);
    expect(storeFkRule?.status).toBe('CRITICAL_FAIL');
    expect(storeFkRule?.quarantinedRows).toBe(216);
    expect(report.totalQuarantinedRows).toBe(2016);
  });

  it('inject_duplicate_vouchers fails unique(redemption_key) and discount_pct accepted_range', () => {
    const chaos = applyChaosFault(createCleanChaosState(), 'duplicate_vouchers');
    const report = evaluateDataQualityContracts(100_000, chaos);

    expect(report.dataTrustScore).toBeLessThan(85);
    expect(report.overallStatus).toBe('CRITICAL');
    expect(report.activeChaosIds).toEqual(['duplicate_vouchers']);

    const uniqueRule = report.assertions.find(
      (a) => a.ruleId === 'dq-silver-vouchers-redemption-unique',
    );
    const rangeRule = report.assertions.find(
      (a) => a.ruleId === 'dq-silver-vouchers-discount-range',
    );
    expect(uniqueRule?.status).toBe('CRITICAL_FAIL');
    expect(uniqueRule?.quarantinedRows).toBe(412);
    expect(rangeRule?.status).toBe('CRITICAL_FAIL');
    expect(rangeRule?.quarantinedRows).toBe(38);
    expect(report.totalQuarantinedRows).toBe(450);
  });

  it('simulate_45m_kafka_cdc_lag breaches all 3 Medallion freshness SLAs', () => {
    const chaos = applyChaosFault(createCleanChaosState(), 'kafka_cdc_lag');
    const report = evaluateDataQualityContracts(100_000, chaos);

    expect(report.slaBreachCount).toBe(3);
    expect(report.overallStatus).toBe('CRITICAL');
    expect(report.dataTrustScore).toBeLessThan(80);
    expect(report.slaBreaches.map((b) => b.table)).toEqual([
      'bronze_orders',
      'silver_vouchers',
      'gold_store_kpis',
    ]);
    for (const breach of report.slaBreaches) {
      expect(breach.observedLagMinutes).toBeGreaterThanOrEqual(48);
      expect(breach.excessMinutes).toBeGreaterThan(30);
    }
  });

  it('stacking all 3 chaos faults cumulatively reduces trust score and elevates quarantine count', () => {
    let chaos = createCleanChaosState();
    chaos = applyChaosFault(chaos, 'null_store_id');
    const afterOne = evaluateDataQualityContracts(100_000, chaos);

    chaos = applyChaosFault(chaos, 'duplicate_vouchers');
    const afterTwo = evaluateDataQualityContracts(100_000, chaos);

    chaos = applyChaosFault(chaos, 'kafka_cdc_lag');
    const afterThree = evaluateDataQualityContracts(100_000, chaos);

    expect(afterTwo.dataTrustScore).toBeLessThan(afterOne.dataTrustScore);
    expect(afterThree.dataTrustScore).toBeLessThan(afterTwo.dataTrustScore);
    expect(afterThree.dataTrustScore).toBeLessThan(40);
    expect(afterThree.activeChaosIds).toEqual([
      'null_store_id',
      'duplicate_vouchers',
      'kafka_cdc_lag',
    ]);
    expect(afterThree.failedRules).toBeGreaterThanOrEqual(7);
    expect(afterThree.warnRules).toBe(1); // margin anomaly triggered by dual null + voucher fault
  });

  it('resetting to clean baseline restores 100.0% Data Trust Score and 0 failures', () => {
    let chaos = applyChaosFault(createCleanChaosState(), 'null_store_id');
    chaos = applyChaosFault(chaos, 'kafka_cdc_lag');
    const degraded = evaluateDataQualityContracts(100_000, chaos);
    expect(degraded.dataTrustScore).toBeLessThan(65);

    const restored = evaluateDataQualityContracts(100_000, createCleanChaosState());
    expect(restored.dataTrustScore).toBe(100);
    expect(restored.failedRules).toBe(0);
    expect(restored.warnRules).toBe(0);
    expect(restored.totalQuarantinedRows).toBe(0);
    expect(restored.slaBreachCount).toBe(0);
  });

  it('toggleChaosFault toggles each injector on and back off cleanly', () => {
    let state = createCleanChaosState();
    expect(isChaosFaultActive(state, 'null_store_id')).toBe(false);
    state = toggleChaosFault(state, 'null_store_id');
    expect(isChaosFaultActive(state, 'null_store_id')).toBe(true);
    expect(state.nullStoreIdPct).toBe(1.8);
    state = toggleChaosFault(state, 'null_store_id');
    expect(isChaosFaultActive(state, 'null_store_id')).toBe(false);
    expect(state.nullStoreIdPct).toBe(0);

    state = toggleChaosFault(state, 'duplicate_vouchers');
    expect(state.duplicateVoucherCount).toBe(412);
    state = toggleChaosFault(state, 'duplicate_vouchers');
    expect(state.duplicateVoucherCount).toBe(0);

    state = toggleChaosFault(state, 'kafka_cdc_lag');
    expect(state.kafkaCdcLagMinutes).toBe(45);
    state = toggleChaosFault(state, 'kafka_cdc_lag');
    expect(state.kafkaCdcLagMinutes).toBe(0);
  });

  it('emits WARN and DEGRADED status when minor faults sit between warn and critical thresholds', () => {
    const mildChaos = { ...createCleanChaosState(), nullStoreIdPct: 0.15 };
    const report = evaluateDataQualityContracts(100_000, mildChaos);

    const storeNullRule = report.assertions.find(
      (a) => a.ruleId === 'dq-bronze-orders-store-id-not-null',
    );
    expect(storeNullRule?.status).toBe('WARN');
    expect(report.overallStatus).toBe('DEGRADED');
    expect(report.failedRules).toBe(0);
    expect(report.warnRules).toBeGreaterThanOrEqual(1);
    expect(report.dataTrustScore).toBeGreaterThan(85);
    expect(report.dataTrustScore).toBeLessThan(100);
  });

  it('evaluates outOfRangeAmountCount and orphanFkCount custom fault counters accurately', () => {
    const customChaos = {
      ...createCleanChaosState(),
      outOfRangeAmountCount: 40,
      orphanFkCount: 15,
    };
    const report = evaluateDataQualityContracts(100_000, customChaos);
    const amtRule = report.assertions.find((a) => a.ruleId === 'dq-bronze-orders-amount-range');
    const fkRule = report.assertions.find((a) => a.ruleId === 'dq-silver-vouchers-order-fk');

    expect(amtRule?.status).toBe('CRITICAL_FAIL');
    expect(amtRule?.quarantinedRows).toBe(40);
    expect(fkRule?.status).toBe('CRITICAL_FAIL');
    expect(fkRule?.quarantinedRows).toBe(15);
    expect(report.totalQuarantinedRows).toBe(55);
  });

  it('scales quarantined row counts proportionally across 100K, 250K, and 500K lakehouse scales', () => {
    const chaos = applyChaosFault(createCleanChaosState(), 'null_store_id');
    const r100k = evaluateDataQualityContracts(100_000, chaos);
    const r250k = evaluateDataQualityContracts(250_000, chaos);
    const r500k = evaluateDataQualityContracts(500_000, chaos);

    const getNullQuar = (r: ReturnType<typeof evaluateDataQualityContracts>) =>
      r.assertions.find((a) => a.ruleId === 'dq-bronze-orders-store-id-not-null')?.quarantinedRows;

    expect(getNullQuar(r100k)).toBe(1800);
    expect(getNullQuar(r250k)).toBe(4500);
    expect(getNullQuar(r500k)).toBe(9000);
  });

  it('clamps invalid low datasetScale cleanly to minimum 100 rows without NaN', () => {
    const report = evaluateDataQualityContracts(-50, CLEAN_CHAOS_STATE);
    expect(report.tableSummaries[0].rowCount).toBe(100);
    expect(Number.isFinite(report.dataTrustScore)).toBe(true);
  });

  it('builds a 24-hour freshness & trust timeline with exact NOW live bucket synchronization', () => {
    const chaos = applyChaosFault(
      applyChaosFault(createCleanChaosState(), 'null_store_id'),
      'kafka_cdc_lag',
    );
    const report = evaluateDataQualityContracts(100_000, chaos);

    expect(report.timeline24h).toHaveLength(24);
    expect(report.timeline24h[0].hourLabel).toBe('00:00');
    expect(report.timeline24h[23].hourLabel).toBe('NOW');
    expect(report.timeline24h[23].trustScore).toBe(report.dataTrustScore);
    expect(report.timeline24h[23].slaBreached).toBe(true);
    expect(report.timeline24h[23].freshnessLagMinutes).toBeGreaterThanOrEqual(45);
    expect(report.timeline24h[22].trustScore).toBeLessThan(100);
    expect(report.timeline24h[22].trustScore).toBeGreaterThan(report.dataTrustScore);
  });

  it('clean baseline 24-hour timeline has zero SLA breaches and healthy lag across all 24 hours', () => {
    const report = evaluateDataQualityContracts(100_000, CLEAN_CHAOS_STATE);
    expect(report.timeline24h.every((p) => !p.slaBreached)).toBe(true);
    expect(report.timeline24h.every((p) => p.freshnessLagMinutes < 10)).toBe(true);
    expect(report.timeline24h[23].trustScore).toBe(100);
  });

  it('filters assertions accurately by table and status independently and together', () => {
    const chaos = applyChaosFault(createCleanChaosState(), 'duplicate_vouchers');
    const report = evaluateDataQualityContracts(100_000, chaos);

    const onlySilver = filterQualityAssertions(report.assertions, 'silver_vouchers', 'ALL');
    expect(onlySilver).toHaveLength(4);
    expect(onlySilver.every((a) => a.table === 'silver_vouchers')).toBe(true);

    const onlyFailed = filterQualityAssertions(report.assertions, 'ALL', 'CRITICAL_FAIL');
    expect(onlyFailed).toHaveLength(2);
    expect(onlyFailed.every((a) => a.status === 'CRITICAL_FAIL')).toBe(true);

    const silverFailed = filterQualityAssertions(
      report.assertions,
      'silver_vouchers',
      'CRITICAL_FAIL',
    );
    expect(silverFailed).toHaveLength(2);

    const goldFailed = filterQualityAssertions(
      report.assertions,
      'gold_store_kpis',
      'CRITICAL_FAIL',
    );
    expect(goldFailed).toHaveLength(0);
  });

  it('generates valid dbt v2 schema.yml with sources, freshness SLA, and model column tests', () => {
    const yaml = generateDbtSchemaYaml({
      dataTrustScore: 71.4,
      totalQuarantinedRows: 2212,
      evaluatedAt: '2026-11-28T06:00:00.000Z',
      activeChaosIds: ['null_store_id', 'duplicate_vouchers'],
    });

    expect(yaml).toContain('version: 2');
    expect(yaml).toContain('sources:');
    expect(yaml).toContain('loaded_at_field: ingested_at_utc');
    expect(yaml).toContain('warn_after: {count: 10, period: minute}');
    expect(yaml).toContain('error_after: {count: 15, period: minute}');
    expect(yaml).toContain('- name: bronze_orders');
    expect(yaml).toContain('- name: silver_vouchers');
    expect(yaml).toContain('- name: gold_store_kpis');
    expect(yaml).toContain('dbt_utils.accepted_range:');
    expect(yaml).toContain('relationships:');
    expect(yaml).toContain('71.4%');
    expect(yaml).toContain('null_store_id, duplicate_vouchers');
  });

  it('formats assertion status badges cleanly for UI display', () => {
    expect(formatAssertionStatusBadge('PASS')).toBe('PASS');
    expect(formatAssertionStatusBadge('WARN')).toBe('WARN');
    expect(formatAssertionStatusBadge('CRITICAL_FAIL')).toBe('CRITICAL FAIL');
  });

  it('exposes exactly 3 chaos injectors in CHAOS_INJECTOR_CATALOG with bilingual metadata', () => {
    expect(CHAOS_INJECTOR_CATALOG).toHaveLength(3);
    expect(CHAOS_INJECTOR_CATALOG.map((c) => c.id)).toEqual([
      'null_store_id',
      'duplicate_vouchers',
      'kafka_cdc_lag',
    ]);
    for (const item of CHAOS_INJECTOR_CATALOG) {
      expect(item.labelEn.length).toBeGreaterThan(8);
      expect(item.labelVi.length).toBeGreaterThan(8);
    }
  });

  it('getActiveChaosIds returns empty array for clean state and exact keys for active faults', () => {
    expect(getActiveChaosIds(CLEAN_CHAOS_STATE)).toEqual([]);
    const state = {
      ...CLEAN_CHAOS_STATE,
      duplicateVoucherCount: 50,
      kafkaCdcLagMinutes: 25,
    };
    expect(getActiveChaosIds(state)).toEqual(['duplicate_vouchers', 'kafka_cdc_lag']);
  });

  it('attaches non-empty read-only remediation SELECT SQL to every assertion rule', () => {
    const report = evaluateDataQualityContracts(100_000, CLEAN_CHAOS_STATE);
    for (const assertion of report.assertions) {
      expect(assertion.remediationSql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(assertion.dbtTestName.length).toBeGreaterThan(4);
      expect(assertion.geExpectation.startsWith('expect_')).toBe(true);
    }
  });

  it('computes deterministic identical results for identical inputs and timestamp', () => {
    const chaos = applyChaosFault(createCleanChaosState(), 'null_store_id');
    const a = evaluateDataQualityContracts(100_000, chaos, '2026-11-28T06:00:00.000Z');
    const b = evaluateDataQualityContracts(100_000, chaos, '2026-11-28T06:00:00.000Z');
    expect(a).toEqual(b);
  });
});
