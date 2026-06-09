import { Hono } from 'hono';
import type { CommentService } from '../services/comments.js';
import type { ItemService } from '../services/items.js';
import type { ActivityService } from '../services/activity.js';
import { EventTypes } from '../types.js';
import { eventBus as defaultBus } from '../events/bus.js';
import type { EventBus } from '../events/bus.js';

function makeError(msg: string, status: number): Error {
  const err = new Error(msg) as Error & { status: number };
  err.status = status;
  return err;
}

export function commentsRouter(
  commentService: CommentService,
  itemService: ItemService,
  activityService: ActivityService,
  bus: EventBus = defaultBus
): Hono {
  const app = new Hono();

  // POST /api/comments
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { item_id, body: commentBody, author } = body as {
      item_id?: unknown;
      body?: unknown;
      author?: unknown;
    };

    if (!item_id || typeof item_id !== 'string') {
      throw makeError('item_id is required', 400);
    }

    if (!commentBody || typeof commentBody !== 'string' || commentBody.trim() === '') {
      throw makeError('body is required and must be non-empty', 400);
    }

    const item = itemService.get(item_id);
    if (!item) {
      throw makeError('Item not found', 404);
    }

    const comment = commentService.create({
      item_id,
      body: commentBody.trim(),
      author: typeof author === 'string' ? author : 'user',
    });

    activityService.append({
      project_id: item.project_id,
      item_id,
      event_type: EventTypes.COMMENT_CREATED,
      payload: { comment_id: comment.id, author: comment.author },
    });

    bus.emit({
      type: 'comment.created',
      projectId: item.project_id,
      entityId: comment.id,
      data: { comment },
    });

    return c.json(comment, 201);
  });

  // DELETE /api/comments/:id
  app.delete('/:id', (c) => {
    const { id } = c.req.param();
    const existing = commentService.get(id);
    if (!existing) {
      throw makeError('Comment not found', 404);
    }
    commentService.delete(id);
    return new Response(null, { status: 204 });
  });

  return app;
}

export function itemCommentsRouter(
  commentService: CommentService,
  itemService: ItemService
): Hono {
  const app = new Hono();

  // GET /api/items/:itemId/comments
  app.get('/', (c) => {
    const itemId = c.req.param('itemId') as string;
    const item = itemService.get(itemId);
    if (!item) {
      throw makeError('Item not found', 404);
    }
    return c.json(commentService.listByItem(itemId));
  });

  return app;
}
