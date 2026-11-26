import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { NexusMcpServer } from './mcpServer.js';
import type { AuthContext, McpScope } from './types.js';

export interface HttpServerConfig {
  port?: number;
  host?: string;
  tokens: Record<string, AuthContext>;
  rateLimitPerMinute?: number;
}

class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  public allow(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);

    if (timestamps.length >= this.limit) {
      const oldest = timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.buckets.set(key, timestamps);
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);
    return { allowed: true, remaining: this.limit - timestamps.length, retryAfterSec: 0 };
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(new Error('Empty request body'));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Malformed JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

export function createMcpHttpServer(
  config: HttpServerConfig,
  mcpServer = new NexusMcpServer(),
): { server: Server; mcpServer: NexusMcpServer } {
  const rateLimiter = new SlidingWindowRateLimiter(config.rateLimitPerMinute ?? 120);

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Public health check endpoint
    if (method === 'GET' && url === '/health') {
      writeJson(res, 200, {
        status: 'ok',
        service: '@nexus-lake/mcp-lakehouse-server',
        transport: 'streamable-http',
      });
      return;
    }

    // Extract & validate Bearer token
    const authHeader = req.headers.authorization ?? '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      writeJson(res, 401, { error: 'Unauthorized: missing Bearer token' });
      return;
    }

    const token = match[1].trim();
    const auth = config.tokens[token];
    if (!auth) {
      writeJson(res, 401, { error: 'Unauthorized: invalid Bearer token' });
      return;
    }

    // Rate limiting per subject
    const rate = rateLimiter.allow(auth.subject);
    if (!rate.allowed) {
      writeJson(
        res,
        429,
        { error: 'Rate limit exceeded', retryAfterSec: rate.retryAfterSec },
        { 'Retry-After': String(rate.retryAfterSec) },
      );
      return;
    }

    // Admin audit log endpoint
    if (method === 'GET' && url === '/audit') {
      if (!auth.scopes.includes('lakehouse:admin')) {
        writeJson(res, 403, { error: 'Forbidden: requires lakehouse:admin scope' });
        return;
      }
      writeJson(res, 200, { entries: mcpServer.getAuditLog() });
      return;
    }

    // Streamable HTTP MCP Endpoint
    if (method === 'POST' && url === '/mcp') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        writeJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err instanceof Error ? err.message : 'Bad request' },
        });
        return;
      }

      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? randomUUID();
      const rpcResponse = await mcpServer.handleMessage(body, auth);

      if (!rpcResponse) {
        res.writeHead(202, { 'Mcp-Session-Id': sessionId });
        res.end();
        return;
      }

      // Propagate 403 HTTP status on scope violation
      const isForbidden = rpcResponse.error?.code === -32003;
      const status = isForbidden ? 403 : 200;

      const accept = req.headers.accept ?? '';
      if (accept.includes('text/event-stream') && status === 200) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Mcp-Session-Id': sessionId,
          'X-RateLimit-Remaining': String(rate.remaining),
        });
        res.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
        res.end();
        return;
      }

      writeJson(res, status, rpcResponse, {
        'Mcp-Session-Id': sessionId,
        'X-RateLimit-Remaining': String(rate.remaining),
      });
      return;
    }

    writeJson(res, 404, { error: 'Not Found' });
  });

  return { server, mcpServer };
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('httpServer.js') || process.argv[1].endsWith('httpServer.ts'));

if (isDirectRun) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const defaultScopes: McpScope[] = [
    'lakehouse:read',
    'lakehouse:anomaly',
    'lakehouse:export',
    'lakehouse:admin',
  ];
  const devToken = process.env.MCP_BEARER_TOKEN ?? 'nexus-dev-token';
  const { server } = createMcpHttpServer({
    port,
    host,
    tokens: {
      [devToken]: { subject: 'dev-client', scopes: defaultScopes },
    },
  });
  server.listen(port, host, () => {
    console.log(`[nexus-mcp-http] Listening on http://${host}:${port}/mcp`);
  });
}
