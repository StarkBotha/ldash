import { Hono } from 'hono';
import type { SettingsService } from '../services/settings.js';
import { fetchModels } from '../services/modelsService.js';

export function createModelsRouter(settings: SettingsService): Hono {
  const app = new Hono();

  app.post('/api/models', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const parsed = body as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const providerType = parsed.type as string;
    if (providerType !== 'claude-subscription' && providerType !== 'openai-compatible') {
      return c.json({ error: 'Invalid provider type' }, 400);
    }

    const result = await fetchModels(parsed, settings);
    return c.json(result);
  });

  return app;
}
