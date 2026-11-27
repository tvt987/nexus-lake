import { describe, expect, it } from 'vitest';
import {
  buildMedallionLineageGraph,
  computeBezierEdgePath,
  computeLineageDependencyHighlight,
  estimateQueryPlanCost,
  gradeQualityFromNullRate,
  injectStaleDelta,
  NODE_CARD_HEIGHT,
  NODE_CARD_WIDTH,
  simulateIncrementalRefresh,
  validateLineageAcyclic,
} from '../engines/lineageGraphEngine';
import { buildQueryPlanAnalysis } from '../engine/queryPlanParser';
import { generateColumnarTransactions } from '../engine/dataGenerator';
import { runFallbackSql } from '../engine/duckdbEngine';
import type { TableSchemaInfo } from '../types/lakehouse';

const BASE_CATALOG: TableSchemaInfo[] = [
  {
    name: 'transactions',
    rowCount: 100_000,
    source: 'synthetic',
    columns: [
      { name: 'tx_id', type: 'VARCHAR' },
      { name: 'region', type: 'VARCHAR' },
      { name: 'amount_usd', type: 'DOUBLE' },
    ],
  },
];

describe('v4.0 Medallion Data Lineage, Schema ERD & Query Cost Engine', () => {
  it('builds a full Bronze -> Silver -> Gold Medallion topology with deterministic counts', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);

    expect(graph.summary.bronzeCount).toBe(4);
    expect(graph.summary.silverCount).toBe(3);
    expect(graph.summary.goldCount).toBe(3);
    expect(graph.summary.totalTables).toBe(10);
    expect(graph.edges.length).toBe(10);
    expect(graph.summary.totalRows).toBeGreaterThan(250_000);
  });

  it('synchronizes live DuckDB transaction row scale across Bronze and Silver nodes', () => {
    const scaledCatalog: TableSchemaInfo[] = [
      { ...BASE_CATALOG[0], rowCount: 250_000 },
    ];
    const graph = buildMedallionLineageGraph(scaledCatalog);
    const bronzePos = graph.nodes.find((n) => n.id === 'bronze_pos_events')!;
    const silverTx = graph.nodes.find((n) => n.id === 'silver_transactions_clean')!;

    expect(bronzePos.rowCount).toBe(250_000);
    expect(silverTx.rowCount).toBeGreaterThan(240_000);
    expect(bronzePos.sizeMb).toBeGreaterThan(20);
  });

  it('dynamically mounts user-uploaded CSV/JSON tables into Bronze with profiled null rates', () => {
    const uploadedCatalog: TableSchemaInfo[] = [
      ...BASE_CATALOG,
      {
        name: 'custom_orders_q4',
        rowCount: 12_500,
        source: 'uploaded',
        columns: [
          { name: 'order_id', type: 'VARCHAR' },
          { name: 'amount', type: 'DOUBLE' },
        ],
        profile: {
          tableName: 'custom_orders_q4',
          sourceName: 'custom_orders_q4.csv',
          format: 'csv',
          rowCount: 12_500,
          columnCount: 2,
          parseMs: 14,
          estimatedBytes: 1_500_000,
          ingestedAt: '2026-11-28T00:00:00.000Z',
          columns: [
            {
              name: 'order_id',
              inferredType: 'String',
              sqlType: 'VARCHAR',
              rowCount: 12_500,
              nullCount: 0,
              nullRatePct: 0,
              cardinality: 12_500,
              sampleValues: ['ORD-1'],
            },
            {
              name: 'amount',
              inferredType: 'Numeric',
              sqlType: 'DOUBLE',
              rowCount: 12_500,
              nullCount: 500,
              nullRatePct: 4.0,
              cardinality: 400,
              sampleValues: ['120.5'],
            },
          ],
        },
      },
    ];

    const graph = buildMedallionLineageGraph(uploadedCatalog);
    const uploadedNode = graph.nodes.find((n) => n.name === 'custom_orders_q4');

    expect(uploadedNode).toBeDefined();
    expect(uploadedNode!.layer).toBe('bronze');
    expect(uploadedNode!.rowCount).toBe(12_500);
    expect(uploadedNode!.nullRatePct).toBe(2);
    expect(uploadedNode!.qualityGrade).toBe('B');
    expect(graph.edges.some((e) => e.source === uploadedNode!.id && e.target === 'silver_transactions_clean')).toBe(
      true,
    );
  });

  it('verifies the Medallion lineage graph is strictly acyclic via Kahn topological sort', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const validation = validateLineageAcyclic(graph.nodes, graph.edges);

    expect(validation.acyclic).toBe(true);
    expect(validation.cycleNodes).toEqual([]);
    expect(validation.topologicalOrder.length).toBe(graph.nodes.length);

    const pos = new Map(validation.topologicalOrder.map((id, i) => [id, i]));
    for (const edge of graph.edges) {
      expect(pos.get(edge.source)!).toBeLessThan(pos.get(edge.target)!);
    }
  });

  it('detects cyclic dependencies cleanly when a cycle edge is introduced', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const badEdges = [
      ...graph.edges,
      {
        id: 'e-cycle',
        source: 'gold_regional_revenue_mart',
        target: 'bronze_pos_events',
        transformLabel: 'Illegal Feedback Loop',
        joinKey: 'region',
        edgeType: 'transform' as const,
        estimatedRowFlow: 25,
      },
    ];

    const validation = validateLineageAcyclic(graph.nodes, badEdges);
    expect(validation.acyclic).toBe(false);
    expect(validation.cycleNodes).toContain('bronze_pos_events');
    expect(validation.cycleNodes).toContain('silver_transactions_clean');
    expect(validation.cycleNodes).toContain('gold_regional_revenue_mart');
  });

  it('traces full downstream dependencies from a Bronze root table with zero upstream nodes', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const hl = computeLineageDependencyHighlight('bronze_pos_events', graph.nodes, graph.edges);

    expect(hl.selectedId).toBe('bronze_pos_events');
    expect(hl.upstreamNodeIds).toEqual([]);
    expect(hl.upstreamEdgeIds).toEqual([]);
    expect(hl.downstreamNodeIds).toContain('silver_transactions_clean');
    expect(hl.downstreamNodeIds).toContain('gold_regional_revenue_mart');
    expect(hl.downstreamNodeIds).toContain('gold_nrr_cohort_mart');
    expect(hl.downstreamNodeIds).toContain('gold_exec_unit_economics');
    expect(hl.downstreamEdgeIds.length).toBeGreaterThanOrEqual(4);
  });

  it('traces both upstream Bronze parents and downstream Gold marts from a Silver table', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const hl = computeLineageDependencyHighlight(
      'silver_transactions_clean',
      graph.nodes,
      graph.edges,
    );

    expect(hl.upstreamNodeIds).toContain('bronze_pos_events');
    expect(hl.upstreamNodeIds).toContain('bronze_vn_retail_orders');
    expect(hl.downstreamNodeIds).toContain('gold_regional_revenue_mart');
    expect(hl.downstreamNodeIds).toContain('gold_nrr_cohort_mart');
    expect(hl.downstreamNodeIds).toContain('gold_exec_unit_economics');
    expect(hl.impactedNodeCount).toBe(6);
  });

  it('traces full transitive Bronze + Silver ancestors from a terminal Gold KPI mart', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const hl = computeLineageDependencyHighlight(
      'gold_exec_unit_economics',
      graph.nodes,
      graph.edges,
    );

    expect(hl.downstreamNodeIds).toEqual([]);
    expect(hl.downstreamEdgeIds).toEqual([]);
    expect(hl.upstreamNodeIds).toContain('silver_transactions_clean');
    expect(hl.upstreamNodeIds).toContain('silver_customer_accounts');
    expect(hl.upstreamNodeIds).toContain('silver_logistics_sla');
    expect(hl.upstreamNodeIds).toContain('bronze_pos_events');
    expect(hl.upstreamNodeIds).toContain('bronze_saas_subscriptions');
    expect(hl.upstreamNodeIds).toContain('bronze_freight_telemetry');
  });

  it('returns clean empty highlight sets when selection is null or unknown', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    expect(computeLineageDependencyHighlight(null, graph.nodes, graph.edges).selectedId).toBeNull();
    expect(
      computeLineageDependencyHighlight('nonexistent_table', graph.nodes, graph.edges)
        .impactedNodeCount,
    ).toBe(0);
  });

  it('assigns strict data quality grades based on null-rate thresholds', () => {
    expect(gradeQualityFromNullRate(0)).toBe('A');
    expect(gradeQualityFromNullRate(0.99)).toBe('A');
    expect(gradeQualityFromNullRate(1.0)).toBe('B');
    expect(gradeQualityFromNullRate(4.99)).toBe('B');
    expect(gradeQualityFromNullRate(5.0)).toBe('C');
    expect(gradeQualityFromNullRate(18.4)).toBe('C');
  });

  it('positions Bronze, Silver, and Gold columns strictly left-to-right with zero node overlap', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const bronzeX = new Set(graph.nodes.filter((n) => n.layer === 'bronze').map((n) => n.x));
    const silverX = new Set(graph.nodes.filter((n) => n.layer === 'silver').map((n) => n.x));
    const goldX = new Set(graph.nodes.filter((n) => n.layer === 'gold').map((n) => n.x));

    expect([...bronzeX][0]).toBeLessThan([...silverX][0]);
    expect([...silverX][0]).toBeLessThan([...goldX][0]);

    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const a = graph.nodes[i];
        const b = graph.nodes[j];
        const overlapsX = a.x < b.x + NODE_CARD_WIDTH && a.x + NODE_CARD_WIDTH > b.x;
        const overlapsY = a.y < b.y + NODE_CARD_HEIGHT && a.y + NODE_CARD_HEIGHT > b.y;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }
  });

  it('generates valid SVG cubic Bezier paths between connected source and target ports', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const src = graph.nodes.find((n) => n.id === 'bronze_pos_events')!;
    const dst = graph.nodes.find((n) => n.id === 'silver_transactions_clean')!;
    const path = computeBezierEdgePath(src, dst);

    expect(path.d).toMatch(/^M \d+ \d+ C /);
    expect(path.midX).toBeGreaterThan(src.x + src.width);
    expect(path.midX).toBeLessThan(dst.x);
  });

  it('increases partition pruning ratio and lowers scan rows when WHERE filters partition keys', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const fullScan = estimateQueryPlanCost(
      'SELECT * FROM bronze_pos_events GROUP BY region;',
      graph,
      'bronze_pos_events',
    );
    const prunedScan = estimateQueryPlanCost(
      "SELECT tx_id, region, amount_usd FROM bronze_pos_events WHERE region = 'APAC-VN' GROUP BY tx_id, region, amount_usd LIMIT 100;",
      graph,
      'bronze_pos_events',
    );

    expect(prunedScan.usedPartitionFilter).toBe(true);
    expect(prunedScan.partitionPruningRatio).toBeGreaterThan(fullScan.partitionPruningRatio);
    expect(prunedScan.estimatedScanRows).toBeLessThan(fullScan.estimatedScanRows);
    expect(prunedScan.memoryFootprintMb).toBeLessThan(fullScan.memoryFootprintMb);
    expect(prunedScan.prunedRows).toBe(prunedScan.totalTableRows - prunedScan.estimatedScanRows);
  });

  it('recommends routing raw Bronze GROUP BY queries to Gold materialized views', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const cost = estimateQueryPlanCost(
      'SELECT * FROM bronze_pos_events GROUP BY region;',
      graph,
      'bronze_pos_events',
    );

    expect(cost.recommendations.some((r) => r.includes('gold_regional_revenue_mart'))).toBe(true);
    expect(cost.recommendations.some((r) => r.includes('SELECT *'))).toBe(true);
  });

  it('computes low-cost pre-aggregated profile for Gold materialized views', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const cost = estimateQueryPlanCost(
      'SELECT region, gross_volume_usd FROM gold_regional_revenue_mart;',
      graph,
      'gold_regional_revenue_mart',
    );

    expect(cost.targetLayer).toBe('gold');
    expect(cost.costTier).toBe('LOW');
    expect(cost.partitionPruningRatio).toBeGreaterThanOrEqual(0.75);
    expect(cost.memoryFootprintMb).toBeGreaterThan(0);
    expect(cost.estimatedLatencyMs).toBeGreaterThan(0);
  });

  it('simulates stale CDC delta marking Bronze and downstream Silver/Gold layers stale', () => {
    const graph = buildMedallionLineageGraph(BASE_CATALOG);
    const staleGraph = injectStaleDelta(graph, 5_000);

    expect(staleGraph.summary.staleCount).toBe(staleGraph.nodes.length);
    const bronzeBefore = graph.nodes.find((n) => n.id === 'bronze_pos_events')!;
    const bronzeAfter = staleGraph.nodes.find((n) => n.id === 'bronze_pos_events')!;
    expect(bronzeAfter.rowCount).toBe(bronzeBefore.rowCount + 5_000);
    expect(bronzeAfter.freshnessSec).toBeGreaterThan(bronzeBefore.freshnessSec);
  });

  it('executes 1-click incremental refresh across Bronze -> Silver -> Gold in topological order', () => {
    const graph = injectStaleDelta(buildMedallionLineageGraph(BASE_CATALOG), 4_500);
    const res = simulateIncrementalRefresh(graph);

    expect(res.steps.length).toBe(graph.nodes.length);
    expect(res.graph.summary.staleCount).toBe(0);
    expect(res.totalDeltaRows).toBeGreaterThan(0);
    expect(res.totalDurationMs).toBeGreaterThan(0);
    expect(res.peakMemoryMb).toBeGreaterThan(0);
    expect(res.avgPartitionPruningRatio).toBeGreaterThan(0.75);

    const stepPos = new Map(res.steps.map((s, idx) => [s.nodeId, idx]));
    for (const edge of graph.edges) {
      expect(stepPos.get(edge.source)!).toBeLessThan(stepPos.get(edge.target)!);
    }
    for (const node of res.graph.nodes) {
      expect(node.freshnessSec).toBe(0);
      expect(node.refreshState).toBe('refreshed');
    }
  });

  it('supports targeted incremental refresh scoping strictly to selected node and upstream ancestors', () => {
    const graph = injectStaleDelta(buildMedallionLineageGraph(BASE_CATALOG), 4_500);
    const res = simulateIncrementalRefresh(graph, 'gold_regional_revenue_mart');
    const refreshedIds = new Set(res.steps.map((s) => s.nodeId));

    expect(refreshedIds.has('gold_regional_revenue_mart')).toBe(true);
    expect(refreshedIds.has('silver_transactions_clean')).toBe(true);
    expect(refreshedIds.has('bronze_pos_events')).toBe(true);
    expect(refreshedIds.has('bronze_vn_retail_orders')).toBe(true);
    // Unrelated logistics branch stays untouched
    expect(refreshedIds.has('bronze_freight_telemetry')).toBe(false);
    expect(refreshedIds.has('silver_logistics_sla')).toBe(false);
  });

  it('computes scan rows, partition pruning ratio, and memory footprint inside QueryPlanAnalysis', () => {
    const ds = generateColumnarTransactions(10_000, 777);
    const sql =
      "SELECT region, COUNT(*) AS tx_count FROM transactions WHERE region = 'APAC-VN' GROUP BY region;";
    const result = runFallbackSql(sql, ds, new Map());
    const analysis = buildQueryPlanAnalysis(result, null);

    expect(analysis).not.toBeNull();
    expect(analysis!.partitionPruningRatio).toBeGreaterThan(0.5);
    expect(analysis!.estimatedScanRows).toBeLessThan(analysis!.scannedRows);
    expect(analysis!.memoryFootprintMb).toBeGreaterThan(0);
  });
});
