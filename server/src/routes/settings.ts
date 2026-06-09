import { Hono } from 'hono';
import type { SettingsService } from '../services/settings.js';

export function createSettingsRouter(settings: SettingsService): Hono {
  const app = new Hono();

  app.get('/api/settings', (c) => {
    const masked = settings.getMaskedGatewaySettings();
    return c.json(masked);
  });

  app.put('/api/settings', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid settings body' }, 400);
    }

    const parsed = body as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
      return c.json({ error: 'Invalid settings body' }, 400);
    }
    if (parsed.activeProvider !== null && typeof parsed.activeProvider !== 'string') {
      return c.json({ error: 'Invalid settings body' }, 400);
    }

    try {
      settings.setGatewaySettings(parsed as unknown as Parameters<SettingsService['setGatewaySettings']>[0]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }

    return c.json(settings.getMaskedGatewaySettings());
  });

  return app;
}
