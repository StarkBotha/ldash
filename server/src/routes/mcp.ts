import { Hono } from 'hono';
import { createMcpHandler } from '../mcp/handler.js';
import type { Services } from '../types.js';

export function createMcpRouter(services: Services): Hono {
  const { handlePost, handleGet } = createMcpHandler(services);
  const app = new Hono();

  app.post('/', handlePost);
  app.get('/', handleGet);

  return app;
}
