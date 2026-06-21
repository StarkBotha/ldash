import { Hono } from 'hono';
import type { ItemService } from '../services/items.js';
import type { ProjectService } from '../services/projects.js';
import type { ColumnService } from '../services/columns.js';
import type { ActivityService } from '../services/activity.js';
import { EventTypes, ITEM_TYPES, isWorkItemType, type ItemType } from '../types.js';
import { eventBus as defaultBus } from '../events/bus.js';
import type { EventBus } from '../events/bus.js';
import { recomputeAncestors, recomputeAncestorsByParent } from '../services/rollup.js';
import type Database from 'better-sqlite3';

const VALID_TYPES = new Set<string>(ITEM_TYPES);

function makeError(msg: string, status: number): Error {
  const err = new Error(msg) as Error & { status: number };
  err.status = status;
  return err;
}

export function itemsRouter(
  itemService: ItemService,
  projectService: ProjectService,
  columnService: ColumnService,
  activityService: ActivityService,
  bus: EventBus = defaultBus,
  db?: Database.Database
): Hono {
  const app = new Hono();

  // GET /api/projects/:projectId/items  — mounted at /api/projects via the parent app
  // This sub-router handles the /api/items prefix directly.

  // GET /api/items/:id
  app.get('/:id', (c) => {
    const { id } = c.req.param();
    const item = itemService.get(id);
    if (!item) {
      throw makeError('Item not found', 404);
    }
    return c.json(item);
  });

  // POST /api/items
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { project_id, parent_id, type, title, description, column_id } = body as {
      project_id?: unknown;
      parent_id?: unknown;
      type?: unknown;
      title?: unknown;
      description?: unknown;
      column_id?: unknown;
    };

    if (!project_id || typeof project_id !== 'string') {
      throw makeError('project_id is required', 400);
    }

    const project = projectService.get(project_id);
    if (!project) {
      throw makeError('Project not found', 404);
    }

    if (!column_id || typeof column_id !== 'string') {
      throw makeError('column_id is required', 400);
    }

    const column = columnService.get(column_id);
    if (!column) {
      throw makeError('column_id does not reference an existing column', 400);
    }

    if (!type || typeof type !== 'string' || !VALID_TYPES.has(type)) {
      throw makeError('type must be one of: epic, story, task, bug, investigation', 400);
    }

    if (!title || typeof title !== 'string' || title.trim() === '') {
      throw makeError('title is required and must be a non-empty string', 400);
    }

    if (parent_id !== undefined && parent_id !== null) {
      if (typeof parent_id !== 'string') {
        throw makeError('parent_id must be a string or null', 400);
      }
      const parentItem = itemService.get(parent_id);
      if (!parentItem || parentItem.project_id !== project_id) {
        throw makeError('parent_id must reference an existing item in the same project', 400);
      }
    }

    const item = itemService.create({
      project_id,
      parent_id: typeof parent_id === 'string' ? parent_id : null,
      type: type as ItemType,
      title: title.trim(),
      description: typeof description === 'string' ? description : '',
      column_id,
    });

    activityService.append({
      project_id,
      item_id: item.id,
      event_type: EventTypes.ITEM_CREATED,
      payload: { title: item.title, type: item.type, column_id: item.column_id },
    });

    bus.emit({
      type: 'item.created',
      projectId: item.project_id,
      entityId: item.id,
      data: { item },
    });

    // Rollup: after a work item is created, recompute ancestor story/epic status
    if (isWorkItemType(item.type) && db) {
      recomputeAncestors(item.id, db, itemService, activityService, columnService, bus);
    }

    return c.json(item, 201);
  });

  // PATCH /api/items/:id
  app.patch('/:id', async (c) => {
    const { id } = c.req.param();

    const existing = itemService.get(id);
    if (!existing) {
      throw makeError('Item not found', 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const { title, description, parent_id, type } = body as {
      title?: unknown;
      description?: unknown;
      parent_id?: unknown;
      type?: unknown;
    };

    const updateData: Partial<{ title: string; description: string; parent_id: string | null; type: ItemType }> = {};
    const oldFields: Record<string, unknown> = {};
    const newFields: Record<string, unknown> = {};

    if (type !== undefined) {
      if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
        throw makeError('type must be one of: epic, story, task, bug, investigation', 400);
      }
      if (type !== existing.type && (!isWorkItemType(existing.type) || !isWorkItemType(type))) {
        throw makeError(
          `Type can only be changed between work item types (task, bug, investigation) — cannot convert ${existing.type} to ${type}`,
          409
        );
      }
      updateData.type = type as ItemType;
      oldFields.type = existing.type;
      newFields.type = type;
    }

    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim() === '') {
        throw makeError('title must be a non-empty string', 400);
      }
      updateData.title = title.trim();
      oldFields.title = existing.title;
      newFields.title = updateData.title;
    }

    if (description !== undefined) {
      if (typeof description !== 'string') {
        throw makeError('description must be a string', 400);
      }
      updateData.description = description;
      oldFields.description = existing.description;
      newFields.description = description;
    }

    if ('parent_id' in body) {
      const pid = (body as { parent_id: unknown }).parent_id;
      if (pid !== null && pid !== undefined) {
        if (typeof pid !== 'string') {
          throw makeError('parent_id must be a string or null', 400);
        }
        const parentItem = itemService.get(pid);
        if (!parentItem || parentItem.project_id !== existing.project_id) {
          throw makeError('parent_id must reference an existing item in the same project', 400);
        }
        updateData.parent_id = pid;
      } else {
        updateData.parent_id = null;
      }
      oldFields.parent_id = existing.parent_id;
      newFields.parent_id = updateData.parent_id ?? null;
    }

    if (Object.keys(updateData).length === 0) {
      throw makeError('Body must contain at least one of: title, description, parent_id, type', 400);
    }

    let updated;
    try {
      updated = itemService.update(id, updateData);
    } catch (err) {
      if (err instanceof Error && /own parent|parent cycle/.test(err.message)) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }

    activityService.append({
      project_id: existing.project_id,
      item_id: id,
      event_type: EventTypes.ITEM_UPDATED,
      payload: { fields: { old: oldFields, new: newFields } },
    });

    bus.emit({
      type: 'item.updated',
      projectId: existing.project_id,
      entityId: id,
      data: { item: updated },
    });

    return c.json(updated);
  });

  // PATCH /api/items/:id/move
  app.patch('/:id/move', async (c) => {
    const { id } = c.req.param();

    const existing = itemService.get(id);
    if (!existing) {
      throw makeError('Item not found', 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const { column_id, position } = body as { column_id?: unknown; position?: unknown };

    if (!column_id || typeof column_id !== 'string') {
      throw makeError('column_id is required', 400);
    }

    const targetColumn = columnService.get(column_id);
    if (!targetColumn) {
      throw makeError('column_id does not reference an existing column', 400);
    }

    const fromColumn = columnService.get(existing.column_id);

    let updated;
    try {
      updated = itemService.move(id, {
        column_id,
        position: typeof position === 'number' ? position : undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Status of a ')) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }

    activityService.append({
      project_id: existing.project_id,
      item_id: id,
      event_type: EventTypes.ITEM_MOVED,
      payload: {
        from_column_id: existing.column_id,
        to_column_id: column_id,
        from_column_name: fromColumn?.name ?? existing.column_id,
        to_column_name: targetColumn.name,
      },
    });

    bus.emit({
      type: 'item.moved',
      projectId: existing.project_id,
      entityId: id,
      data: { item: updated, fromColumnId: existing.column_id, toColumnId: column_id },
    });

    // Rollup: after a successful work item move, recompute ancestor story/epic status
    if (isWorkItemType(existing.type) && db) {
      recomputeAncestors(id, db, itemService, activityService, columnService, bus);
    }

    return c.json(updated);
  });

  // PATCH /api/items/:id/flag
  app.patch('/:id/flag', async (c) => {
    const { id } = c.req.param();

    const existing = itemService.get(id);
    if (!existing) {
      throw makeError('Item not found', 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const { flagged } = body as { flagged?: unknown };

    if (typeof flagged !== 'boolean') {
      throw makeError('flagged must be a boolean', 400);
    }

    const updated = itemService.setFlag(id, flagged);

    activityService.append({
      project_id: existing.project_id,
      item_id: id,
      event_type: flagged ? EventTypes.ITEM_FLAGGED : EventTypes.ITEM_UNFLAGGED,
      payload: { flagged },
    });

    bus.emit({
      type: flagged ? 'item.flagged' : 'item.unflagged',
      projectId: existing.project_id,
      entityId: id,
      data: { item: updated },
    });

    return c.json(updated);
  });

  // PATCH /api/items/:id/block
  app.patch('/:id/block', async (c) => {
    const { id } = c.req.param();

    const existing = itemService.get(id);
    if (!existing) {
      throw makeError('Item not found', 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const { blocked, reason } = body as { blocked?: unknown; reason?: unknown };

    if (typeof blocked !== 'boolean') {
      throw makeError('blocked must be a boolean', 400);
    }

    if (blocked && (!reason || typeof reason !== 'string' || reason.trim() === '')) {
      throw makeError('reason is required when blocking an item', 400);
    }

    const resolvedReason = blocked ? (reason as string).trim() : '';
    const updated = itemService.setBlock(id, blocked, resolvedReason);

    activityService.append({
      project_id: existing.project_id,
      item_id: id,
      event_type: blocked ? EventTypes.ITEM_BLOCKED : EventTypes.ITEM_UNBLOCKED,
      payload: blocked ? { blocked: true, reason: resolvedReason } : { blocked: false },
    });

    bus.emit({
      type: blocked ? 'item.blocked' : 'item.unblocked',
      projectId: existing.project_id,
      entityId: id,
      data: { item: updated },
    });

    return c.json(updated);
  });

  // DELETE /api/items/:id
  app.delete('/:id', (c) => {
    const { id } = c.req.param();

    const existing = itemService.get(id);
    if (!existing) {
      throw makeError('Item not found', 404);
    }

    // Capture parent_id before deletion for rollup
    const deletedParentId = isWorkItemType(existing.type) ? existing.parent_id : null;
    const deletedProjectId = existing.project_id;

    // Write activity BEFORE deletion
    activityService.append({
      project_id: existing.project_id,
      item_id: id,
      event_type: EventTypes.ITEM_DELETED,
      payload: { title: existing.title, type: existing.type },
    });

    itemService.delete(id);

    bus.emit({
      type: 'item.deleted',
      projectId: existing.project_id,
      entityId: id,
      data: { itemId: id, title: existing.title, type: existing.type },
    });

    // Rollup: after a task deletion, recompute ancestor story/epic status.
    // We use a sibling task of the same parent (if any) as the proxy taskId.
    // If no siblings exist, use recomputeAncestors with a synthetic approach:
    // create a proxy item lookup by parent.
    if (isWorkItemType(existing.type) && deletedParentId && db) {
      const siblings = itemService
        .listFiltered({
          project_id: deletedProjectId,
          parent_id: deletedParentId,
        })
        .filter((i) => isWorkItemType(i.type));
      if (siblings.length > 0) {
        recomputeAncestors(siblings[0].id, db, itemService, activityService, columnService, bus);
      } else {
        // No sibling tasks — recompute parent using recomputeAncestorsByParent
        recomputeAncestorsByParent(deletedParentId, deletedProjectId, db, itemService, activityService, columnService, bus);
      }
    }

    return new Response(null, { status: 204 });
  });

  return app;
}

export function projectItemsRouter(
  itemService: ItemService,
  projectService: ProjectService,
  activityService: ActivityService
): Hono {
  const app = new Hono();

  // GET /api/projects/:projectId/items
  app.get('/', (c) => {
    // The projectId is available from the parent route param context
    const projectId = c.req.param('projectId') as string;
    const project = projectService.get(projectId);
    if (!project) {
      throw makeError('Project not found', 404);
    }
    return c.json(itemService.listByProject(projectId));
  });

  return app;
}
