import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, req } from './helpers.js';
import type { Hono } from 'hono';
import type { Column, Item, Comment, ActivityEntry } from '../types.js';

let app: Hono;
let projectId: string;
let itemId: string;

beforeEach(async () => {
  ({ app } = createTestApp());
  const { body: cols } = await req(app, 'GET', '/api/columns');
  const colId = (cols as Column[])[0].id;
  const { body: project } = await req(app, 'POST', '/api/projects', { name: 'CommentProj' });
  projectId = (project as { id: string }).id;
  const { body: item } = await req(app, 'POST', '/api/items', {
    project_id: projectId, type: 'task', title: 'CommentItem', column_id: colId,
  });
  itemId = (item as Item).id;
});

describe('Comments', () => {
  it('AC39: POST /api/comments creates comment with correct shape', async () => {
    const { status, body } = await req(app, 'POST', '/api/comments', {
      item_id: itemId,
      body: 'Looks good',
    });
    expect(status).toBe(201);
    const comment = body as Comment;
    expect(comment.id).toBeTruthy();
    expect(comment.author).toBe('user');
    expect(comment.body).toBe('Looks good');
  });

  it('AC40: POST /api/comments with empty body returns 400', async () => {
    const { status } = await req(app, 'POST', '/api/comments', {
      item_id: itemId,
      body: '',
    });
    expect(status).toBe(400);
  });

  it('AC41: POST /api/comments with nonexistent item_id returns 404', async () => {
    const { status } = await req(app, 'POST', '/api/comments', {
      item_id: 'no-such-item',
      body: 'Hello',
    });
    expect(status).toBe(404);
  });

  it('AC42: GET /api/items/:itemId/comments returns comments oldest-first', async () => {
    await req(app, 'POST', '/api/comments', { item_id: itemId, body: 'First' });
    await req(app, 'POST', '/api/comments', { item_id: itemId, body: 'Second' });

    const { status, body } = await req(app, 'GET', `/api/items/${itemId}/comments`);
    expect(status).toBe(200);
    const comments = body as Comment[];
    expect(comments).toHaveLength(2);
    expect(comments[0].body).toBe('First');
    expect(comments[1].body).toBe('Second');
  });

  it('AC43: DELETE /api/comments/:id returns 204 and comment disappears from list', async () => {
    const { body: created } = await req(app, 'POST', '/api/comments', {
      item_id: itemId, body: 'Delete me',
    });
    const comment = created as Comment;
    const { status: delStatus } = await req(app, 'DELETE', `/api/comments/${comment.id}`);
    expect(delStatus).toBe(204);

    const { body: listBody } = await req(app, 'GET', `/api/items/${itemId}/comments`);
    expect((listBody as Comment[]).find((c) => c.id === comment.id)).toBeUndefined();
  });

  it('AC44: Creating a comment writes comment.created activity entry', async () => {
    await req(app, 'POST', '/api/comments', { item_id: itemId, body: 'Activity comment' });

    const { body: actBody } = await req(app, 'GET', `/api/items/${itemId}/activity`);
    const entries = (actBody as { entries: ActivityEntry[] }).entries;
    expect(entries.some((e) => e.event_type === 'comment.created')).toBe(true);
  });
});
