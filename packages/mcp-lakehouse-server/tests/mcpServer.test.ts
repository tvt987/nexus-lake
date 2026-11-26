import { describe, expect, it } from 'vitest';
import { NexusMcpServer } from '../src/mcpServer.js';

describe('NexusMcpServer JSON-RPC 2.0 Protocol', () => {
  it('handles initialize handshake and ping', async () => {
    const server = new NexusMcpServer();
    const init = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'vitest', version: '1.0' } },
    });

    expect(init?.error).toBeUndefined();
    expect((init?.result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26');
    expect((init?.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      '@nexus-lake/mcp-lakehouse-server',
    );

    const ping = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(ping?.result).toEqual({});
  });

  it('lists all 4 tools and 3 resources', async () => {
    const server = new NexusMcpServer();
    const toolsResp = await server.handleMessage({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
    const tools = (toolsResp?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'lakehouse_query',
      'lakehouse_schema',
      'detect_anomalies',
      'export_report',
    ]);

    const resList = await server.handleMessage({ jsonrpc: '2.0', id: 11, method: 'resources/list' });
    const resources = (resList?.result as { resources: { uri: string }[] }).resources;
    expect(resources).toHaveLength(3);
  });

  it('executes lakehouse_query for valid SQL and blocks destructive SQL', async () => {
    const server = new NexusMcpServer();

    const okResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'lakehouse_query',
        arguments: {
          sql: 'SELECT region, COUNT(*) FROM transactions GROUP BY region',
          maxRows: 10,
        },
      },
    });
    const okResult = okResp?.result as {
      isError: boolean;
      structuredContent: { rowCount: number; scannedRows: number };
    };
    expect(okResult.isError).toBe(false);
    expect(okResult.structuredContent.rowCount).toBe(5);
    expect(okResult.structuredContent.scannedRows).toBe(5000);

    const blockedResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'lakehouse_query',
        arguments: {
          sql: 'DELETE FROM transactions WHERE 1=1',
        },
      },
    });
    const blockedResult = blockedResp?.result as { isError: boolean; content: { text: string }[] };
    expect(blockedResult.isError).toBe(true);
    expect(blockedResult.content[0].text).toContain('blocked');
  });

  it('executes lakehouse_schema, detect_anomalies, export_report, and resources/read', async () => {
    const server = new NexusMcpServer();

    const schemaResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'lakehouse_schema', arguments: { table: 'transactions' } },
    });
    expect((schemaResp?.result as { isError: boolean }).isError).toBe(false);

    const anomalyResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'detect_anomalies',
        arguments: { riskThreshold: 0.78, region: 'APAC-VN', limit: 10 },
      },
    });
    const anomalyData = (anomalyResp?.result as { structuredContent: { matchedAnomalies: number } })
      .structuredContent;
    expect(anomalyData.matchedAnomalies).toBeGreaterThan(0);

    const exportResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'export_report',
        arguments: { format: 'csv', onlyAnomalies: true, limit: 15 },
      },
    });
    const exportData = (
      exportResp?.result as { structuredContent: { sha256: string; rowCount: number } }
    ).structuredContent;
    expect(exportData.sha256).toHaveLength(64);
    expect(exportData.rowCount).toBeGreaterThan(0);

    const readRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 33,
      method: 'resources/read',
      params: { uri: 'lakehouse://metrics/summary' },
    });
    const contents = (readRes?.result as { contents: { text: string }[] }).contents;
    expect(JSON.parse(contents[0].text).rowCount).toBe(5000);
  });
});
