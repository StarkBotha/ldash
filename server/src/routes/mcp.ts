import { Hono } from 'hono';
import { createMcpHandler } from '../mcp/handler.js';
import type { Services } from '../types.js';
import { eventBus as defaultBus } from '../events/bus.js';
import type { EventBus } from '../events/bus.js';
import type Database from 'better-sqlite3';

export function createMcpRouter(services: Services, bus: EventBus = defaultBus, db?: Database.Database): Hono {
  const { handlePost, handleGet } = createMcpHandler(services, bus, db);
  const app = new Hono();

  app.post('/', handlePost);
  app.get('/', handleGet);

  return app;
}
