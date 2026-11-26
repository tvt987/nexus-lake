import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMcpHttpServer } from '../src/httpServer.js';

describe('MCP Streamable HTTP Transport', () => {
  const { server } = createMcpHttpServer({
    rateLimitPerMinute: 25,
    tokens: {
      'token-readonly': { subject: 'analyst-ro', scopes: ['lakehouse:read'] },
      'token-admin': {
        subject: 'architect-admin',
        scopes: ['lakehouse:read', 'lakehouse:anomaly', 'lakehouse:export', 'lakehouse:admin'],
      },
    },
  });

  let baseUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('serves /health publicly and rejects unauthenticated /mcp with 401', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauth.status).toBe(401);
  });

  it('enforces Bearer scope authorization (403 on export_report for readonly token)', async () => {
    const forbidden = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-readonly',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'export_report', arguments: { format: 'json' } },
      }),
    });
    expect(forbidden.status).toBe(403);

    const allowed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-readonly',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'lakehouse_query',
          arguments: { sql: 'SELECT COUNT(*) FROM transactions' },
        },
      }),
    });
    expect(allowed.status).toBe(200);
    const json = (await allowed.json()) as { result: { isError: boolean } };
    expect(json.result.isError).toBe(false);
  });

  it('supports Streamable HTTP text/event-stream responses and admin /audit log', async () => {
    const sseResp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer token-admin',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'detect_anomalies', arguments: { riskThreshold: 0.8, limit: 5 } },
      }),
    });
    expect(sseResp.status).toBe(200);
    expect(sseResp.headers.get('content-type')).toContain('text/event-stream');
    expect(sseResp.headers.get('mcp-session-id')).toBeTruthy();

    const text = await sseResp.text();
    expect(text).toContain('event: message');
    expect(text).toContain('"id":99');

    const auditResp = await fetch(`${baseUrl}/audit`, {
      headers: { Authorization: 'Bearer token-admin' },
    });
    expect(auditResp.status).toBe(200);
    const auditJson = (await auditResp.json()) as { entries: unknown[] };
    expect(auditJson.entries.length).toBeGreaterThanOrEqual(2);
  });
});
