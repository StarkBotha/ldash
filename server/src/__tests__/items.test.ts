import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, req } from './helpers.js';
import type { Hono } from 'hono';
import type { Column, Item, ActivityEntry } from '../types.js';

let app: Hono;
let firstColId: string;
let secondColId: string;
let projectId: string;

beforeEach(async () => {
  ({ app } = createTestApp());
  const { body: cols } = await req(app, 'GET', '/api/columns');
  firstColId = (cols as Column[])[0].id;
  secondColId = (cols as Column[])[1].id;
  const { body: project } = await req(app, 'POST', '/api/projects', { name: 'Test Project' });
  projectId = (project as { id: string }).id;
});

describe('Items', () => {
  it('AC19: POST /api/items with valid fields returns 201 with correct defaults', async () => {
    const { status, body } = await req(app, 'POST', '/api/items', {
      project_id: projectId,
      type: 'task',
      title: 'First Task',
      column_id: firstColId,
    });
    expect(status).toBe(201);
    const item = body as Item;
    expect(item.id).toBeTruthy();
    expect(item.position).toBe(0);
    expect(item.flagged).toBe(false);
    expect(item.blocked).toBe(false);
  });

  it('AC20: POST /api/items with nonexistent project_id returns 404', async () => {
    const { status } = await req(app, 'POST', '/api/items', {
      project_id: 'no-such-project',
      type: 'task',
      title: 'T',
      column_id: firstColId,
    });
    expect(status).toBe(404);
  });

  it('AC21: POST /api/items with nonexistent column_id returns 400', async () => {
    const { status } = await req(app, 'POST', '/api/items', {
      project_id: projectId,
      type: 'task',
      title: 'T',
      column_id: 'no-such-column',
    });
    expect(status).toBe(400);
  });

  it('AC22: POST /api/items with invalid type returns 400', async () => {
    const { status } = await req(app, 'POST', '/api/items', {
      project_id: projectId,
      type: 'sprint',
      title: 'T',
      column_id: firstColId,
    });
    expect(status).toBe(400);
  });

  it('AC23: POST /api/items with missing title returns 400', async () => {
    const { status } = await req(app, 'POST', '/api/items', {
      project_id: projectId,
      type: 'task',
      column_id: firstColId,
    });
    expect(status).toBe(400);
  });

  it('AC24: Second item in same project+column gets position 1', async () => {
    await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'First', column_id: firstColId,
    });
    const { body } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'Second', column_id: firstColId,
    });
    expect((body as Item).position).toBe(1);
  });

  it('AC25: GET /api/projects/:projectId/items returns all items ordered by column then position', async () => {
    await req(app, 'POST', '/api/items', { project_id: projectId, type: 'task', title: 'C1P0', column_id: firstColId });
    await req(app, 'POST', '/api/items', { project_id: projectId, type: 'task', title: 'C2P0', column_id: secondColId });
    await req(app, 'POST', '/api/items', { project_id: projectId, type: 'task', title: 'C1P1', column_id: firstColId });

    const { status, body } = await req(app, 'GET', `/api/projects/${projectId}/items`);
    expect(status).toBe(200);
    const items = body as Item[];
    expect(items).toHaveLength(3);
    // Items in firstColId come before secondColId (sorted by column_id ASC)
    const firstColItems = items.filter((i) => i.column_id === firstColId);
    const secondColItems = items.filter((i) => i.column_id === secondColId);
    expect(firstColItems).toHaveLength(2);
    expect(secondColItems).toHaveLength(1);
    expect(firstColItems[0].position).toBeLessThan(firstColItems[1].position);
  });

  it('AC26: GET /api/items/:id returns the item', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'story', title: 'Fetch Me', column_id: firstColId,
    });
    const item = created as Item;
    const { status, body } = await req(app, 'GET', `/api/items/${item.id}`);
    expect(status).toBe(200);
    expect((body as Item).id).toBe(item.id);
  });

  it('AC27: GET /api/items/:nonexistent returns 404', async () => {
    const { status } = await req(app, 'GET', '/api/items/nope');
    expect(status).toBe(404);
  });

  it('AC28: PATCH /api/items/:id with new title returns 200 with updated title', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'Old', column_id: firstColId,
    });
    const item = created as Item;
    const { status, body } = await req(app, 'PATCH', `/api/items/${item.id}`, { title: 'New Title' });
    expect(status).toBe(200);
    expect((body as Item).title).toBe('New Title');
    expect((body as Item).updated_at >= item.updated_at).toBe(true);
  });

  it('PATCH /api/items/:id setting parent_id to its own id returns 409 (self-parent guard)', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'story', title: 'Self', column_id: firstColId,
    });
    const item = created as Item;
    const { status } = await req(app, 'PATCH', `/api/items/${item.id}`, { parent_id: item.id });
    expect(status).toBe(409);
    // parent must remain unchanged (null)
    const { body: after } = await req(app, 'GET', `/api/items/${item.id}`);
    expect((after as Item).parent_id).toBeNull();
  });

  it('PATCH /api/items/:id creating a parent cycle returns 409', async () => {
    const { body: aRaw } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'epic', title: 'A', column_id: firstColId,
    });
    const { body: bRaw } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'story', title: 'B', column_id: firstColId,
    });
    const a = aRaw as Item;
    const b = bRaw as Item;
    // B under A (fine)
    const r1 = await req(app, 'PATCH', `/api/items/${b.id}`, { parent_id: a.id });
    expect(r1.status).toBe(200);
    // A under B would close the loop A->B->A — must be rejected
    const r2 = await req(app, 'PATCH', `/api/items/${a.id}`, { parent_id: b.id });
    expect(r2.status).toBe(409);
  });

  it('AC29: PATCH /api/items/:id/move changes column_id', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'Mover', column_id: firstColId,
    });
    const item = created as Item;
    const { status, body } = await req(app, 'PATCH', `/api/items/${item.id}/move`, { column_id: secondColId });
    expect(status).toBe(200);
    expect((body as Item).column_id).toBe(secondColId);

    const { body: fetched } = await req(app, 'GET', `/api/items/${item.id}`);
    expect((fetched as Item).column_id).toBe(secondColId);
  });

  it('AC30: PATCH /api/items/:id/move writes item.moved activity entry', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'MoveLog', column_id: firstColId,
    });
    const item = created as Item;
    await req(app, 'PATCH', `/api/items/${item.id}/move`, { column_id: secondColId });

    const { body: actBody } = await req(app, 'GET', `/api/items/${item.id}/activity`);
    const entries = (actBody as { entries: ActivityEntry[] }).entries;
    expect(entries.some((e) => e.event_type === 'item.moved')).toBe(true);
  });

  it('AC31: PATCH /api/items/:id/flag with true returns flagged=true and writes activity', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'FlagMe', column_id: firstColId,
    });
    const item = created as Item;
    const { status, body } = await req(app, 'PATCH', `/api/items/${item.id}/flag`, { flagged: true });
    expect(status).toBe(200);
    expect((body as Item).flagged).toBe(true);

    const { body: actBody } = await req(app, 'GET', `/api/items/${item.id}/activity`);
    const entries = (actBody as { entries: ActivityEntry[] }).entries;
    expect(entries.some((e) => e.event_type === 'item.flagged')).toBe(true);
  });

  it('AC32: PATCH /api/items/:id/flag with false returns flagged=false and writes item.unflagged', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'UnflagMe', column_id: firstColId,
    });
    const item = created as Item;
    await req(app, 'PATCH', `/api/items/${item.id}/flag`, { flagged: true });
    const { status, body } = await req(app, 'PATCH', `/api/items/${item.id}/flag`, { flagged: false });
    expect(status).toBe(200);
    expect((body as Item).flagged).toBe(false);

    const { body: actBody } = await req(app, 'GET', `/api/items/${item.id}/activity`);
    const entries = (actBody as { entries: ActivityEntry[] }).entries;
    expect(entries.some((e) => e.event_type === 'item.unflagged')).toBe(true);
  });

  it('AC33: PATCH /api/items/:id/block with reason sets blocked=true and blocked_reason', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'BlockMe', column_id: firstColId,
    });
    const item = created as Item;
    const { status, body } = await req(app, 'PATCH', `/api/items/${item.id}/block`, {
      blocked: true,
      reason: 'Waiting on design',
    });
    expect(status).toBe(200);
    expect((body as Item).blocked).toBe(true);
    expect((body as Item).blocked_reason).toBe('Waiting on design');
  });

  it('AC34: PATCH /api/items/:id/block blocked=true without reason returns 400', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'B', column_id: firstColId,
    });
    const item = created as Item;
    const { status } = await req(app, 'PATCH', `/api/items/${item.id}/block`, { blocked: true });
    expect(status).toBe(400);
  });

  it('AC35: PATCH /api/items/:id/block blocked=false clears blocked state', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'UnblockMe', column_id: firstColId,
    });
    const item = created as Item;
    await req(app, 'PATCH', `/api/items/${item.id}/block`, { blocked: true, reason: 'Reason' });
    const { status, body } = await req(app, 'PATCH', `/api/items/${item.id}/block`, { blocked: false });
    expect(status).toBe(200);
    expect((body as Item).blocked).toBe(false);
    expect((body as Item).blocked_reason).toBe('');
  });

  it('AC36: DELETE /api/items/:id returns 204, subsequent GET returns 404', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'DeleteMe', column_id: firstColId,
    });
    const item = created as Item;
    const { status: delStatus } = await req(app, 'DELETE', `/api/items/${item.id}`);
    expect(delStatus).toBe(204);
    const { status: getStatus } = await req(app, 'GET', `/api/items/${item.id}`);
    expect(getStatus).toBe(404);
  });

  it('AC37: Deleting an item sets parent_id to null on child items', async () => {
    const { body: parent } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'epic', title: 'Parent', column_id: firstColId,
    });
    const parentItem = parent as Item;

    const { body: child } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'story', title: 'Child', column_id: firstColId,
      parent_id: parentItem.id,
    });
    const childItem = child as Item;

    await req(app, 'DELETE', `/api/items/${parentItem.id}`);

    const { body: fetchedChild } = await req(app, 'GET', `/api/items/${childItem.id}`);
    expect((fetchedChild as Item).parent_id).toBeNull();
  });

  it('AC38: Creating an item writes item.created activity retrievable from GET /api/items/:id/activity', async () => {
    const { body: created } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'ActivityItem', column_id: firstColId,
    });
    const item = created as Item;

    const { status, body: actBody } = await req(app, 'GET', `/api/items/${item.id}/activity`);
    expect(status).toBe(200);
    const entries = (actBody as { entries: ActivityEntry[] }).entries;
    expect(entries.some((e) => e.event_type === 'item.created')).toBe(true);
  });
});
