import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import type { EventBus } from '../events/bus.js';

export function createSseRouter(
  bus: EventBus,
  options?: { heartbeatIntervalMs?: number }
): Hono {
  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
  const app = new Hono();

  app.get('/api/sse', (c) => {
    const projectId = c.req.query('projectId');

    if (!projectId || projectId === '') {
      return c.json({ error: 'projectId query param required' }, 400);
    }

    // Set SSE headers before the response starts streaming
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    return streamText(c, async (stream) => {
      // Write initial connected comment
      await stream.write(': connected\n\n');

      // Subscribe to event bus
      const unsubscribe = bus.subscribe(async (event) => {
        // Pass if event matches project scope or is a column event (projectId === '')
        if (event.projectId !== projectId && event.projectId !== '') {
          return;
        }
        const line = `event: board\ndata: ${JSON.stringify(event)}\n\n`;
        await stream.write(line);
      });

      // Start heartbeat
      const heartbeat = setInterval(async () => {
        await stream.write(': heartbeat\n\n');
      }, heartbeatIntervalMs);

      // Keep stream open until client disconnects
      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(resolve);
        });
      } finally {
        unsubscribe();
        clearInterval(heartbeat);
      }
    });
  });

  return app;
}
