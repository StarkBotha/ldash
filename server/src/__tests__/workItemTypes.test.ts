import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ProjectService } from '../services/projects.js';
import { ColumnService } from '../services/columns.js';
import { ItemService } from '../services/items.js';
import { ActivityService } from '../services/activity.js';
import { EventBus } from '../events/bus.js';
import { recomputeAncestors } from '../services/rollup.js';
import { createTestApp, req } from './helpers.js';
import type { Column, Item } from '../types.js';

describe('bug and investigation item types', () => {
  describe('routes', () => {
    let app: Hono;
    let firstColId: string;
    let secondColId: string;
    let lastColId: string;
    let projectId: string;

    beforeEach(async () => {
      ({ app } = createTestApp());
      const { body: cols } = await req(app, 'GET', '/api/columns');
      const columns = cols as Column[];
      firstColId = columns[0].id;
      secondColId = columns[1].id;
      lastColId = columns.filter((c) => c.role !== 'cancelled').at(-1)!.id;
      const { body: project } = await req(app, 'POST', '/api/projects', { name: 'Work Types' });
      projectId = (project as { id: string }).id;
    });

    it('creates a bug: 201, gets a ticket key, lands in the requested column', async () => {
      const { status, body } = await req(app, 'POST', '/api/items', {
        project_id: projectId,
        type: 'bug',
        title: 'Login crashes',
        column_id: firstColId,
      });
      expect(status).toBe(201);
      const item = body as Item;
      expect(item.type).toBe('bug');
      expect(item.key).toMatch(/^[A-Z]+-\d+$/);
      expect(item.column_id).toBe(firstColId);
    });

    it('creates an investigation: 201, gets a ticket key', async () => {
      const { status, body } = await req(app, 'POST', '/api/items', {
        project_id: projectId,
        type: 'investigation',
        title: 'Why is startup slow?',
        column_id: firstColId,
      });
      expect(status).toBe(201);
      const item = body as Item;
      expect(item.type).toBe('investigation');
      expect(item.key).toMatch(/^[A-Z]+-\d+$/);
    });

    it('bug can nest under a story like a task', async () => {
      const { body: story } = await req(app, 'POST', '/api/items', {
        project_id: projectId,
        type: 'story',
        title: 'S',
        column_id: firstColId,
      });
      const { status, body } = await req(app, 'POST', '/api/items', {
        project_id: projectId,
        type: 'bug',
        title: 'B',
        column_id: firstColId,
        parent_id: (story as Item).id,
      });
      expect(status).toBe(201);
      expect((body as Item).parent_id).toBe((story as Item).id);
    });

    it('moves a bug and an investigation between columns directly', async () => {
      for (const type of ['bug', 'investigation'] as const) {
        const { body: created } = await req(app, 'POST', '/api/items', {
          project_id: projectId,
          type,
          title: `Movable ${type}`,
          column_id: firstColId,
        });
        const id = (created as Item).id;

        const moved1 = await req(app, 'PATCH', `/api/items/${id}/move`, { column_id: secondColId });
        expect(moved1.status).toBe(200);
        expect((moved1.body as Item).column_id).toBe(secondColId);

        const moved2 = await req(app, 'PATCH', `/api/items/${id}/move`, { column_id: lastColId });
        expect(moved2.status).toBe(200);
        expect((moved2.body as Item).column_id).toBe(lastColId);
      }
    });

    it('still rejects moving a story or epic with 409', async () => {
      for (const type of ['story', 'epic'] as const) {
        const { body: created } = await req(app, 'POST', '/api/items', {
          project_id: projectId,
          type,
          title: `Immovable ${type}`,
          column_id: firstColId,
        });
        const { status, body } = await req(app, 'PATCH', `/api/items/${(created as Item).id}/move`, {
          column_id: secondColId,
        });
        expect(status).toBe(409);
        expect((body as { error: string }).error).toContain('derived');
      }
    });

    it('rejects unknown types with the updated message', async () => {
      const { status, body } = await req(app, 'POST', '/api/items', {
        project_id: projectId,
        type: 'sprint',
        title: 'T',
        column_id: firstColId,
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toContain('bug, investigation');
    });
  });

  describe('rollup includes bugs and investigations', () => {
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

    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      runSchema(db);
      runMigrations(db);
      seedColumns(db);

      projectService = new ProjectService(db);
      columnService = new ColumnService(db);
      itemService = new ItemService(db);
      activityService = new ActivityService(db);
      bus = new EventBus();

      projectId = projectService.create({ name: 'Rollup Types' }).id;
      const cols = columnService.list().sort((a, b) => a.position - b.position);
      backlogColId = cols[0].id;
      inProgressColId = cols[1].id;
      doneColId = cols.filter((c) => c.role !== 'cancelled').at(-1)!.id;
    });

    it('story with 1 done task + 1 backlog bug → in progress', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: doneColId, parent_id: story.id });
      const bug = itemService.create({ project_id: projectId, type: 'bug', title: 'B', column_id: backlogColId, parent_id: story.id });

      recomputeAncestors(bug.id, db, itemService, activityService, columnService, bus);

      expect(itemService.get(story.id)!.column_id).toBe(inProgressColId);
    });

    it('story with task + bug + investigation all done → done', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: doneColId, parent_id: story.id });
      itemService.create({ project_id: projectId, type: 'bug', title: 'B', column_id: doneColId, parent_id: story.id });
      const inv = itemService.create({ project_id: projectId, type: 'investigation', title: 'I', column_id: doneColId, parent_id: story.id });

      recomputeAncestors(inv.id, db, itemService, activityService, columnService, bus);

      expect(itemService.get(story.id)!.column_id).toBe(doneColId);
    });

    it('epic rolls up from an investigation nested directly under it', () => {
      const epic = itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: backlogColId });
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId, parent_id: epic.id });
      itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: doneColId, parent_id: story.id });
      const inv = itemService.create({ project_id: projectId, type: 'investigation', title: 'I', column_id: backlogColId, parent_id: epic.id });

      // recompute via the story task first, then via the direct investigation
      recomputeAncestors(inv.id, db, itemService, activityService, columnService, bus);

      // Mixed: story task done, direct investigation in backlog → epic in progress
      expect(itemService.get(epic.id)!.column_id).toBe(inProgressColId);
    });

    it('service move guard allows bug/investigation, still throws for story/epic', () => {
      const bug = itemService.create({ project_id: projectId, type: 'bug', title: 'B', column_id: backlogColId });
      expect(() => itemService.move(bug.id, { column_id: doneColId })).not.toThrow();

      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      expect(() => itemService.move(story.id, { column_id: doneColId })).toThrow(/derived/);
    });
  });

  describe('migration 006 (items table rebuild)', () => {
    it('preserves items, comments, and activity across the rebuild and admits new types', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      runSchema(db);

      // Simulate a pre-migration database: rows inserted against the frozen
      // baseline schema (old CHECK constraint, no number/key columns yet).
      db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Legacy')").run();
      db.prepare("INSERT INTO columns (id, name, position) VALUES ('c1', 'Backlog', 0)").run();
      db.prepare(
        "INSERT INTO items (id, project_id, type, title, column_id) VALUES ('i1', 'p1', 'task', 'Old task', 'c1')"
      ).run();
      db.prepare("INSERT INTO comments (id, item_id, body) VALUES ('cm1', 'i1', 'keep me')").run();
      db.prepare(
        "INSERT INTO activity (id, item_id, project_id, event_type) VALUES ('a1', 'i1', 'p1', 'item.created')"
      ).run();

      runMigrations(db);

      // Data survived the table rebuild — nothing cascaded or nulled out
      const item = db.prepare("SELECT * FROM items WHERE id = 'i1'").get() as { type: string; key: string };
      expect(item).toBeDefined();
      expect(item.type).toBe('task');
      expect(item.key).toBe('LEG-1'); // backfilled by migration 004
      const comment = db.prepare("SELECT * FROM comments WHERE id = 'cm1'").get();
      expect(comment).toBeDefined();
      const activity = db.prepare("SELECT item_id FROM activity WHERE id = 'a1'").get() as { item_id: string };
      expect(activity.item_id).toBe('i1');

      // FK enforcement is back on after the migration
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

      // New types are accepted; bogus types still rejected by the CHECK
      db.prepare(
        "INSERT INTO items (id, project_id, type, title, column_id, number, key) VALUES ('i2', 'p1', 'bug', 'New bug', 'c1', 2, 'LEG-2')"
      ).run();
      db.prepare(
        "INSERT INTO items (id, project_id, type, title, column_id, number, key) VALUES ('i3', 'p1', 'investigation', 'New inv', 'c1', 3, 'LEG-3')"
      ).run();
      expect(() =>
        db.prepare(
          "INSERT INTO items (id, project_id, type, title, column_id, number, key) VALUES ('i4', 'p1', 'sprint', 'Nope', 'c1', 4, 'LEG-4')"
        ).run()
      ).toThrow(/CHECK/);

      // Deleting an item still cascades to its comments (FK actions intact post-rebuild)
      db.prepare("DELETE FROM items WHERE id = 'i1'").run();
      expect(db.prepare("SELECT * FROM comments WHERE id = 'cm1'").get()).toBeUndefined();

      db.close();
    });
  });
});
