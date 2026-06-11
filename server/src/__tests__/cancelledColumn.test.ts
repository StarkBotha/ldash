import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ProjectService } from '../services/projects.js';
import { ColumnService } from '../services/columns.js';
import { ItemService } from '../services/items.js';
import { ActivityService } from '../services/activity.js';
import { EventBus } from '../events/bus.js';
import { recomputeAncestors, reconcileAllOnStartup } from '../services/rollup.js';
import { createTestApp, req } from './helpers.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);
  return db;
}

describe('migration 007: cancelled column', () => {
  it('adds role column and appends Cancelled to an existing board', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runSchema(db);
    // Simulate a pre-007 board: columns already seeded without role
    const insert = db.prepare('INSERT INTO columns (id, name, position) VALUES (?, ?, ?)');
    insert.run('c1', 'Backlog', 0);
    insert.run('c2', 'In Progress', 1);
    insert.run('c3', 'Review', 2);
    insert.run('c4', 'Done', 3);

    runMigrations(db);

    const cols = db.prepare('SELECT * FROM columns ORDER BY position ASC').all() as {
      id: string; name: string; position: number; role: string | null;
    }[];
    expect(cols).toHaveLength(5);
    const last = cols[cols.length - 1];
    expect(last.name).toBe('Cancelled');
    expect(last.role).toBe('cancelled');
    expect(last.position).toBe(4);
    // Existing columns untouched, role null
    expect(cols[3].name).toBe('Done');
    expect(cols[3].role).toBeNull();
    db.close();
  });

  it('does not duplicate Cancelled when one already exists', () => {
    const db = new Database(':memory:');
    runSchema(db);
    runMigrations(db);
    seedColumns(db);
    // Re-running migrations is a no-op (already recorded), but even a forced
    // re-run of the insert guard would skip — assert only one cancelled column
    const cancelled = db
      .prepare("SELECT * FROM columns WHERE role = 'cancelled'")
      .all();
    expect(cancelled).toHaveLength(1);
    db.close();
  });

  it('fresh DB gets Cancelled last via seed, with role set', () => {
    const db = createTestDb();
    const svc = new ColumnService(db);
    const cols = svc.list();
    expect(cols).toHaveLength(5);
    expect(cols[4].name).toBe('Cancelled');
    expect(cols[4].role).toBe('cancelled');
    expect(cols[4].position).toBe(4);
    db.close();
  });
});

describe('moving leaf work items to Cancelled', () => {
  it('task, bug, and investigation can be moved to Cancelled via the route', async () => {
    const { app, columnService } = createTestApp();
    const cols = columnService.list();
    const backlog = cols[0];
    const cancelled = cols.find((c) => c.role === 'cancelled')!;

    const { body: project } = await req(app, 'POST', '/api/projects', { name: 'Cancel Moves' });
    const projectId = (project as { id: string }).id;

    for (const type of ['task', 'bug', 'investigation'] as const) {
      const { body: item } = await req(app, 'POST', '/api/items', {
        project_id: projectId, type, title: `${type} to cancel`, column_id: backlog.id,
      });
      const itemId = (item as { id: string }).id;
      const { status, body } = await req(app, 'PATCH', `/api/items/${itemId}/move`, {
        column_id: cancelled.id,
      });
      expect(status).toBe(200);
      expect((body as { column_id: string }).column_id).toBe(cancelled.id);
    }
  });

  it('stories and epics still cannot be moved to Cancelled (409)', async () => {
    const { app, columnService } = createTestApp();
    const cols = columnService.list();
    const cancelled = cols.find((c) => c.role === 'cancelled')!;

    const { body: project } = await req(app, 'POST', '/api/projects', { name: 'Cancel Guard' });
    const projectId = (project as { id: string }).id;

    for (const type of ['story', 'epic'] as const) {
      const { body: item } = await req(app, 'POST', '/api/items', {
        project_id: projectId, type, title: `${type}`, column_id: cols[0].id,
      });
      const itemId = (item as { id: string }).id;
      const { status } = await req(app, 'PATCH', `/api/items/${itemId}/move`, {
        column_id: cancelled.id,
      });
      expect(status).toBe(409);
    }
  });
});

