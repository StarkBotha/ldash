import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../types.js';
import { eventBus as defaultBus } from '../events/bus.js';
import type { EventBus } from '../events/bus.js';
import type Database from 'better-sqlite3';
import { registerProjectTools } from './tools/projects.js';
import { registerItemTools } from './tools/items.js';
import { registerCommentTools } from './tools/comments.js';
import { registerFlagTools } from './tools/flags.js';
import { registerKbTools } from './tools/kb.js';
import { createLogger, redact } from '../logger.js';

const logger = createLogger('mcp');

// Wrap McpServer.tool to add logging around every tool invocation
function wrapMcpServer(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server);

  // McpServer.tool is overloaded; we need to intercept the call and wrap the handler.
  // The handler is always the last argument (a function).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: any[]) => {
    const toolName: string = args[0];
    // Find the handler — last arg that is a function
    let handlerIdx = -1;
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === 'function') { handlerIdx = i; break; }
    }
    if (handlerIdx === -1) {
      // No handler found — pass through unchanged
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    const originalHandler = args[handlerIdx] as (...a: unknown[]) => Promise<unknown>;

    args[handlerIdx] = async (...handlerArgs: unknown[]) => {
      const inputArg = handlerArgs[0];
      logger.debug('tool call', { tool: toolName, args: redact(inputArg as Record<string, unknown>) });
      const start = Date.now();
      try {
        const result = await originalHandler(...handlerArgs);
        const duration_ms = Date.now() - start;
        // isError is part of MCP result shape
        const isErr = (result as { isError?: boolean } | null)?.isError === true;
        if (isErr) {
          logger.warn('tool error', { tool: toolName, duration_ms });
        } else {
          logger.info('tool ok', { tool: toolName, duration_ms });
        }
        return result;
      } catch (err: unknown) {
        const duration_ms = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('tool threw', { tool: toolName, duration_ms, error: msg });
        throw err;
      }
    };

    return (originalTool as (...a: unknown[]) => unknown)(...args);
  };

  return server;
}

export function createMcpServer(services: Services, bus: EventBus = defaultBus, db?: Database.Database): McpServer {
  const server = wrapMcpServer(new McpServer({ name: 'ldash', version: '1.0.0' }));

  registerProjectTools(server, services, bus);
  registerItemTools(server, services, bus, db);
  registerCommentTools(server, services, bus);
  registerFlagTools(server, services, bus);
  registerKbTools(server, services);

  return server;
}
