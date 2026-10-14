#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PACKAGE_NAME, PACKAGE_VERSION, log } from './config.js';
import { registerTools } from './tools/index.js';

const server = new McpServer({
  name: PACKAGE_NAME,
  version: PACKAGE_VERSION,
});

registerTools(server);

async function main(): Promise<void> {
  log(`Starting ${PACKAGE_NAME} ${PACKAGE_VERSION}...`);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log(`Received ${signal}`);
      process.exit(0);
    });
  }
  process.on('uncaughtException', (error) => {
    log('Uncaught exception:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log('Unhandled rejection:', reason);
    process.exit(1);
  });
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    stream.on('error', (error) => log('stdio error:', error));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Hiworks Mail MCP Server running on stdio');
}

main().catch((error) => {
  log('Fatal error in main():', error);
  process.exit(1);
});
