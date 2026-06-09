import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, req } from './helpers.js';
import type { Hono } from 'hono';
import type { Column, Item, ActivityEntry } from '../types.js';

let app: Hono;
let projectId: string;
let itemId: string;
let colId: string;

beforeEach(async () => {
  ({ app } = createTestApp());
  const { body: cols } = await req(app, 'GET', '/api/columns');
  colId = (cols as Column[])[0].id;
  const { body: project } = await req(app, 'POST', '/api/projects', { name: 'ActivityProj' });
  projectId = (project as { id: string }).id;
  const { body: item } = await req(app, 'POST', '/api/items', {
    project_id: projectId, type: 'task', title: 'ActivityItem', column_id: colId,
  });
  itemId = (item as Item).id;
});

describe('Activity feed', () => {
  it('AC45: GET /api/projects/:projectId/activity returns entries newest-first', async () => {
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'Renamed1' });
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'Renamed2' });

    const { status, body } = await req(app, 'GET', `/api/projects/${projectId}/activity`);
    expect(status).toBe(200);
    const { entries } = body as { entries: ActivityEntry[] };
    expect(entries.length).toBeGreaterThan(0);
    // Verify newest-first ordering
    for (let i = 0; i < entries.length - 1; i++) {
      expect(entries[i].created_at >= entries[i + 1].created_at).toBe(true);
    }
  });

  it('AC46: GET /api/projects/:projectId/activity?limit=2 returns at most 2 entries', async () => {
    // Create several activity events: project.created + item.created + more
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R1' });
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R2' });
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R3' });

    const { body } = await req(app, 'GET', `/api/projects/${projectId}/activity?limit=2`);
    const { entries } = body as { entries: ActivityEntry[] };
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it('AC47: ?limit=2 returns next_before when more entries exist', async () => {
    // We need > 2 entries; project.created + item.created + 3 more = 5
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R1' });
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R2' });
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R3' });

    const { body } = await req(app, 'GET', `/api/projects/${projectId}/activity?limit=2`);
    const { entries, next_before } = body as { entries: ActivityEntry[]; next_before: string | null };
    expect(entries).toHaveLength(2);
    expect(next_before).toBeTruthy();
  });

  it('AC48: Passing before=<next_before> returns next page with no overlap', async () => {
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R1' });
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R2' });
    await req(app, 'PATCH', `/api/projects/${projectId}`, { name: 'R3' });

    const { body: page1Body } = await req(app, 'GET', `/api/projects/${projectId}/activity?limit=2`);
    const { entries: page1, next_before } = page1Body as { entries: ActivityEntry[]; next_before: string };

    const { body: page2Body } = await req(app, 'GET', `/api/projects/${projectId}/activity?limit=2&before=${encodeURIComponent(next_before)}`);
    const { entries: page2 } = page2Body as { entries: ActivityEntry[] };

    const page1Ids = new Set(page1.map((e) => e.id));
    for (const entry of page2) {
      expect(page1Ids.has(entry.id)).toBe(false);
    }
  });

  it('AC49: GET /api/projects/:nonexistent/activity returns 404', async () => {
    const { status } = await req(app, 'GET', '/api/projects/nope/activity');
    expect(status).toBe(404);
  });

  it('AC50: GET /api/items/:itemId/activity returns only entries for that item', async () => {
    // Create a second item and do activity on both
    const { body: item2Body } = await req(app, 'POST', '/api/items', {
      project_id: projectId, type: 'task', title: 'Item2', column_id: colId,
    });
    const item2Id = (item2Body as Item).id;

    await req(app, 'PATCH', `/api/items/${itemId}/flag`, { flagged: true });
    await req(app, 'PATCH', `/api/items/${item2Id}/flag`, { flagged: true });

    const { body } = await req(app, 'GET', `/api/items/${itemId}/activity`);
    const { entries } = body as { entries: ActivityEntry[] };

    for (const entry of entries) {
      expect(entry.item_id).toBe(itemId);
    }
  });
});
