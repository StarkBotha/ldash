import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ProjectService } from '../services/projects.js';
import { ColumnService } from '../services/columns.js';
import { ItemService } from '../services/items.js';
import { ActivityService } from '../services/activity.js';
import { itemsRouter } from '../routes/items.js';
import { projectsRouter } from '../routes/projects.js';
import { onError } from '../middleware/error.js';
import { EventBus } from '../events/bus.js';
import { req } from './helpers.js';
import type { Item } from '../types.js';

function createTestAppWithDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);

  const projectService = new ProjectService(db);
  const columnService = new ColumnService(db);
  const itemService = new ItemService(db);
  const activityService = new ActivityService(db);
  const bus = new EventBus();

  const app = new Hono();
  app.route('/api/projects', projectsRouter(projectService, activityService));
  app.route('/api/items', itemsRouter(itemService, projectService, columnService, activityService, bus, db));
  app.onError(onError);

  return { app, db, projectService, columnService, itemService, activityService, bus };
}

describe('HTTP move route guard and rollup', () => {
  let app: Hono;
  let projectId: string;
  let backlogColId: string;
  let doneColId: string;

  beforeEach(async () => {
    ({ app } = createTestAppWithDb());
    const { body: proj } = await req(app, 'POST', '/api/projects', { name: 'Test' });
    projectId = (proj as { id: string }).id;

    const { body: cols } = await req(app, 'GET', '/api/columns');
    // We don't have the columns route in this app — get them from the db directly
    // Actually, use a separate instance to get columns
  });

  it('PATCH /api/items/:id/move on story returns 409', async () => {
    // Create app with columns access
    const { app: fullApp, db, projectService, columnService, itemService, activityService, bus } = createTestAppWithDb();
    const proj = projectService.create({ name: 'P' });
    const cols = columnService.list().sort((a, b) => a.position - b.position);
    const backlog = cols[0];
    const done = cols.filter((c) => c.role !== 'cancelled').at(-1)!;

    const story = itemService.create({ project_id: proj.id, type: 'story', title: 'Story', column_id: backlog.id });

    const { status } = await req(fullApp, 'PATCH', `/api/items/${story.id}/move`, { column_id: done.id });
    expect(status).toBe(409);
  });

  it('PATCH /api/items/:id/move on epic returns 409', async () => {
    const { app: fullApp, projectService, columnService, itemService } = createTestAppWithDb();
    const proj = projectService.create({ name: 'P' });
    const cols = columnService.list().sort((a, b) => a.position - b.position);
    const backlog = cols[0];
    const done = cols.filter((c) => c.role !== 'cancelled').at(-1)!;

    const epic = itemService.create({ project_id: proj.id, type: 'epic', title: 'Epic', column_id: backlog.id });

    const { status } = await req(fullApp, 'PATCH', `/api/items/${epic.id}/move`, { column_id: done.id });
    expect(status).toBe(409);
  });

  it('PATCH /api/items/:id/move on task succeeds and rollup updates parent story', async () => {
    const { app: fullApp, projectService, columnService, itemService, activityService } = createTestAppWithDb();
    const proj = projectService.create({ name: 'P' });
    const cols = columnService.list().sort((a, b) => a.position - b.position);
    const backlog = cols[0];
    const done = cols.filter((c) => c.role !== 'cancelled').at(-1)!;

    const story = itemService.create({ project_id: proj.id, type: 'story', title: 'Story', column_id: backlog.id });
    const task = itemService.create({ project_id: proj.id, type: 'task', title: 'Task', column_id: backlog.id, parent_id: story.id });

    const { status } = await req(fullApp, 'PATCH', `/api/items/${task.id}/move`, { column_id: done.id });
    expect(status).toBe(200);

    // Story should have been rolled up to Done
    const storyAfter = itemService.get(story.id)!;
    expect(storyAfter.column_id).toBe(done.id);

    // Rollup activity should exist for story
    const storyActivity = activityService.listByItem(story.id, { limit: 10 });
    const rollupEntry = storyActivity.find((e) => e.actor_type === 'system' && e.event_type === 'item.moved');
    expect(rollupEntry).toBeDefined();
  });
});
