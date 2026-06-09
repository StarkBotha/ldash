import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, req } from './helpers.js';
import type { Hono } from 'hono';
import type { Column } from '../types.js';

let app: Hono;

beforeEach(() => {
  ({ app } = createTestApp());
});

describe('Columns', () => {
  it('AC11: GET /api/columns returns 4 default columns in order', async () => {
    const { status, body } = await req(app, 'GET', '/api/columns');
    expect(status).toBe(200);
    const cols = body as Column[];
    expect(cols).toHaveLength(4);
    expect(cols[0].name).toBe('Backlog');
    expect(cols[1].name).toBe('In Progress');
    expect(cols[2].name).toBe('Review');
    expect(cols[3].name).toBe('Done');
  });

  it('AC12: POST /api/columns adds column at end (position 4)', async () => {
    const { status, body } = await req(app, 'POST', '/api/columns', { name: 'QA' });
    expect(status).toBe(201);
    const col = body as Column;
    expect(col.name).toBe('QA');
    expect(col.position).toBe(4);
  });

  it('AC13: POST /api/columns with missing name returns 400', async () => {
    const { status } = await req(app, 'POST', '/api/columns', {});
    expect(status).toBe(400);
  });

  it('AC14: PATCH /api/columns/:id renames column', async () => {
    const { body: cols } = await req(app, 'GET', '/api/columns');
    const col = (cols as Column[])[1];
    const { status, body } = await req(app, 'PATCH', `/api/columns/${col.id}`, { name: 'In Review' });
    expect(status).toBe(200);
    expect((body as Column).name).toBe('In Review');
  });

  it('AC15: POST /api/columns/reorder with valid array returns 200 in new order', async () => {
    const { body: cols } = await req(app, 'GET', '/api/columns');
    const colList = cols as Column[];
    const reversed = [...colList].reverse().map((c) => c.id);
    const { status, body } = await req(app, 'POST', '/api/columns/reorder', { order: reversed });
    expect(status).toBe(200);
    const updated = body as Column[];
    expect(updated[0].id).toBe(reversed[0]);
    expect(updated[1].id).toBe(reversed[1]);
  });

  it('AC16: POST /api/columns/reorder with missing id returns 400', async () => {
    const { status } = await req(app, 'POST', '/api/columns/reorder', { order: ['nonexistent-id'] });
    expect(status).toBe(400);
  });

  it('AC17: DELETE /api/columns/:id with no items returns 204', async () => {
    const { body: created } = await req(app, 'POST', '/api/columns', { name: 'Temp' });
    const col = created as Column;
    const { status } = await req(app, 'DELETE', `/api/columns/${col.id}`);
    expect(status).toBe(204);
  });

  it('AC18: DELETE /api/columns/:id with items returns 409 with move message', async () => {
    // Create project + item in first column
    const { body: project } = await req(app, 'POST', '/api/projects', { name: 'P' });
    const { body: cols } = await req(app, 'GET', '/api/columns');
    const firstCol = (cols as Column[])[0];

    await req(app, 'POST', '/api/items', {
      project_id: (project as { id: string }).id,
      type: 'task',
      title: 'Blocker',
      column_id: firstCol.id,
    });

    const { status, body } = await req(app, 'DELETE', `/api/columns/${firstCol.id}`);
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain('move them first');
  });
});