describe('rollup with cancelled work items', () => {
  let db: Database.Database;
  let projectService: ProjectService;
  let columnService: ColumnService;
  let itemService: ItemService;
  let activityService: ActivityService;
  let bus: EventBus;
  let projectId: string;
  let backlogColId: string;
  let inProgressColId: string;
  let doneColId: string;
  let cancelledColId: string;

  beforeEach(() => {
    db = createTestDb();
    projectService = new ProjectService(db);
    columnService = new ColumnService(db);
    itemService = new ItemService(db);
    activityService = new ActivityService(db);
    bus = new EventBus();

    projectId = projectService.create({ name: 'Cancel Rollup' }).id;
    const cols = columnService.list().sort((a, b) => a.position - b.position);
    const active = cols.filter((c) => c.role !== 'cancelled');
    backlogColId = active[0].id;
    inProgressColId = active[1].id;
    doneColId = active[active.length - 1].id;
    cancelledColId = cols.find((c) => c.role === 'cancelled')!.id;
  });

  function recompute(taskId: string) {
    recomputeAncestors(taskId, db, itemService, activityService, columnService, bus);
  }

  it('story with 1 done task + 1 cancelled task → Done', () => {
    const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
    const t1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: doneColId, parent_id: story.id });
    itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: cancelledColId, parent_id: story.id });

    recompute(t1.id);

    expect(itemService.get(story.id)!.column_id).toBe(doneColId);
  });

  it('story with 1 backlog task + 1 cancelled task → Backlog (not started)', () => {
    const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: inProgressColId });
    const t1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: backlogColId, parent_id: story.id });
    itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: cancelledColId, parent_id: story.id });

    recompute(t1.id);

    expect(itemService.get(story.id)!.column_id).toBe(backlogColId);
  });

  it('story with mixed non-cancelled tasks + 1 cancelled → in progress', () => {
    const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
    const t1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: backlogColId, parent_id: story.id });
    itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: doneColId, parent_id: story.id });
    itemService.create({ project_id: projectId, type: 'bug', title: 'B1', column_id: cancelledColId, parent_id: story.id });

    recompute(t1.id);

    expect(itemService.get(story.id)!.column_id).toBe(inProgressColId);
  });

  it('story with ALL leaves cancelled → Cancelled, with system rollup activity', () => {
    const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: inProgressColId });
    const t1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: cancelledColId, parent_id: story.id });
    itemService.create({ project_id: projectId, type: 'bug', title: 'B1', column_id: cancelledColId, parent_id: story.id });

    recompute(t1.id);

    expect(itemService.get(story.id)!.column_id).toBe(cancelledColId);

    const entries = activityService.listByItem(story.id, { limit: 10 });
    const rollupMove = entries.find((e) => e.event_type === 'item.moved');
    expect(rollupMove).toBeDefined();
    expect(rollupMove!.actor_type).toBe('system');
    expect(rollupMove!.actor_id).toBe('rollup');
    expect(rollupMove!.payload.to_column_id).toBe(cancelledColId);
  });

  it('story with no leaves keeps existing behavior (untouched)', () => {
    const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: inProgressColId });
    const other = itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: backlogColId });

    recompute(other.id);

    expect(itemService.get(story.id)!.column_id).toBe(inProgressColId);
  });

  it('epic rollup across stories with a cancelled mix', () => {
    const epic = itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: backlogColId });
    const s1 = itemService.create({ project_id: projectId, type: 'story', title: 'S1', column_id: backlogColId, parent_id: epic.id });
    const s2 = itemService.create({ project_id: projectId, type: 'story', title: 'S2', column_id: backlogColId, parent_id: epic.id });

    // s1: all tasks done; s2: all tasks cancelled → epic's non-cancelled leaves all done → Done
    const t1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: doneColId, parent_id: s1.id });
    itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: cancelledColId, parent_id: s2.id });

    recompute(t1.id);

    expect(itemService.get(s1.id)!.column_id).toBe(doneColId);
    expect(itemService.get(epic.id)!.column_id).toBe(doneColId);
  });

  it('epic with ALL descendant leaves cancelled → Cancelled', () => {
    const epic = itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: inProgressColId });
    const s1 = itemService.create({ project_id: projectId, type: 'story', title: 'S1', column_id: inProgressColId, parent_id: epic.id });
    const t1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: cancelledColId, parent_id: s1.id });
    itemService.create({ project_id: projectId, type: 'investigation', title: 'I1', column_id: cancelledColId, parent_id: epic.id });

    recompute(t1.id);

    expect(itemService.get(s1.id)!.column_id).toBe(cancelledColId);
    expect(itemService.get(epic.id)!.column_id).toBe(cancelledColId);
  });

  it('startup reconciliation applies cancelled semantics', () => {
    // Build state without triggering recompute on the relevant items
    const storyAllCancelled = itemService.create({ project_id: projectId, type: 'story', title: 'SC', column_id: backlogColId });
    itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: cancelledColId, parent_id: storyAllCancelled.id });

    const storyDonePlusCancelled = itemService.create({ project_id: projectId, type: 'story', title: 'SD', column_id: backlogColId });
    itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: doneColId, parent_id: storyDonePlusCancelled.id });
    itemService.create({ project_id: projectId, type: 'task', title: 'T3', column_id: cancelledColId, parent_id: storyDonePlusCancelled.id });

    reconcileAllOnStartup(db, itemService, activityService, columnService, bus);

    expect(itemService.get(storyAllCancelled.id)!.column_id).toBe(cancelledColId);
    expect(itemService.get(storyDonePlusCancelled.id)!.column_id).toBe(doneColId);
  });
});
