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
import { buildItemChatContext } from '../../src/gateway/context.js';
import type { Services } from '../../src/types.js';

function createTestServices() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runSchema(db);
  runMigrations(db);
  seedColumns(db);

  const projects = new ProjectService(db);
  const columns = new ColumnService(db);
  const items = new ItemService(db);
  const comments = new CommentService(db);
  const activity = new ActivityService(db);
  const conversations = new ConversationService(db);
  const settings = new SettingsService(db);

  const attachments = new AttachmentService(db, activity, new EventBus());

  const services: Services = { projects, items, columns, comments, attachments, activity, conversations, settings };

  return { db, services, projects, columns, items, comments, activity };
}

describe('buildItemChatContext', () => {
  let services: Services;
  let projectId: string;
  let defaultColumnId: string;

  beforeEach(() => {
    const ctx = createTestServices();
    services = ctx.services;

    const project = ctx.projects.create({ name: 'Test Project' });
    projectId = project.id;

    const cols = ctx.columns.list();
    defaultColumnId = cols[0].id;
  });

  it('includes item title, type, and column name', () => {
    const inProgressCol = services.columns.list().find((c) => c.name === 'In Progress');
    const columnId = inProgressCol?.id ?? defaultColumnId;

    const item = services.items.create({
      project_id: projectId,
      type: 'task',
      title: 'My Task',
      column_id: columnId,
    });

    const ctx = buildItemChatContext(services, item.id);

    expect(ctx).toContain('My Task');
    expect(ctx).toContain('In Progress');
  });

  it('includes parent item when parent_id is set', () => {
    const epic = services.items.create({
      project_id: projectId,
      type: 'epic',
      title: 'Parent Epic',
      column_id: defaultColumnId,
    });

    const story = services.items.create({
      project_id: projectId,
      type: 'story',
      title: 'Child Story',
      column_id: defaultColumnId,
      parent_id: epic.id,
    });

    const ctx = buildItemChatContext(services, story.id);

    expect(ctx).toContain('PARENT ITEM');
    expect(ctx).toContain('Parent Epic');
  });

  it('omits parent section when item has no parent', () => {
    const epic = services.items.create({
      project_id: projectId,
      type: 'epic',
      title: 'Top Level Epic',
      column_id: defaultColumnId,
    });

    const ctx = buildItemChatContext(services, epic.id);

    expect(ctx).not.toContain('PARENT ITEM');
  });

  it('includes children up to 10', () => {
    const story = services.items.create({
      project_id: projectId,
      type: 'story',
      title: 'Story',
      column_id: defaultColumnId,
    });

    // Create 12 children
    for (let i = 0; i < 12; i++) {
      services.items.create({
        project_id: projectId,
        type: 'task',
        title: `Task ${i + 1}`,
        column_id: defaultColumnId,
        parent_id: story.id,
      });
    }

    const ctx = buildItemChatContext(services, story.id);

    expect(ctx).toContain('CHILD ITEMS (10)');
    expect(ctx).not.toContain('Task 11');
    expect(ctx).not.toContain('Task 12');
  });

  it('includes last 10 comments', () => {
    const item = services.items.create({
      project_id: projectId,
      type: 'task',
      title: 'Commented Item',
      column_id: defaultColumnId,
    });

    for (let i = 1; i <= 12; i++) {
      services.comments.create({ item_id: item.id, body: `Comment ${i.toString().padStart(3, '0')}`, author: 'user' });
    }

    const ctx = buildItemChatContext(services, item.id);

    // Should include last 10 (012 to 003 zero-padded, so 003-012 are the last 10)
    expect(ctx).toContain('Comment 012');
    expect(ctx).toContain('Comment 003');
    expect(ctx).not.toContain('Comment 001');
    expect(ctx).not.toContain('Comment 002');
  });

  it('includes last 20 activity entries in chronological order', () => {
    const item = services.items.create({
      project_id: projectId,
      type: 'task',
      title: 'Activity Item',
      column_id: defaultColumnId,
    });

    // Insert 25 entries with distinct timestamps (use raw DB to control timestamp)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (services.activity as any).db as import('better-sqlite3').Database;
    for (let i = 1; i <= 25; i++) {
      const ts = `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z`;
      db.prepare(
        'INSERT INTO activity (id, item_id, project_id, actor_type, actor_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        `act-${i}`,
        item.id,
        projectId,
        'user',
        'user',
        'seq.event',
        JSON.stringify({ seq: i }),
        ts
      );
    }

    const ctx = buildItemChatContext(services, item.id);

    // Should include exactly 20 entries (the most recent: seq 6-25)
    expect(ctx).toContain('RECENT ACTIVITY (last 20 entries)');

    // Count occurrences of the event_type to verify exactly 20 entries
    const eventMatches = ctx.match(/seq\.event/g);
    expect(eventMatches).toHaveLength(20);

    // The context assembles in chronological order (reversed from DESC query)
    // so seq numbers should be ascending in the output
    const seqMatches = [...ctx.matchAll(/"seq":(\d+)/g)].map((m) => parseInt(m[1], 10));
    expect(seqMatches).toHaveLength(20);

    // Each subsequent entry should have a higher seq number (chronological order)
    for (let i = 0; i < seqMatches.length - 1; i++) {
      expect(seqMatches[i]).toBeLessThan(seqMatches[i + 1]);
    }

    // First entry should be seq 6 (oldest of the last 20), last should be seq 25
    expect(seqMatches[0]).toBe(6);
    expect(seqMatches[19]).toBe(25);
  });

  it('omits children section when item has no children', () => {
    const item = services.items.create({
      project_id: projectId,
      type: 'task',
      title: 'Leaf Task',
      column_id: defaultColumnId,
    });

    const ctx = buildItemChatContext(services, item.id);

    expect(ctx).not.toContain('CHILD ITEMS');
  });

  it('includes flagged and blocked status', () => {
    const item = services.items.create({
      project_id: projectId,
      type: 'task',
      title: 'Blocked Task',
      column_id: defaultColumnId,
    });

    services.items.setBlock(item.id, true, 'Waiting for API');

    const ctx = buildItemChatContext(services, item.id);

    expect(ctx).toContain('Blocked: Yes');
    expect(ctx).toContain('Waiting for API');
  });
});
