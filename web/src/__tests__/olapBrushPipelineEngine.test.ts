import { describe, expect, it } from 'vitest';
import {
  appendStreamingPointsToIndex,
  clearOlapSelectionMask,
  compileBrushToSql,
  computeOlapClusterBeacons,
  createDefaultCubeCamera,
  createInitialMedallionPipelineState,
  createOlapPointCloudIndex,
  MAX_OLAP_LATENCY_MS,
  MAX_OLAP_REVENUE_USD,
  normalizeLassoBox,
  OLAP_BRUSH_PRESETS,
  OLAP_REGIONS,
  project3dCubePoint,
  queryOlapLassoBox,
  queryOlapPolygonLasso,
  stepMedallionCdcPipeline,
  validateOlapReadOnlySql,
  type MedallionPipelineState,
  type OlapLassoBox,
} from '../engines/olapBrushPipelineEngine';
import { generateColumnarTransactions } from '../engine/dataGenerator';
import { runFallbackSql } from '../engine/duckdbEngine';

describe('v6.0 100K-Row OLAP Spatial Index, Brush-to-SQL Compiler & Medallion CDC Engine', () => {
  const index100k = createOlapPointCloudIndex(100_000, 20261128);

  it('1. deterministically synthesizes exactly 100,000 telemetry points with reproducible stats', () => {
    const a = createOlapPointCloudIndex(10_000, 9001);
    const b = createOlapPointCloudIndex(10_000, 9001);
    expect(a.count).toBe(10_000);
    expect(a.totalAnomalies).toBe(b.totalAnomalies);
    expect(a.revenueUsd[0]).toBe(b.revenueUsd[0]);
    expect(a.latencyMs[500]).toBe(b.latencyMs[500]);
    expect(a.riskScore[999]).toBe(b.riskScore[999]);
    expect(a.regionIdx[42]).toBe(b.regionIdx[42]);
  });

  it('2. populates all 100,000 points within valid domain bounds with zero NaN/Infinity values', () => {
    expect(index100k.count).toBe(100_000);
    expect(index100k.totalAnomalies).toBeGreaterThan(5_000);
    expect(index100k.totalAnomalies).toBeLessThan(15_000);
    for (let i = 0; i < 100_000; i += 250) {
      expect(Number.isFinite(index100k.latencyMs[i])).toBe(true);
      expect(index100k.latencyMs[i]).toBeGreaterThanOrEqual(0);
      expect(index100k.latencyMs[i]).toBeLessThanOrEqual(MAX_OLAP_LATENCY_MS);
      expect(index100k.revenueUsd[i]).toBeGreaterThan(0);
      expect(index100k.revenueUsd[i]).toBeLessThanOrEqual(MAX_OLAP_REVENUE_USD);
      expect(index100k.riskScore[i]).toBeGreaterThanOrEqual(0);
      expect(index100k.riskScore[i]).toBeLessThanOrEqual(1);
    }
  });

  it('3. constructs an exact CSR 32x32 spatial bucket index containing every point exactly once', () => {
    const totalBuckets = index100k.gridDim * index100k.gridDim;
    expect(totalBuckets).toBe(1024);
    expect(index100k.bucketOffsets[0]).toBe(0);
    expect(index100k.bucketOffsets[totalBuckets]).toBe(100_000);

    for (let b = 0; b < totalBuckets; b += 1) {
      expect(index100k.bucketOffsets[b + 1]).toBeGreaterThanOrEqual(index100k.bucketOffsets[b]);
    }
  });

  it('4. matches brute-force linear scan with 100% exact count agreement on Lasso box queries', () => {
    const box: OlapLassoBox = {
      minLatencyMs: 430,
      maxLatencyMs: 920,
      minRevenueUsd: 2650,
      maxRevenueUsd: 6200,
    };
    const indexedRes = queryOlapLassoBox(index100k, box, { updateMask: false });

    let bruteCount = 0;
    let bruteAnomalies = 0;
    for (let i = 0; i < index100k.count; i += 1) {
      const lat = index100k.latencyMs[i];
      const rev = index100k.revenueUsd[i];
      if (
        lat >= box.minLatencyMs &&
        lat <= box.maxLatencyMs &&
        rev >= box.minRevenueUsd &&
        rev <= box.maxRevenueUsd
      ) {
        bruteCount += 1;
        bruteAnomalies += index100k.isAnomaly[i];
      }
    }

    expect(indexedRes.selectedCount).toBe(bruteCount);
    expect(indexedRes.anomalyCount).toBe(bruteAnomalies);
    expect(indexedRes.selectedCount).toBeGreaterThan(4_000);
  });

  it('5. executes spatial-bucketed Lasso Box query over 100,000 points rapidly (<15ms even under CI jitter)', () => {
    // Warm up JIT once then measure
    queryOlapLassoBox(index100k, OLAP_BRUSH_PRESETS[0].box, { updateMask: true });
    const res = queryOlapLassoBox(index100k, OLAP_BRUSH_PRESETS[0].box, { updateMask: true });
    expect(res.selectedCount).toBeGreaterThan(4_500);
    expect(res.queryTimeMs).toBeLessThan(15);
  });

  it('6. isolates High-Latency Whale Anomaly preset with >95% anomaly density and high avg revenue', () => {
    const res = queryOlapLassoBox(index100k, OLAP_BRUSH_PRESETS[0].box, { updateMask: false });
    expect(res.anomalyPct).toBeGreaterThan(95);
    expect(res.avgRevenueUsd).toBeGreaterThan(3_800);
    expect(res.p99LatencyMs).toBeGreaterThanOrEqual(res.p95LatencyMs);
    expect(res.p95LatencyMs).toBeGreaterThanOrEqual(res.p50LatencyMs);
    expect(res.p50LatencyMs).toBeGreaterThan(550);
  });

  it('7. isolates Voucher Bot Micro-Bursts preset with >90% anomaly rate and sub-$1,500 avg revenue', () => {
    const res = queryOlapLassoBox(index100k, OLAP_BRUSH_PRESETS[1].box, { updateMask: false });
    expect(res.selectedCount).toBeGreaterThan(2_000);
    expect(res.anomalyPct).toBeGreaterThan(90);
    expect(res.avgRevenueUsd).toBeLessThan(1_500);
  });

  it('8. sorts regional breakdown strictly by txCount DESC and sums to selectedCount', () => {
    const res = queryOlapLassoBox(index100k, OLAP_BRUSH_PRESETS[0].box, { updateMask: false });
    expect(res.regionBreakdown.length).toBeGreaterThan(0);
    let sum = 0;
    for (let i = 0; i < res.regionBreakdown.length; i += 1) {
      sum += res.regionBreakdown[i].txCount;
      if (i > 0) {
        expect(res.regionBreakdown[i - 1].txCount).toBeGreaterThanOrEqual(
          res.regionBreakdown[i].txCount,
        );
      }
    }
    expect(sum).toBe(res.selectedCount);
  });

  it('9. updates selectedMask in-place on query and resets cleanly on clearOlapSelectionMask', () => {
    const idx = createOlapPointCloudIndex(5_000, 123);
    const res = queryOlapLassoBox(idx, OLAP_BRUSH_PRESETS[0].box, { updateMask: true });
    let ones = 0;
    for (let i = 0; i < idx.count; i += 1) ones += idx.selectedMask[i];
    expect(ones).toBe(res.selectedCount);

    clearOlapSelectionMask(idx);
    let afterClear = 0;
    for (let i = 0; i < idx.count; i += 1) afterClear += idx.selectedMask[i];
    expect(afterClear).toBe(0);
  });

  it('10. normalizes inverted, negative, NaN, and over-max Lasso coordinates safely', () => {
    const norm = normalizeLassoBox({
      minLatencyMs: 9999,
      maxLatencyMs: -50,
      minRevenueUsd: Number.NaN,
      maxRevenueUsd: 999999,
    });
    expect(norm.minLatencyMs).toBe(0);
    expect(norm.maxLatencyMs).toBe(MAX_OLAP_LATENCY_MS);
    expect(norm.minRevenueUsd).toBe(0);
    expect(norm.maxRevenueUsd).toBe(MAX_OLAP_REVENUE_USD);
  });

  it('11. filters Lasso selection accurately by 5-bit region bitmask', () => {
    const maskApacOnly = 0b00011; // APAC-VN & APAC-SG
    const res = queryOlapLassoBox(index100k, OLAP_BRUSH_PRESETS[0].box, {
      regionFilterMask: maskApacOnly,
      updateMask: false,
    });
    expect(res.regionBreakdown.every((r) => r.region === 'APAC-VN' || r.region === 'APAC-SG')).toBe(
      true,
    );
    expect(res.selectedCount).toBeGreaterThan(1_000);
  });

  it('12. returns clean zero metrics for empty/out-of-cluster Lasso boxes without NaN', () => {
    const res = queryOlapLassoBox(
      index100k,
      { minLatencyMs: 995, maxLatencyMs: 999, minRevenueUsd: 1, maxRevenueUsd: 5 },
      { updateMask: false },
    );
    expect(res.selectedCount).toBe(0);
    expect(res.avgRevenueUsd).toBe(0);
    expect(res.anomalyPct).toBe(0);
    expect(res.p99LatencyMs).toBe(0);
    expect(res.regionBreakdown).toEqual([]);
  });

  it('13. supports freehand polygon Lasso selection strictly inside polygon geometry', () => {
    const poly = [
      { latencyMs: 500, revenueUsd: 3500 },
      { latencyMs: 900, revenueUsd: 3500 },
      { latencyMs: 850, revenueUsd: 6200 },
      { latencyMs: 550, revenueUsd: 6200 },
    ];
    const polyRes = queryOlapPolygonLasso(index100k, poly, { updateMask: false });
    const boxRes = queryOlapLassoBox(
      index100k,
      { minLatencyMs: 500, maxLatencyMs: 900, minRevenueUsd: 3500, maxRevenueUsd: 6200 },
      { updateMask: false },
    );
    expect(polyRes.selectionMode).toBe('polygon');
    expect(polyRes.selectedCount).toBeGreaterThan(2_000);
    expect(polyRes.selectedCount).toBeLessThanOrEqual(boxRes.selectedCount);
  });

  it('14. handles degenerate freehand polygons (<3 points) gracefully', () => {
    const res = queryOlapPolygonLasso(
      index100k,
      [
        { latencyMs: 100, revenueUsd: 100 },
        { latencyMs: 200, revenueUsd: 200 },
      ],
      { updateMask: false },
    );
    expect(res.selectedCount).toBe(0);
  });

  it('15. compiles clean parameterized Brush-to-SQL targeting gold_transactions and passes Read-Only AST Guard', () => {
    const compiled = compileBrushToSql({
      minLatencyMs: 430,
      maxLatencyMs: 960,
      minRevenueUsd: 2600,
      maxRevenueUsd: 6450,
    });
    expect(compiled.guardrail.allowed).toBe(true);
    expect(compiled.guardrail.statementType).toBe('SELECT');
    expect(compiled.guardrail.detectedTables).toContain('gold_transactions');
    expect(compiled.sql).toContain('FROM gold_transactions');
    expect(compiled.sql).toContain('latency_ms BETWEEN 430 AND 960');
    expect(compiled.sql).toContain('revenue_usd BETWEEN 2600.00 AND 6450.00');
    expect(compiled.sql).toContain('PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)');
    expect(compiled.sql).toContain('GROUP BY region');
    expect(compiled.sql).toContain('ORDER BY tx_cnt DESC;');
  });

  it('16. includes allowlisted region IN clause when region subset is provided and ignores injected strings', () => {
    const compiled = compileBrushToSql(OLAP_BRUSH_PRESETS[0].box, {
      regions: ['APAC-VN', "NA-WEST'; DROP TABLE gold_transactions; --" as unknown as 'NA-WEST'],
    });
    expect(compiled.guardrail.allowed).toBe(true);
    expect(compiled.sql).toContain("region IN ('APAC-VN')");
    expect(compiled.sql).not.toContain('DROP TABLE');
  });

  it('17. omits redundant region IN clause when all 5 regions are selected', () => {
    const compiled = compileBrushToSql(OLAP_BRUSH_PRESETS[0].box, { regions: OLAP_REGIONS });
    expect(compiled.sql).not.toContain('region IN');
    expect(compiled.params.regions).toHaveLength(5);
  });

  it('18. Read-Only SQL AST Guard allows SELECT, WITH CTE, EXPLAIN, DESCRIBE, SHOW queries', () => {
    const validQueries = [
      'SELECT COUNT(*) FROM gold_transactions;',
      'WITH top_r AS (SELECT region FROM gold_transactions) SELECT * FROM top_r LIMIT 5;',
      'EXPLAIN SELECT region FROM gold_transactions GROUP BY region',
      'DESCRIBE gold_transactions;',
      'SHOW TABLES;',
    ];
    for (const q of validQueries) {
      const verdict = validateOlapReadOnlySql(q);
      expect(verdict.allowed, `Expected allowed for: ${q}`).toBe(true);
    }
  });

  it('19. Read-Only SQL AST Guard blocks DDL/DML keywords (DROP, DELETE, UPDATE, INSERT, ALTER, COPY)', () => {
    const attacks = [
      'DROP TABLE gold_transactions;',
      'DELETE FROM gold_transactions WHERE latency_ms > 500;',
      'UPDATE gold_transactions SET revenue_usd = 0;',
      'INSERT INTO gold_transactions VALUES (1);',
      'ALTER TABLE gold_transactions ADD COLUMN x INT;',
      "COPY gold_transactions TO '/tmp/exfil.csv';",
    ];
    for (const q of attacks) {
      const verdict = validateOlapReadOnlySql(q);
      expect(verdict.allowed, `Expected blocked for: ${q}`).toBe(false);
    }
  });

  it('20. Read-Only SQL AST Guard blocks stacked multi-statement SQL injection', () => {
    const verdict = validateOlapReadOnlySql(
      'SELECT * FROM gold_transactions LIMIT 10; DROP TABLE gold_transactions;',
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.statementType).toBe('MULTI_STATEMENT');
  });

  it('21. Read-Only SQL AST Guard blocks DuckDB external file/HTTP exfiltration functions', () => {
    expect(validateOlapReadOnlySql("SELECT * FROM read_csv('/etc/passwd')").allowed).toBe(false);
    expect(validateOlapReadOnlySql("SELECT * FROM read_parquet('s3://bucket/a.parquet')").allowed).toBe(false);
    expect(validateOlapReadOnlySql("SELECT http_get('https://evil.test')").allowed).toBe(false);
  });

  it('22. Read-Only SQL AST Guard handles comments safely without bypassing keyword detection', () => {
    expect(validateOlapReadOnlySql('SELECT /* comment */ region FROM gold_transactions;').allowed).toBe(true);
    expect(validateOlapReadOnlySql('SELECT /* unterminated comment').allowed).toBe(false);
    expect(validateOlapReadOnlySql("SELECT 'DROP TABLE' AS safe_literal FROM gold_transactions;").allowed).toBe(true);
    expect(validateOlapReadOnlySql('').allowed).toBe(false);
  });

  it('23. compiled Brush-to-SQL executes end-to-end against FALLBACK-OLAP engine cleanly', () => {
    const ds = generateColumnarTransactions(25_000, 20261126);
    const compiled = compileBrushToSql({
      minLatencyMs: 50,
      maxLatencyMs: 700,
      minRevenueUsd: 20,
      maxRevenueUsd: 5500,
    });
    const res = runFallbackSql(compiled.sql, ds, new Map());
    expect(res.error).toBeUndefined();
    expect(res.columns).toEqual(['region', 'tx_cnt', 'avg_rev', 'p99_ms']);
    expect(res.rowCount).toBeGreaterThan(0);
  });

  it('24. initializes Medallion CDC pipeline cleanly with 0 quarantine rows and 0 Gold corruption', () => {
    const st = createInitialMedallionPipelineState(100_000);
    expect(st.streamingMode).toBe('STEADY');
    expect(st.schemaDriftActive).toBe(false);
    expect(st.quarantineDlqRows).toBe(0);
    expect(st.goldCorruptedRows).toBe(0);
    expect(st.dbtGateStatus).toBe('PASSING');
    expect(st.goldMartRows).toBe(100_000);
  });

  it('25. advances steady CDC micro-batches across Bronze -> Silver -> Gold with deduplication', () => {
    const idx = createOlapPointCloudIndex(5_000, 555);
    const init = createInitialMedallionPipelineState(5_000);
    const step = stepMedallionCdcPipeline(init, idx, { tickMs: 800 });

    expect(step.nextState.batchSeq).toBe(1);
    expect(step.nextState.bronzeRawRows).toBeGreaterThan(init.bronzeRawRows);
    expect(step.nextState.silverDedupedRows).toBeGreaterThan(init.silverDedupedRows);
    expect(step.nextState.goldMartRows).toBeGreaterThan(init.goldMartRows);
    expect(step.nextState.quarantineDlqRows).toBe(0);
    expect(step.nextState.goldCorruptedRows).toBe(0);
    expect(step.appendedGoldPoints).toBeGreaterThan(0);
    expect(idx.streamingLiveCount).toBe(step.appendedGoldPoints);
  });

  it('26. SURGE KAFKA CDC mode boosts throughput above +10,000 rows/sec and appends dense golden points', () => {
    const idx = createOlapPointCloudIndex(5_000, 777);
    const surgeStart = {
      ...createInitialMedallionPipelineState(5_000),
      streamingMode: 'SURGE' as const,
    };
    const step = stepMedallionCdcPipeline(surgeStart, idx, { tickMs: 500 });
    expect(step.nextState.kafkaRateRowsSec).toBeGreaterThanOrEqual(10_000);
    expect(step.nextState.lastBatchBronze).toBeGreaterThan(4_000);
    expect(step.appendedGoldPoints).toBeGreaterThan(100);
  });

  it('27. INJECT SCHEMA DRIFT intercepts 100% of malformed payloads into Quarantine DLQ with strictly 0 Gold corruption', () => {
    const idx = createOlapPointCloudIndex(5_000, 888);
    let state: MedallionPipelineState = {
      ...createInitialMedallionPipelineState(5_000),
      streamingMode: 'SURGE',
      schemaDriftActive: true,
    };

    for (let t = 0; t < 15; t += 1) {
      const step = stepMedallionCdcPipeline(state, idx, { tickMs: 500 });
      state = step.nextState;
      expect(step.injectedDriftThisTick).toBe(true);
      expect(step.quarantinedBatchRows).toBeGreaterThan(0);
      expect(state.goldCorruptedRows).toBe(0);
    }

    expect(state.dbtGateStatus).toBe('INTERCEPTING_DRIFT');
    expect(state.quarantineDlqRows).toBeGreaterThan(500);
    expect(state.activeDriftAlerts.length).toBe(3);
    const sumRuleIntercepts = state.activeDriftAlerts.reduce((acc, a) => acc + a.interceptedCount, 0);
    expect(sumRuleIntercepts).toBe(state.quarantineDlqRows);
    expect(state.goldCorruptedRows).toBe(0);
  });

  it('28. preserves bounded memory capacity via ring-wrap when streaming thousands of live batches', () => {
    const idx = createOlapPointCloudIndex(2_000, 999);
    const cap = idx.capacity;
    for (let b = 1; b <= 30; b += 1) {
      appendStreamingPointsToIndex(idx, 1_500, b, true);
    }
    expect(idx.count).toBeLessThanOrEqual(cap);
    expect(idx.bucketOffsets[idx.gridDim * idx.gridDim]).toBe(idx.count);
  });

  it('29. projects 3D OLAP Cube vertices into viewport coordinates with positive perspective depth', () => {
    const cam = createDefaultCubeCamera();
    const origin = project3dCubePoint(0, 0, 0, cam, 1000, 400);
    const whale = project3dCubePoint(0.75, 0.78, 0.92, cam, 1000, 400);
    expect(origin.visible).toBe(true);
    expect(whale.visible).toBe(true);
    expect(origin.depth).toBeGreaterThan(1);
    expect(whale.depth).toBeGreaterThan(1);
    // High-risk whale (z=0.92) must project higher on screen (smaller sy) than origin (z=0)
    expect(whale.sy).toBeLessThan(origin.sy);
  });

  it('30. computes 4 interactive 3D cluster beacons with live counts & severity grading', () => {
    const beacons = computeOlapClusterBeacons(index100k);
    expect(beacons).toHaveLength(4);
    const whale = beacons.find((b) => b.id === 'cluster-whale');
    const nominal = beacons.find((b) => b.id === 'cluster-nominal-core');
    expect(whale).toBeDefined();
    expect(nominal).toBeDefined();
    expect(whale!.severity).toBe('critical');
    expect(whale!.anomalyPct).toBeGreaterThan(95);
    expect(nominal!.severity).toBe('nominal');
    expect(nominal!.anomalyPct).toBeLessThan(5);
  });
});
