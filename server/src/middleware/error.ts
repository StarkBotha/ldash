import type { Context } from 'hono';

export function onError(err: Error, c: Context) {
  const status = (err as Error & { status?: number }).status ?? 500;
  return c.json({ error: err.message }, status as 400 | 404 | 409 | 500);
}
