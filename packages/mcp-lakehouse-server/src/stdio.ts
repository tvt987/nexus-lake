#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { NexusMcpServer } from './mcpServer.js';

export function startStdioServer(server = new NexusMcpServer()): void {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const payload = JSON.parse(trimmed);
      const response = await server.handleMessage(payload);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch {
      const parseErr = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON payload' },
      };
      process.stdout.write(`${JSON.stringify(parseErr)}\n`);
    }
  });
}

// Run when invoked directly via CLI
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('stdio.js') || process.argv[1].endsWith('stdio.ts'));

if (isDirectRun) {
  startStdioServer();
}
