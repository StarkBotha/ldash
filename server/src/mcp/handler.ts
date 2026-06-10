import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import { createMcpServer } from './server.js';
import type { Services } from '../types.js';
import { eventBus as defaultBus } from '../events/bus.js';
import type { EventBus } from '../events/bus.js';
import type Database from 'better-sqlite3';

export function createMcpHandler(services: Services, bus: EventBus = defaultBus, db?: Database.Database): {
  handlePost: (c: Context) => Promise<Response>;
  handleGet: (c: Context) => Promise<Response>;
} {
  const handlePost = async (c: Context): Promise<Response> => {
    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // Stateless mode: create a new server + transport per request
    const server = createMcpServer(services, bus, db);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw, { parsedBody });
    return response;
  };

  const handleGet = async (c: Context): Promise<Response> => {
    // Stateless mode: create a new server + transport per request
    const server = createMcpServer(services, bus, db);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    return response;
  };

  return { handlePost, handleGet };
}
