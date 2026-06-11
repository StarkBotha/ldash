import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runSchema } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrationRunner.js';
import { seedColumns } from '../../src/db/seed.js';
import { ProjectService } from '../../src/services/projects.js';
import { ColumnService } from '../../src/services/columns.js';
import { ItemService } from '../../src/services/items.js';
import { CommentService } from '../../src/services/comments.js';
import { AttachmentService } from '../../src/services/attachments.js';
import { ActivityService } from '../../src/services/activity.js';
import { ConversationService } from '../../src/services/conversations.js';
import { SettingsService } from '../../src/services/settings.js';
import { EventBus } from '../../src/events/bus.js';
import { createPlanningToolHandler } from '../../src/planning/tools.js';
import type { Services } from '../../src/types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);
  return db;
}

function createServices(db: Database.Database): Services {
  const activity = new ActivityService(db);
  return {
    projects: new ProjectService(db),
    items: new ItemService(db),
    columns: new ColumnService(db),
    comments: new CommentService(db),
    attachments: new AttachmentService(db, activity, new EventBus()),
    activity,
    conversations: new ConversationService(db),
    settings: new SettingsService(db),
  };
}

describe('createPlanningToolHandler', () => {
  describe('create_item', () => {
    it('happy path: item is persisted, activity has actor_type llm, event is emitted', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      const emittedEvents: unknown[] = [];
      bus.subscribe((event) => emittedEvents.push(event));

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('create_item', {
        type: 'task',
        title: 'Implement login endpoint',
        column_id: backlogCol.id,
      });

      const parsed = JSON.parse(result) as { success: boolean; item: { id: string; title: string } };
      expect(parsed.success).toBe(true);
      expect(parsed.item.title).toBe('Implement login endpoint');

      // Item must exist in the DB
      const items = services.items.listByProject(project.id);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Implement login endpoint');

      // Activity entry with actor_type: 'llm' and actor_id: 'planning-llm'
      const activity = services.activity.listByItem(items[0].id, { limit: 10 });
      expect(activity).toHaveLength(1);
      expect(activity[0].actor_type).toBe('llm');
      expect(activity[0].actor_id).toBe('planning-llm');
      expect(activity[0].event_type).toBe('item.created');

      // Event bus must have emitted item.created
      expect(emittedEvents).toHaveLength(1);
      expect((emittedEvents[0] as { type: string }).type).toBe('item.created');
    });

    it('with parent_id: item is created with the correct parent', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      const epic = services.items.create({
        project_id: project.id,
        type: 'epic',
        title: 'Auth Epic',
        column_id: backlogCol.id,
      });

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('create_item', {
        type: 'story',
        title: 'Login story',
        column_id: backlogCol.id,
        parent_id: epic.id,
      });

      const parsed = JSON.parse(result) as { success: boolean; item: { parent_id: string } };
      expect(parsed.success).toBe(true);
      expect(parsed.item.parent_id).toBe(epic.id);

      const items = services.items.listByProject(project.id);
      const story = items.find((i) => i.title === 'Login story');
      expect(story).toBeDefined();
      expect(story!.parent_id).toBe(epic.id);
    });

    it('rollup: creating a task under a Done story recomputes the story back to In Progress', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;
      const inProgressCol = columns.find((c) => c.name === 'In Progress')!;
      const doneCol = columns.find((c) => c.name === 'Done')!;

      const story = services.items.create({
        project_id: project.id,
        type: 'story',
        title: 'Auth story',
        column_id: backlogCol.id,
      });

      const handler = createPlanningToolHandler(services, project.id, bus, db);

      // One Done task → story derives to Done
      await handler('create_item', {
        type: 'task',
        title: 'Finished task',
        column_id: doneCol.id,
        parent_id: story.id,
      });
      expect(services.items.get(story.id)!.column_id).toBe(doneCol.id);

      // New Backlog task under the Done story → story drops to In Progress immediately
      await handler('create_item', {
        type: 'task',
        title: 'New follow-up task',
        column_id: backlogCol.id,
        parent_id: story.id,
      });
      expect(services.items.get(story.id)!.column_id).toBe(inProgressCol.id);
    });

    it('invalid column: returns error, nothing is persisted', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('create_item', {
        type: 'task',
        title: 'Some task',
        column_id: 'nonexistent-column-id',
      });

      expect(result).toBe('Error: column not found');

      // Nothing should be in the DB
      const items = services.items.listByProject(project.id);
      expect(items).toHaveLength(0);
    });

    it('invalid type: returns error without persisting', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('create_item', {
        type: 'invalid-type',
        title: 'Some task',
        column_id: backlogCol.id,
      });

      expect(result).toBe('Error: type must be epic, story, or task');
      expect(services.items.listByProject(project.id)).toHaveLength(0);
    });

    it('missing title: returns error without persisting', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('create_item', {
        type: 'task',
        title: '',
        column_id: backlogCol.id,
      });

      expect(result).toBe('Error: title is required');
      expect(services.items.listByProject(project.id)).toHaveLength(0);
    });

    it('invalid parent_id: returns error without persisting', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('create_item', {
        type: 'story',
        title: 'Orphan story',
        column_id: backlogCol.id,
        parent_id: 'nonexistent-parent-id',
      });

      expect(result).toBe('Error: parent item not found in this project');
      expect(services.items.listByProject(project.id)).toHaveLength(0);
    });

    it('column matched by case-insensitive name: item is created', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });

      const handler = createPlanningToolHandler(services, project.id, bus);
      // Use "backlog" (lowercase) instead of the real id — should match by name
      const result = await handler('create_item', {
        type: 'epic',
        title: 'Epic via name match',
        column_id: 'backlog',
      });

      const parsed = JSON.parse(result) as { success: boolean };
      expect(parsed.success).toBe(true);
      expect(services.items.listByProject(project.id)).toHaveLength(1);
    });
  });

  describe('update_item', () => {
    it('updates title and description, activity and event emitted', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      const item = services.items.create({
        project_id: project.id,
        type: 'task',
        title: 'Old title',
        description: 'Old desc',
        column_id: backlogCol.id,
      });

      const emittedEvents: unknown[] = [];
      bus.subscribe((event) => emittedEvents.push(event));

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('update_item', {
        item_id: item.id,
        title: 'New title',
        description: 'New desc',
      });

      const parsed = JSON.parse(result) as { success: boolean; item: { title: string; description: string } };
      expect(parsed.success).toBe(true);
      expect(parsed.item.title).toBe('New title');
      expect(parsed.item.description).toBe('New desc');

      // Verify DB was updated
      const updated = services.items.get(item.id);
      expect(updated!.title).toBe('New title');
      expect(updated!.description).toBe('New desc');

      // Activity entry with actor_type: 'llm'
      const activity = services.activity.listByItem(item.id, { limit: 10 });
      expect(activity).toHaveLength(1);
      expect(activity[0].actor_type).toBe('llm');
      expect(activity[0].actor_id).toBe('planning-llm');
      expect(activity[0].event_type).toBe('item.updated');

      // Event emitted
      expect(emittedEvents).toHaveLength(1);
      expect((emittedEvents[0] as { type: string }).type).toBe('item.updated');
    });

    it('missing item_id: returns error', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('update_item', { title: 'New title' });

      expect(result).toBe('Error: item_id is required');
    });

    it('item not in project: returns error', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('update_item', {
        item_id: 'nonexistent-item-id',
        title: 'New title',
      });

      expect(result).toBe('Error: item not found in this project');
    });

    it('neither title nor description provided: returns error', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      const item = services.items.create({
        project_id: project.id,
        type: 'task',
        title: 'Unchanged',
        column_id: backlogCol.id,
      });

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('update_item', { item_id: item.id });

      expect(result).toBe('Error: provide title or description to update');
    });
  });

  describe('list_items', () => {
    it('returns all items for the project as compact JSON', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      const epic = services.items.create({
        project_id: project.id,
        type: 'epic',
        title: 'Epic 1',
        column_id: backlogCol.id,
      });
      const story = services.items.create({
        project_id: project.id,
        type: 'story',
        title: 'Story 1',
        column_id: backlogCol.id,
      });

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('list_items', {});

      const parsed = JSON.parse(result) as Array<{ id: string; type: string; title: string; column_id: string; parent_id: string | null }>;
      expect(parsed).toHaveLength(2);

      const ids = parsed.map((i) => i.id);
      expect(ids).toContain(epic.id);
      expect(ids).toContain(story.id);

      // Compact shape — no description field
      for (const entry of parsed) {
        expect(Object.keys(entry)).not.toContain('description');
        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('type');
        expect(entry).toHaveProperty('title');
        expect(entry).toHaveProperty('column_id');
        expect(entry).toHaveProperty('parent_id');
      }
    });

    it('filters by type when type arg is provided', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      services.items.create({ project_id: project.id, type: 'epic', title: 'Epic 1', column_id: backlogCol.id });
      services.items.create({ project_id: project.id, type: 'story', title: 'Story 1', column_id: backlogCol.id });
      services.items.create({ project_id: project.id, type: 'task', title: 'Task 1', column_id: backlogCol.id });

      const handler = createPlanningToolHandler(services, project.id, bus);

      const epicResult = JSON.parse(await handler('list_items', { type: 'epic' })) as Array<{ type: string }>;
      expect(epicResult).toHaveLength(1);
      expect(epicResult[0].type).toBe('epic');

      const taskResult = JSON.parse(await handler('list_items', { type: 'task' })) as Array<{ type: string }>;
      expect(taskResult).toHaveLength(1);
      expect(taskResult[0].type).toBe('task');
    });

    it('only returns items for the given project, not others', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project1 = services.projects.create({ name: 'Project 1', description: '' });
      const project2 = services.projects.create({ name: 'Project 2', description: '' });
      const columns = services.columns.list();
      const backlogCol = columns.find((c) => c.name === 'Backlog')!;

      services.items.create({ project_id: project1.id, type: 'epic', title: 'P1 Epic', column_id: backlogCol.id });
      services.items.create({ project_id: project2.id, type: 'epic', title: 'P2 Epic', column_id: backlogCol.id });

      const handler = createPlanningToolHandler(services, project1.id, bus);
      const result = JSON.parse(await handler('list_items', {})) as Array<{ title: string }>;

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('P1 Epic');
    });
  });

  describe('unknown tool', () => {
    it('returns error string for an unknown tool name', async () => {
      const db = createTestDb();
      const services = createServices(db);
      const bus = new EventBus();
      const project = services.projects.create({ name: 'Test Project', description: '' });

      const handler = createPlanningToolHandler(services, project.id, bus);
      const result = await handler('nonexistent_tool', {});

      expect(result).toBe('Error: unknown tool nonexistent_tool');
    });
  });
});
