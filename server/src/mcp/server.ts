import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../types.js';
import { eventBus as defaultBus } from '../events/bus.js';
import type { EventBus } from '../events/bus.js';
import { registerProjectTools } from './tools/projects.js';
import { registerItemTools } from './tools/items.js';
import { registerCommentTools } from './tools/comments.js';
import { registerFlagTools } from './tools/flags.js';

export function createMcpServer(services: Services, bus: EventBus = defaultBus): McpServer {
  const server = new McpServer({ name: 'ldash', version: '1.0.0' });

  registerProjectTools(server, services);
  registerItemTools(server, services, bus);
  registerCommentTools(server, services, bus);
  registerFlagTools(server, services, bus);

  return server;
}
