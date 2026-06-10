import type { Context } from 'hono';
import { createLogger } from '../logger.js';

const logger = createLogger('http');

export function onError(err: Error, c: Context) {
  const status = (err as Error & { status?: number }).status ?? 500;
  logger.error('unhandled error', {
    method: c.req.method,
    path: c.req.path,
    status,
    error: err.message,
    stack: err.stack,
  });
  return c.json({ error: err.message }, status as 400 | 404 | 409 | 500);
}
