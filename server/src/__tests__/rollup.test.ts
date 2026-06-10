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
import { recomputeAncestors, recomputeAncestorsByParent } from '../services/rollup.js';
import type { Item } from '../types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);
  return db;
}

describe('rollup', () => {
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
    db = createTestDb();
    projectService = new ProjectService(db);
    columnService = new ColumnService(db);
    itemService = new ItemService(db);
    activityService = new ActivityService(db);
    bus = new EventBus();

    const project = projectService.create({ name: 'Test Project' });
    projectId = project.id;

    const cols = columnService.list().sort((a, b) => a.position - b.position);
    backlogColId = cols[0].id;     // position 0 = Backlog (first)
    inProgressColId = cols[1].id;  // position 1 = In Progress (second)
    doneColId = cols[cols.length - 1].id; // last = Done
  });

  describe('story rollup', () => {
    it('all tasks in Backlog (first) → story moves to Backlog', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: inProgressColId });
      const task1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: backlogColId, parent_id: story.id });
      const task2 = itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: backlogColId, parent_id: story.id });

      recomputeAncestors(task1.id, db, itemService, activityService, columnService, bus);

      const updated = itemService.get(story.id)!;
      expect(updated.column_id).toBe(backlogColId);
    });

    it('all tasks in Done (last) → story moves to Done', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      const task1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: doneColId, parent_id: story.id });
      const task2 = itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: doneColId, parent_id: story.id });

      recomputeAncestors(task1.id, db, itemService, activityService, columnService, bus);

      const updated = itemService.get(story.id)!;
      expect(updated.column_id).toBe(doneColId);
    });

    it('mixed tasks → story moves to second column (in-progress)', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      const task1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: backlogColId, parent_id: story.id });
      const task2 = itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: doneColId, parent_id: story.id });

      recomputeAncestors(task1.id, db, itemService, activityService, columnService, bus);

      const updated = itemService.get(story.id)!;
      expect(updated.column_id).toBe(inProgressColId);
    });

    it('no tasks → story is not touched', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: inProgressColId });
      const epic = itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: backlogColId });
      const task = itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: doneColId, parent_id: epic.id });

      // recompute from task whose parent is epic, not story — story should be untouched
      recomputeAncestors(task.id, db, itemService, activityService, columnService, bus);

      const storyAfter = itemService.get(story.id)!;
      expect(storyAfter.column_id).toBe(inProgressColId);
    });

    it('regression case: new backlog task under done story pulls story back to in-progress', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: doneColId });
      // Existing done task
      const doneTask = itemService.create({ project_id: projectId, type: 'task', title: 'Done Task', column_id: doneColId, parent_id: story.id });

      // Simulate: story is done. Now add a backlog task.
      const newTask = itemService.create({ project_id: projectId, type: 'task', title: 'New Task', column_id: backlogColId, parent_id: story.id });

      // Rollup triggered by the new backlog task creation
      recomputeAncestors(newTask.id, db, itemService, activityService, columnService, bus);

      // Story should now be in-progress (mixed state)
      const updatedStory = itemService.get(story.id)!;
      expect(updatedStory.column_id).toBe(inProgressColId);
    });
  });

  describe('epic rollup', () => {
    it('all descendant tasks done → epic moves to Done', () => {
      const epic = itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: backlogColId });
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId, parent_id: epic.id });
      const task = itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: doneColId, parent_id: story.id });

      recomputeAncestors(task.id, db, itemService, activityService, columnService, bus);

      const updatedEpic = itemService.get(epic.id)!;
      expect(updatedEpic.column_id).toBe(doneColId);
    });

    it('mixed tasks across stories → epic in-progress', () => {
      const epic = itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: doneColId });
      const story1 = itemService.create({ project_id: projectId, type: 'story', title: 'S1', column_id: backlogColId, parent_id: epic.id });
      const story2 = itemService.create({ project_id: projectId, type: 'story', title: 'S2', column_id: doneColId, parent_id: epic.id });
      const t1 = itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: backlogColId, parent_id: story1.id });
      const t2 = itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: doneColId, parent_id: story2.id });

      recomputeAncestors(t1.id, db, itemService, activityService, columnService, bus);

      const updatedEpic = itemService.get(epic.id)!;
      expect(updatedEpic.column_id).toBe(inProgressColId);
    });

    it('epic with no tasks is not touched', () => {
      const epic = itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: inProgressColId });
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId, parent_id: epic.id });

      // Use recomputeAncestorsByParent on the story (no tasks exist)
      recomputeAncestorsByParent(story.id, projectId, db, itemService, activityService, columnService, bus);

      // Story has no tasks → not touched; epic has no tasks → not touched
      const epicAfter = itemService.get(epic.id)!;
      expect(epicAfter.column_id).toBe(inProgressColId);
    });
  });

  describe('derived move writes system activity and emits event', () => {
    it('writes activity entry with actor_type system and actor_id rollup', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      const task = itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: doneColId, parent_id: story.id });

      recomputeAncestors(task.id, db, itemService, activityService, columnService, bus);

      const storyAfter = itemService.get(story.id)!;
      expect(storyAfter.column_id).toBe(doneColId);

      const activity = activityService.listByItem(story.id, { limit: 10 });
      const rollupEntry = activity.find((e) => e.event_type === 'item.moved' && e.actor_type === 'system');
      expect(rollupEntry).toBeDefined();
      expect(rollupEntry!.actor_id).toBe('rollup');
    });

    it('emits item.moved event on bus', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      const task = itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: doneColId, parent_id: story.id });

      const emitted: unknown[] = [];
      bus.subscribe((e) => emitted.push(e));

      recomputeAncestors(task.id, db, itemService, activityService, columnService, bus);

      const storyEvent = emitted.find(
        (e) => (e as { type: string; entityId: string }).type === 'item.moved'
          && (e as { entityId: string }).entityId === story.id
      );
      expect(storyEvent).toBeDefined();
    });
  });

  describe('guard: service throws for non-task move', () => {
    it('throws for story move', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      expect(() => itemService.move(story.id, { column_id: doneColId }))
        .toThrow('Status of a story is derived from its tasks and cannot be set directly');
    });

    it('throws for epic move', () => {
      const epic = itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: backlogColId });
      expect(() => itemService.move(epic.id, { column_id: doneColId }))
        .toThrow('Status of a epic is derived from its tasks and cannot be set directly');
    });

    it('does NOT throw for task move (normal path)', () => {
      const task = itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: backlogColId });
      expect(() => itemService.move(task.id, { column_id: doneColId })).not.toThrow();
    });

    it('does NOT throw with internal flag (rollup path)', () => {
      const story = itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: backlogColId });
      expect(() => itemService.move(story.id, { column_id: doneColId }, { internal: true })).not.toThrow();
    });
  });
});
