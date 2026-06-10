import type { MiddlewareHandler } from 'hono';
import { createLogger } from '../logger.js';

const logger = createLogger('http');

// Routes whose responses are streaming — skip body logging, log only start/end
const STREAMING_PATHS = [
  '/api/conversations/',
  '/api/projects/',  // covers planning route pattern
];

function isStreamingPath(path: string): boolean {
  // planning: POST /api/projects/:id/planning/messages
  // chat:     POST /api/conversations/:id/messages
  if (path.includes('/planning/messages') || path.includes('/conversations/')) {
    return true;
  }
  return false;
}

export const httpLoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;

  // Skip SSE route entirely — it's a long-lived connection
  if (path === '/api/sse') {
    return next();
  }

  const start = Date.now();
  const method = c.req.method;

  const streaming = isStreamingPath(path) && c.req.method === 'POST';

  if (streaming) {
    logger.debug('stream start', { method, path });
  }

  await next();

  const status = c.res.status;
  const duration_ms = Date.now() - start;

  const fields = { method, path, status, duration_ms };

  if (status >= 500) {
    logger.error('request', fields);
  } else if (status >= 400) {
    logger.warn('request', fields);
  } else {
    if (streaming) {
      logger.info('stream end', fields);
    } else {
      logger.info('request', fields);
    }
  }
};
