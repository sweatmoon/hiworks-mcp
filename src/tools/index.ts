import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTools } from './read.js';
import { registerSendTools } from './send.js';

export function registerTools(server: McpServer): void {
  registerReadTools(server);
  registerSendTools(server);
}
