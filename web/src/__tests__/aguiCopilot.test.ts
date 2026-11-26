import { describe, expect, it } from 'vitest';
import { planDeterministicSql, runAguiCopilotSession } from '../engine/aguiCopilot';
import { generateColumnarTransactions } from '../engine/dataGenerator';
import { runFallbackSql } from '../engine/duckdbEngine';
import type { AguiWireEvent, GenerativeWidget } from '../types/lakehouse';

describe('AG-UI Generative Copilot & Protocol Stream', () => {
  it('routes natural language EN/VI intents to verified read-only SQL', () => {
    expect(planDeterministicSql('Detect voucher abuse').intent).toBe('voucher_abuse_detection');
    expect(planDeterministicSql('Compute P99 latency SLA').intent).toBe('p99_latency_sla');
    expect(planDeterministicSql('Rolling 24h moving average').intent).toBe('rolling_24h_trend');
    expect(planDeterministicSql('Show fraud spikes by region').intent).toBe(
      'regional_fraud_and_revenue',
    );
  });

  it('streams complete AG-UI protocol lifecycle and emits generative BI widgets', async () => {
    const ds = generateColumnarTransactions(5_000, 123);
    const events: AguiWireEvent[] = [];
    const widgets: GenerativeWidget[] = [];

    const session = await runAguiCopilotSession('Show fraud spikes by region', {
      executeSql: async (sql) => runFallbackSql(sql, ds, new Map()),
      onEvent: (ev) => events.push(ev),
      onWidget: (w) => widgets.push(w),
      onMessageChunk: () => {},
    });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('RUN_STARTED');
    expect(types).toContain('STEP_STARTED');
    expect(types).toContain('TOOL_CALL_START');
    expect(types).toContain('TOOL_CALL_RESULT');
    expect(types).toContain('STATE_DELTA');
    expect(types).toContain('UI_WIDGET_EMIT');
    expect(types).toContain('TEXT_MESSAGE_CONTENT');
    expect(types[types.length - 1]).toBe('RUN_FINISHED');

    expect(widgets.length).toBeGreaterThanOrEqual(3);
    expect(session.result.rowCount).toBe(5);
  });
});
