import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InMemoryLakehouseEngine } from './datasetEngine.js';
import { validateReadOnlySql } from './sqlGuardrail.js';
import type {
  AuditLogEntry,
  AuthContext,
  JsonRpcRequest,
  JsonRpcResponse,
  McpScope,
} from './types.js';

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

const LakehouseQueryArgsSchema = z.object({
  sql: z.string().min(1, 'sql parameter is required'),
  maxRows: z.number().int().min(1).max(1000).default(100),
});

const LakehouseSchemaArgsSchema = z.object({
  table: z.string().optional(),
});

const DetectAnomaliesArgsSchema = z.object({
  riskThreshold: z.number().min(0).max(1).default(0.75),
  region: z
    .enum(['APAC-VN', 'APAC-SG', 'NA-WEST', 'NA-EAST', 'EU-CENTRAL'])
    .optional(),
  limit: z.number().int().min(1).max(200).default(25),
});

const ExportReportArgsSchema = z.object({
  format: z.enum(['json', 'csv']).default('csv'),
  region: z
    .enum(['APAC-VN', 'APAC-SG', 'NA-WEST', 'NA-EAST', 'EU-CENTRAL'])
    .optional(),
  onlyAnomalies: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(50),
});

const TOOL_REQUIRED_SCOPES: Record<string, McpScope> = {
  lakehouse_query: 'lakehouse:read',
  lakehouse_schema: 'lakehouse:read',
  detect_anomalies: 'lakehouse:anomaly',
  export_report: 'lakehouse:export',
};

export const TOOL_DEFINITIONS = [
  {
    name: 'lakehouse_query',
    description:
      'Execute a strictly read-only OLAP SQL query against the Nexus Lakehouse dataset. Protected by an AST guardrail blocking DDL, DML, and external I/O.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'Read-only SQL statement (SELECT, WITH, EXPLAIN, DESCRIBE, SHOW).',
        },
        maxRows: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 100,
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'lakehouse_schema',
    description: 'Inspect catalog tables, column types, nullability, and row counts.',
    inputSchema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'Optional table name filter.',
        },
      },
    },
  },
  {
    name: 'detect_anomalies',
    description:
      'Run statistical anomaly and high-risk transaction burst detection with regional breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        riskThreshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.75,
        },
        region: {
          type: 'string',
          enum: ['APAC-VN', 'APAC-SG', 'NA-WEST', 'NA-EAST', 'EU-CENTRAL'],
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 25,
        },
      },
    },
  },
  {
    name: 'export_report',
    description:
      'Export filtered lakehouse analytics report as CSV or JSON with SHA-256 content checksum.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['json', 'csv'],
          default: 'csv',
        },
        region: {
          type: 'string',
          enum: ['APAC-VN', 'APAC-SG', 'NA-WEST', 'NA-EAST', 'EU-CENTRAL'],
        },
        onlyAnomalies: {
          type: 'boolean',
          default: false,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 50,
        },
      },
    },
  },
];

export const RESOURCE_DEFINITIONS = [
  {
    uri: 'lakehouse://schema/transactions',
    name: 'Transactions Table Schema',
    description: 'Column definitions and metadata for the primary transactions table.',
    mimeType: 'application/json',
  },
  {
    uri: 'lakehouse://metrics/summary',
    name: 'Lakehouse Live Summary Metrics',
    description: 'Aggregate volume, P50/P99 latency, and anomaly rate.',
    mimeType: 'application/json',
  },
  {
    uri: 'lakehouse://policies/sql-guardrail',
    name: 'Read-Only SQL Guardrail Policy',
    description: 'Active AST guardrail ruleset for safe autonomous AI queries.',
    mimeType: 'application/json',
  },
];

export class NexusMcpServer {
  private readonly engine: InMemoryLakehouseEngine;
  private readonly auditLog: AuditLogEntry[] = [];

  constructor(engine = new InMemoryLakehouseEngine()) {
    this.engine = engine;
  }

  public getAuditLog(): AuditLogEntry[] {
    return [...this.auditLog];
  }

