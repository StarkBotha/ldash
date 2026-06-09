import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../types.js';
import { registerProjectTools } from './tools/projects.js';
import { registerItemTools } from './tools/items.js';
import { registerCommentTools } from './tools/comments.js';
import { registerFlagTools } from './tools/flags.js';

export function createMcpServer(services: Services): McpServer {
  const server = new McpServer({ name: 'ldash', version: '1.0.0' });

  registerProjectTools(server, services);
  registerItemTools(server, services);
  registerCommentTools(server, services);
  registerFlagTools(server, services);

  return server;
}
