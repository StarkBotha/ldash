import { Hono } from 'hono';
import type { ActivityService } from '../services/activity.js';
import type { ProjectService } from '../services/projects.js';
import type { ItemService } from '../services/items.js';

function makeError(msg: string, status: number): Error {
  const err = new Error(msg) as Error & { status: number };
  err.status = status;
  return err;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function projectActivityRouter(
  activityService: ActivityService,
  projectService: ProjectService
): Hono {
  const app = new Hono();

  // GET /api/projects/:projectId/activity
  app.get('/', (c) => {
    const projectId = c.req.param('projectId') as string;
    const project = projectService.get(projectId);
    if (!project) {
      throw makeError('Project not found', 404);
    }

    const limit = parseLimit(c.req.query('limit'));
    const before = c.req.query('before');

    const entries = activityService.listByProject(projectId, { limit, before: before ?? undefined });
    const next_before = entries.length < limit ? null : entries[entries.length - 1]?.created_at ?? null;

    return c.json({ entries, next_before });
  });

  return app;
}

export function itemActivityRouter(
  activityService: ActivityService,
  itemService: ItemService
): Hono {
  const app = new Hono();

  // GET /api/items/:itemId/activity
  app.get('/', (c) => {
    const itemId = c.req.param('itemId') as string;
    const item = itemService.get(itemId);
    if (!item) {
      throw makeError('Item not found', 404);
    }

    const limit = parseLimit(c.req.query('limit'));
    const before = c.req.query('before');

    const entries = activityService.listByItem(itemId, { limit, before: before ?? undefined });
    const next_before = entries.length < limit ? null : entries[entries.length - 1]?.created_at ?? null;

    return c.json({ entries, next_before });
  });

  return app;
}