  private recordAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): void {
    this.auditLog.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (this.auditLog.length > 500) {
      this.auditLog.shift();
    }
  }

  public async handleMessage(
    rawPayload: unknown,
    auth?: AuthContext,
  ): Promise<JsonRpcResponse | null> {
    const start = performance.now();
    const parsed = JsonRpcRequestSchema.safeParse(rawPayload);

    if (!parsed.success) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid JSON-RPC 2.0 Request',
          data: parsed.error.flatten(),
        },
      };
    }

    const req: JsonRpcRequest = parsed.data;
    const reqId = req.id ?? null;
    const subject = auth?.subject ?? 'local-stdio';

    // Handle notifications (no id) silently per JSON-RPC 2.0 spec
    if (req.id === undefined && req.method.startsWith('notifications/')) {
      return null;
    }

    try {
      switch (req.method) {
        case 'initialize': {
          this.recordAudit({
            subject,
            method: req.method,
            status: 'ok',
            durationMs: Number((performance.now() - start).toFixed(2)),
          });
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
              },
              serverInfo: {
                name: '@nexus-lake/mcp-lakehouse-server',
                version: '1.0.0',
              },
            },
          };
        }

        case 'ping': {
          return { jsonrpc: '2.0', id: reqId, result: {} };
        }

        case 'tools/list': {
          this.recordAudit({
            subject,
            method: req.method,
            status: 'ok',
            durationMs: Number((performance.now() - start).toFixed(2)),
          });
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: { tools: TOOL_DEFINITIONS },
          };
        }

        case 'tools/call': {
          return this.handleToolCall(reqId, req.params ?? {}, auth, start);
        }

        case 'resources/list': {
          this.recordAudit({
            subject,
            method: req.method,
            status: 'ok',
            durationMs: Number((performance.now() - start).toFixed(2)),
          });
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: { resources: RESOURCE_DEFINITIONS },
          };
        }

        case 'resources/read': {
          const uri = String(req.params?.uri ?? '');
          return this.handleResourceRead(reqId, uri, subject, start);
        }

        default: {
          this.recordAudit({
            subject,
            method: req.method,
            status: 'error',
            durationMs: Number((performance.now() - start).toFixed(2)),
            detail: `Unknown method: ${req.method}`,
          });
          return {
            jsonrpc: '2.0',
            id: reqId,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal server error';
      this.recordAudit({
        subject,
        method: req.method,
        status: 'error',
        durationMs: Number((performance.now() - start).toFixed(2)),
        detail: msg,
      });
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: -32603,
          message: msg,
        },
      };
    }
  }

  private handleToolCall(
    reqId: string | number | null,
    params: Record<string, unknown>,
    auth: AuthContext | undefined,
    start: number,
  ): JsonRpcResponse {
    const subject = auth?.subject ?? 'local-stdio';
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    const requiredScope = TOOL_REQUIRED_SCOPES[toolName];
    if (!requiredScope) {
      this.recordAudit({
        subject,
        method: 'tools/call',
        tool: toolName,
        status: 'error',
        durationMs: Number((performance.now() - start).toFixed(2)),
        detail: `Unknown tool: ${toolName}`,
      });
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: -32602,
          message: `Unknown tool: ${toolName}`,
        },
      };
    }

    // Scope enforcement for HTTP/authenticated callers
    if (
      auth &&
      !auth.scopes.includes('lakehouse:admin') &&
      !auth.scopes.includes(requiredScope)
    ) {
      this.recordAudit({
        subject,
        method: 'tools/call',
        tool: toolName,
        status: 'denied',
        durationMs: Number((performance.now() - start).toFixed(2)),
        detail: `Missing required scope: ${requiredScope}`,
      });
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: -32003,
          message: `Forbidden: token lacks required scope "${requiredScope}" for tool "${toolName}".`,
        },
      };
    }

    if (toolName === 'lakehouse_query') {
      const parsed = LakehouseQueryArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          jsonrpc: '2.0',
          id: reqId,
          error: {
            code: -32602,
            message: 'Invalid arguments for lakehouse_query',
            data: parsed.error.flatten(),
          },
        };
      }

      const guard = validateReadOnlySql(parsed.data.sql);
      if (!guard.allowed) {
        this.recordAudit({
          subject,
          method: 'tools/call',
          tool: toolName,
          status: 'denied',
          durationMs: Number((performance.now() - start).toFixed(2)),
          detail: guard.reason,
        });
        return {
          jsonrpc: '2.0',
          id: reqId,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  blocked: true,
                  reason: guard.reason,
                  blockedKeyword: guard.blockedKeyword,
                }),
              },
            ],
          },
        };
      }

      const result = this.engine.executeReadOnlySql(guard.normalizedSql, parsed.data.maxRows);
      this.recordAudit({
        subject,
        method: 'tools/call',
        tool: toolName,
        status: 'ok',
        durationMs: Number((performance.now() - start).toFixed(2)),
        detail: `Returned ${result.rowCount} rows`,
      });
      return {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        },
      };
    }

    if (toolName === 'lakehouse_schema') {
      const parsed = LakehouseSchemaArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          jsonrpc: '2.0',
          id: reqId,
          error: { code: -32602, message: 'Invalid arguments for lakehouse_schema' },
        };
      }
      const schema = this.engine.getSchema();
      const tables = parsed.data.table
        ? schema.tables.filter((t) => t.name === parsed.data.table)
        : schema.tables;
      const payload = { database: schema.database, tables };
      this.recordAudit({
        subject,
        method: 'tools/call',
        tool: toolName,
        status: 'ok',
        durationMs: Number((performance.now() - start).toFixed(2)),
      });
      return {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        },
      };
    }

    if (toolName === 'detect_anomalies') {
      const parsed = DetectAnomaliesArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          jsonrpc: '2.0',
          id: reqId,
          error: {
            code: -32602,
            message: 'Invalid arguments for detect_anomalies',
            data: parsed.error.flatten(),
          },
        };
      }
      const report = this.engine.detectAnomalies(parsed.data);
      this.recordAudit({
        subject,
        method: 'tools/call',
        tool: toolName,
        status: 'ok',
        durationMs: Number((performance.now() - start).toFixed(2)),
        detail: `Matched ${report.matchedAnomalies} anomalies`,
      });
      return {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
          structuredContent: report,
        },
      };
    }

    // export_report
    const parsed = ExportReportArgsSchema.safeParse(args);
    if (!parsed.success) {
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: -32602,
          message: 'Invalid arguments for export_report',
          data: parsed.error.flatten(),
        },
      };
    }

    const whereParts: string[] = [];
    if (parsed.data.region) whereParts.push(`region = '${parsed.data.region}'`);
    if (parsed.data.onlyAnomalies) whereParts.push(`is_anomaly = true`);
    const sql =
      `SELECT * FROM transactions` +
      (whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : '') +
      ` ORDER BY risk_score DESC LIMIT ${parsed.data.limit}`;

    const queryRes = this.engine.executeReadOnlySql(sql, parsed.data.limit);
    let body = '';
    if (parsed.data.format === 'csv') {
      const header = queryRes.columns.join(',');
      const lines = queryRes.rows.map((r) =>
        queryRes.columns.map((c) => JSON.stringify(r[c] ?? '')).join(','),
      );
      body = [header, ...lines].join('\n');
    } else {
      body = JSON.stringify(queryRes.rows, null, 2);
    }

    const sha256 = createHash('sha256').update(body).digest('hex');
    const exportPayload = {
      format: parsed.data.format,
      rowCount: queryRes.rowCount,
      sha256,
      data: body,
    };

    this.recordAudit({
      subject,
      method: 'tools/call',
      tool: toolName,
      status: 'ok',
      durationMs: Number((performance.now() - start).toFixed(2)),
      detail: `Exported ${queryRes.rowCount} rows (${parsed.data.format})`,
    });

    return {
      jsonrpc: '2.0',
      id: reqId,
      result: {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(exportPayload, null, 2) }],
        structuredContent: exportPayload,
      },
    };
  }

  private handleResourceRead(
    reqId: string | number | null,
    uri: string,
    subject: string,
    start: number,
  ): JsonRpcResponse {
    let payload: unknown;

    if (uri === 'lakehouse://schema/transactions') {
      payload = this.engine.getSchema();
    } else if (uri === 'lakehouse://metrics/summary') {
      payload = this.engine.getSummaryMetrics();
    } else if (uri === 'lakehouse://policies/sql-guardrail') {
      payload = {
        mode: 'STRICT_READ_ONLY',
        allowedStatements: ['SELECT', 'WITH', 'EXPLAIN', 'DESCRIBE', 'SHOW'],
        multiStatementBlocked: true,
        externalIoBlocked: true,
      };
    } else {
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: -32002,
          message: `Resource not found: ${uri}`,
        },
      };
    }

    this.recordAudit({
      subject,
      method: 'resources/read',
      status: 'ok',
      durationMs: Number((performance.now() - start).toFixed(2)),
      detail: uri,
    });

    return {
      jsonrpc: '2.0',
      id: reqId,
      result: {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      },
    };
  }
}
