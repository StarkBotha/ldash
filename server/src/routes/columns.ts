import { Hono } from 'hono';
import type { ColumnService } from '../services/columns.js';
import type { ActivityService } from '../services/activity.js';
import { EventTypes } from '../types.js';

function makeError(msg: string, status: number): Error {
  const err = new Error(msg) as Error & { status: number };
  err.status = status;
  return err;
}

export function columnsRouter(
  columnService: ColumnService,
  activityService: ActivityService
): Hono {
  const app = new Hono();

  // GET /api/columns
  app.get('/', (c) => {
    const columns = columnService.list();
    return c.json(columns);
  });

  // POST /api/columns/reorder — must be before /:id routes
  app.post('/reorder', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { order } = body as { order?: unknown };

    if (!order || !Array.isArray(order)) {
      throw makeError('order must be a non-empty array of column ids', 400);
    }

    const existing = columnService.list();
    const existingIds = new Set(existing.map((col) => col.id));

    if (order.length !== existing.length) {
      throw makeError('order must include all existing column ids', 400);
    }

    for (const id of order) {
      if (typeof id !== 'string' || !existingIds.has(id)) {
        throw makeError(`Unknown column id: ${id}`, 400);
      }
    }

    const updated = columnService.reorder(order as string[]);

    activityService.append({
      event_type: EventTypes.COLUMN_REORDERED,
      payload: { order },
    });

    return c.json(updated);
  });

  // POST /api/columns
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { name } = body as { name?: unknown };

    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw makeError('name is required and must be a non-empty string', 400);
    }

    const column = columnService.create({ name: name.trim() });

    activityService.append({
      event_type: EventTypes.COLUMN_CREATED,
      payload: { name: column.name },
    });

    return c.json(column, 201);
  });

  // PATCH /api/columns/:id
  app.patch('/:id', async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const { name } = body as { name?: unknown };

    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw makeError('name is required and must be a non-empty string', 400);
    }

    const existing = columnService.get(id);
    if (!existing) {
      throw makeError('Column not found', 404);
    }

    const oldName = existing.name;
    const updated = columnService.update(id, { name: name.trim() });

    activityService.append({
      event_type: EventTypes.COLUMN_UPDATED,
      payload: { fields: { old: { name: oldName }, new: { name: updated.name } } },
    });

    return c.json(updated);
  });

  // DELETE /api/columns/:id
  app.delete('/:id', (c) => {
    const { id } = c.req.param();

    const existing = columnService.get(id);
    if (!existing) {
      throw makeError('Column not found', 404);
    }

    const itemCount = columnService.countItems(id);

    if (itemCount > 0) {
      throw makeError('Column has items; move them first.', 409);
    }

    columnService.delete(id);
    return new Response(null, { status: 204 });
  });

  return app;
}
