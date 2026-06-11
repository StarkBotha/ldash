import { describe, it, expect, beforeEach } from 'vitest';
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
import { createItemChatToolHandler, getItemChatToolDefinitions } from '../../src/chat/tools.js';
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

describe('item chat tools', () => {
  let db: Database.Database;
  let services: Services;
  let bus: EventBus;
  let projectId: string;
  let handler: ReturnType<typeof createItemChatToolHandler>;

  beforeEach(() => {
    db = createTestDb();
    const items = new ItemService(db);
    const activity = new ActivityService(db);
    bus = new EventBus();
    services = {
      projects: new ProjectService(db),
      items,
      columns: new ColumnService(db),
      comments: new CommentService(db),
      attachments: new AttachmentService(db, activity, bus),
      activity,
      conversations: new ConversationService(db),
      settings: new SettingsService(db),
    };
    projectId = services.projects.create({ name: 'chat tools test' }).id;
    handler = createItemChatToolHandler(services, projectId, bus, db);
  });

  function cols() {
    return services.columns.list().sort((a, b) => a.position - b.position);
  }

  it('definitions include planning tools plus chat tools', () => {
    const names = getItemChatToolDefinitions().map((t) => t.name);
    expect(names).toContain('create_item');
    expect(names).toContain('move_task');
    expect(names).toContain('add_comment');
    expect(names).toContain('get_item');
  });

  it('move_task moves a task by ticket key and emits item.moved', async () => {
    const task = services.items.create({
      project_id: projectId, type: 'task', title: 'movable', column_id: cols()[0].id,
    });
    const events: string[] = [];
    bus.subscribe((e) => { events.push(e.type); });

    const result = JSON.parse(await handler('move_task', { item_id: task.key, column_id: cols()[1].name }));
    expect(result.success).toBe(true);
    expect(result.item.column_id).toBe(cols()[1].id);
    expect(events).toContain('item.moved');

    const activity = services.activity.listByItem(task.id, { limit: 10 });
    const moved = activity.find((a) => a.event_type === 'item.moved');
    expect(moved?.actor_type).toBe('llm');
    expect(moved?.actor_id).toBe('chat-llm');
  });

  it('move_task refuses non-task items', async () => {
    const story = services.items.create({
      project_id: projectId, type: 'story', title: 'immovable', column_id: cols()[0].id,
    });
    const result = await handler('move_task', { item_id: story.id, column_id: cols()[1].id });
    expect(result).toMatch(/^Error: Status of a story/);
  });

  it('move_task recomputes ancestor rollup', async () => {
    const story = services.items.create({
      project_id: projectId, type: 'story', title: 's', column_id: cols()[0].id,
    });
    const task = services.items.create({
      project_id: projectId, type: 'task', title: 't', column_id: cols()[0].id, parent_id: story.id,
    });
    const doneCol = cols().filter((c) => c.role !== 'cancelled').at(-1)!;
    await handler('move_task', { item_id: task.id, column_id: doneCol.id });
    const updatedStory = services.items.get(story.id)!;
    expect(updatedStory.column_id).toBe(doneCol.id);
  });

  it('add_comment creates a comment with chat-llm author', async () => {
    const task = services.items.create({
      project_id: projectId, type: 'task', title: 'commentable', column_id: cols()[0].id,
    });
    const result = JSON.parse(await handler('add_comment', { item_id: task.key, body: 'from chat' }));
    expect(result.success).toBe(true);
    expect(result.comment.author).toBe('chat-llm');
    expect(services.comments.listByItem(task.id)).toHaveLength(1);
  });

  it('get_item resolves a ticket key and includes comments', async () => {
    const task = services.items.create({
      project_id: projectId, type: 'task', title: 'readable', column_id: cols()[0].id,
    });
    services.comments.create({ item_id: task.id, body: 'note', author: 'user' });
    const result = JSON.parse(await handler('get_item', { item_id: task.key.toLowerCase() }));
    expect(result.item.id).toBe(task.id);
    expect(result.comments).toHaveLength(1);
  });

  it('rejects items from another project', async () => {
    const otherProject = services.projects.create({ name: 'other' });
    const foreign = services.items.create({
      project_id: otherProject.id, type: 'task', title: 'foreign', column_id: cols()[0].id,
    });
    const result = await handler('get_item', { item_id: foreign.id });
    expect(result).toBe('Error: item not found in this project');
  });

  it('delegates planning tools (create_item) with llm actor', async () => {
    const result = JSON.parse(await handler('create_item', {
      type: 'task', title: 'follow-up from chat', column_id: cols()[0].id,
    }));
    expect(result.success).toBe(true);
    expect(result.item.key).toBeTruthy();
  });
});
