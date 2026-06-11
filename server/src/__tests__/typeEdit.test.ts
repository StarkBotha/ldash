import { describe, it, expect, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import { eventBus } from '../events/bus.js';
import type { BoardEvent } from '../events/types.js';
import { createTestApp, req } from './helpers.js';
import type { ActivityService } from '../services/activity.js';
import type { Column, Item } from '../types.js';

describe('editing item type (leaf work item conversions)', () => {
  let app: Hono;
  let activityService: ActivityService;
  let firstColId: string;
  let projectId: string;

  beforeEach(async () => {
    ({ app, activityService } = createTestApp());
    const { body: cols } = await req(app, 'GET', '/api/columns');
    firstColId = (cols as Column[])[0].id;
    const { body: project } = await req(app, 'POST', '/api/projects', { name: 'Type Edit' });
    projectId = (project as { id: string }).id;
  });

  async function createItem(type: string, title: string, parent_id?: string): Promise<Item> {
    const { status, body } = await req(app, 'POST', '/api/items', {
      project_id: projectId,
      type,
      title,
      column_id: firstColId,
      parent_id,
    });
    expect(status).toBe(201);
    return body as Item;
  }

  it('task → bug succeeds: persisted, activity row written, item.updated emitted', async () => {
    const task = await createItem('task', 'Turns out a defect');

    const events: BoardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    try {
      const { status, body } = await req(app, 'PATCH', `/api/items/${task.id}`, { type: 'bug' });
      expect(status).toBe(200);
      expect((body as Item).type).toBe('bug');

      // Persisted
      const { body: fetched } = await req(app, 'GET', `/api/items/${task.id}`);
      expect((fetched as Item).type).toBe('bug');

      // Activity row
      const activity = activityService.listByItem(task.id, { limit: 10 });
      const entry = activity.find((a) => a.event_type === 'item.updated');
      expect(entry).toBeDefined();
      const fields = (entry!.payload as { fields: { old: Record<string, unknown>; new: Record<string, unknown> } }).fields;
      expect(fields.old.type).toBe('task');
      expect(fields.new.type).toBe('bug');

      // Event emitted
      const emitted = events.find((e) => e.type === 'item.updated' && e.entityId === task.id);
      expect(emitted).toBeDefined();
      expect((emitted!.data as { item: Item }).item.type).toBe('bug');
    } finally {
      unsubscribe();
    }
  });

  it('bug → investigation succeeds', async () => {
    const bug = await createItem('bug', 'Needs digging first');

    const { status, body } = await req(app, 'PATCH', `/api/items/${bug.id}`, { type: 'investigation' });
    expect(status).toBe(200);
    expect((body as Item).type).toBe('investigation');
  });

  it('the ticket key is unchanged after conversion', async () => {
    const task = await createItem('task', 'Keyed work');
    expect(task.key).toMatch(/^[A-Z]+-\d+$/);

    const { body } = await req(app, 'PATCH', `/api/items/${task.id}`, { type: 'investigation' });
    expect((body as Item).key).toBe(task.key);
    expect((body as Item).number).toBe(task.number);
  });

  it('task → story is rejected with 409 and a clear message', async () => {
    const task = await createItem('task', 'Not a story');

    const { status, body } = await req(app, 'PATCH', `/api/items/${task.id}`, { type: 'story' });
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain('cannot convert task to story');

    const { body: fetched } = await req(app, 'GET', `/api/items/${task.id}`);
    expect((fetched as Item).type).toBe('task');
  });

  it('story → task is rejected', async () => {
    const story = await createItem('story', 'Stays a story');

    const { status, body } = await req(app, 'PATCH', `/api/items/${story.id}`, { type: 'task' });
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain('cannot convert story to task');
  });

  it('epic → bug is rejected', async () => {
    const epic = await createItem('epic', 'Stays an epic');

    const { status, body } = await req(app, 'PATCH', `/api/items/${epic.id}`, { type: 'bug' });
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain('cannot convert epic to bug');
  });

  it('rejects an unknown type value with 400', async () => {
    const task = await createItem('task', 'Bad type input');

    const { status } = await req(app, 'PATCH', `/api/items/${task.id}`, { type: 'chore' });
    expect(status).toBe(400);
  });

  it('no-op type (same as current) on a story is allowed', async () => {
    const story = await createItem('story', 'Same type');

    const { status, body } = await req(app, 'PATCH', `/api/items/${story.id}`, { type: 'story', title: 'Renamed' });
    expect(status).toBe(200);
    expect((body as Item).type).toBe('story');
    expect((body as Item).title).toBe('Renamed');
  });

  it('type change does not move the item or disturb rollup inputs', async () => {
    const story = await createItem('story', 'Parent story');
    const task = await createItem('task', 'Child work', story.id);

    const { body } = await req(app, 'PATCH', `/api/items/${task.id}`, { type: 'bug' });
    expect((body as Item).column_id).toBe(task.column_id);

    const { body: parent } = await req(app, 'GET', `/api/items/${story.id}`);
    expect((parent as Item).column_id).toBe(story.column_id);
  });
});
