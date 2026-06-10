import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { EventBus } from '../events/bus.js';
import { createLogger } from '../logger.js';

const logger = createLogger('sse');
let activeConnections = 0;

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

    // Set SSE headers before the response starts streaming.
    // EventSource requires text/event-stream — streamText would send text/plain.
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    return stream(c, async (stream) => {
      activeConnections++;
      logger.info('client connected', { projectId, active_connections: activeConnections });

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
        activeConnections--;
        logger.info('client disconnected', { projectId, active_connections: activeConnections });
      }
    });
  });

  return app;
}
