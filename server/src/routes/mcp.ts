import { Hono } from 'hono';
import { createMcpHandler } from '../mcp/handler.js';
import type { Services } from '../types.js';
import { eventBus as defaultBus } from '../events/bus.js';
import type { EventBus } from '../events/bus.js';

export function createMcpRouter(services: Services, bus: EventBus = defaultBus): Hono {
  const { handlePost, handleGet } = createMcpHandler(services, bus);
  const app = new Hono();

  app.post('/', handlePost);
  app.get('/', handleGet);

  return app;
}
