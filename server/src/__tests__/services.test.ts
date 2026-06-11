import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ProjectService } from '../services/projects.js';
import { ColumnService } from '../services/columns.js';
import { ItemService } from '../services/items.js';
import { CommentService } from '../services/comments.js';
import { ActivityService } from '../services/activity.js';
import { SettingsService } from '../services/settings.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);
  return db;
}

describe('ProjectService', () => {
  let db: Database.Database;
  let svc: ProjectService;

  beforeEach(() => {
    db = makeDb();
    svc = new ProjectService(db);
  });

  it('list returns empty array initially', () => {
    expect(svc.list()).toEqual([]);
  });

  it('create and get round-trip', () => {
    const p = svc.create({ name: 'Alpha' });
    expect(p.id).toBeTruthy();
    expect(svc.get(p.id)).toMatchObject({ name: 'Alpha', description: '' });
  });

  it('update only provided fields', () => {
    const p = svc.create({ name: 'Beta', description: 'Original' });
    const updated = svc.update(p.id, { name: 'Beta2' });
    expect(updated.name).toBe('Beta2');
    expect(updated.description).toBe('Original');
  });

  it('delete removes the project', () => {
    const p = svc.create({ name: 'Gamma' });
    svc.delete(p.id);
    expect(svc.get(p.id)).toBeUndefined();
  });
});

describe('ColumnService', () => {
  let db: Database.Database;
  let svc: ColumnService;

  beforeEach(() => {
    db = makeDb();
    svc = new ColumnService(db);
  });

  it('list returns 5 seeded columns', () => {
    const cols = svc.list();
    expect(cols).toHaveLength(5);
    expect(cols[0].name).toBe('Backlog');
    expect(cols[4].name).toBe('Cancelled');
  });

  it('create appends at end', () => {
    const col = svc.create({ name: 'QA' });
    expect(col.position).toBe(5);
  });

  it('reorder updates positions correctly', () => {
    const cols = svc.list();
    const reversed = [...cols].reverse().map((c) => c.id);
    const updated = svc.reorder(reversed);
    expect(updated[0].id).toBe(reversed[0]);
    expect(updated[0].position).toBe(0);
  });

  it('countItems returns 0 for column with no items', () => {
    const cols = svc.list();
    expect(svc.countItems(cols[0].id)).toBe(0);
  });
});

describe('ItemService', () => {
  let db: Database.Database;
  let itemSvc: ItemService;
  let projectSvc: ProjectService;
  let colSvc: ColumnService;
  let projectId: string;
  let colId: string;

  beforeEach(() => {
    db = makeDb();
    itemSvc = new ItemService(db);
    projectSvc = new ProjectService(db);
    colSvc = new ColumnService(db);
    const project = projectSvc.create({ name: 'P' });
    projectId = project.id;
    colId = colSvc.list()[0].id;
  });

  it('create assigns position 0 for first item', () => {
    const item = itemSvc.create({ project_id: projectId, type: 'task', title: 'T', column_id: colId });
    expect(item.position).toBe(0);
    expect(item.flagged).toBe(false);
    expect(item.blocked).toBe(false);
  });

  it('create auto-increments position', () => {
    itemSvc.create({ project_id: projectId, type: 'task', title: 'T1', column_id: colId });
    const t2 = itemSvc.create({ project_id: projectId, type: 'task', title: 'T2', column_id: colId });
    expect(t2.position).toBe(1);
  });

  it('move changes column_id', () => {
    const item = itemSvc.create({ project_id: projectId, type: 'task', title: 'T', column_id: colId });
    const newColId = colSvc.list()[1].id;
    const moved = itemSvc.move(item.id, { column_id: newColId });
    expect(moved.column_id).toBe(newColId);
  });

  it('setFlag toggles flagged', () => {
    const item = itemSvc.create({ project_id: projectId, type: 'task', title: 'T', column_id: colId });
    expect(itemSvc.setFlag(item.id, true).flagged).toBe(true);
    expect(itemSvc.setFlag(item.id, false).flagged).toBe(false);
  });

  it('setBlock sets and clears blocked state', () => {
    const item = itemSvc.create({ project_id: projectId, type: 'task', title: 'T', column_id: colId });
    const blocked = itemSvc.setBlock(item.id, true, 'Reason');
    expect(blocked.blocked).toBe(true);
    expect(blocked.blocked_reason).toBe('Reason');
    const unblocked = itemSvc.setBlock(item.id, false, '');
    expect(unblocked.blocked).toBe(false);
    expect(unblocked.blocked_reason).toBe('');
  });

  it('delete sets parent_id to null on children', () => {
    const parent = itemSvc.create({ project_id: projectId, type: 'epic', title: 'P', column_id: colId });
    const child = itemSvc.create({ project_id: projectId, type: 'story', title: 'C', column_id: colId, parent_id: parent.id });
    expect(child.parent_id).toBe(parent.id);
    itemSvc.delete(parent.id);
    expect(itemSvc.get(child.id)?.parent_id).toBeNull();
  });
});

describe('CommentService', () => {
  let db: Database.Database;
  let commentSvc: CommentService;
  let itemId: string;

  beforeEach(() => {
    db = makeDb();
    commentSvc = new CommentService(db);
    const projectSvc = new ProjectService(db);
    const itemSvc = new ItemService(db);
    const colSvc = new ColumnService(db);
    const project = projectSvc.create({ name: 'P' });
    const colId = colSvc.list()[0].id;
    const item = itemSvc.create({ project_id: project.id, type: 'task', title: 'I', column_id: colId });
    itemId = item.id;
  });

  it('create and listByItem round-trip', () => {
    const c = commentSvc.create({ item_id: itemId, body: 'Hello' });
    expect(c.author).toBe('user');
    const list = commentSvc.listByItem(itemId);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c.id);
  });

  it('delete removes comment', () => {
    const c = commentSvc.create({ item_id: itemId, body: 'Bye' });
    commentSvc.delete(c.id);
    expect(commentSvc.listByItem(itemId)).toHaveLength(0);
  });
});

describe('ActivityService', () => {
  let db: Database.Database;
  let actSvc: ActivityService;
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    db = makeDb();
    actSvc = new ActivityService(db);
    const projectSvc = new ProjectService(db);
    const itemSvc = new ItemService(db);
    const colSvc = new ColumnService(db);
    const project = projectSvc.create({ name: 'P' });
    projectId = project.id;
    const colId = colSvc.list()[0].id;
    const item = itemSvc.create({ project_id: projectId, type: 'task', title: 'I', column_id: colId });
    itemId = item.id;
  });

  it('append stores and returns entry with parsed payload', () => {
    const entry = actSvc.append({
      project_id: projectId,
      item_id: itemId,
      event_type: 'test.event',
      payload: { foo: 'bar' },
    });
    expect(entry.id).toBeTruthy();
    expect(entry.payload).toEqual({ foo: 'bar' });
  });

  it('listByProject returns entries for project in DESC order', () => {
    actSvc.append({ project_id: projectId, event_type: 'e1' });
    actSvc.append({ project_id: projectId, event_type: 'e2' });
    const entries = actSvc.listByProject(projectId, { limit: 50 });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].created_at >= entries[1].created_at).toBe(true);
  });

  it('listByItem returns only item entries', () => {
    actSvc.append({ project_id: projectId, item_id: itemId, event_type: 'item.e1' });
    actSvc.append({ project_id: projectId, event_type: 'project.e1' });
    const entries = actSvc.listByItem(itemId, { limit: 50 });
    expect(entries.every((e) => e.item_id === itemId)).toBe(true);
  });

  it('before cursor filters correctly', () => {
    actSvc.append({ project_id: projectId, event_type: 'early' });
    const middle = actSvc.append({ project_id: projectId, event_type: 'middle' });
    actSvc.append({ project_id: projectId, event_type: 'late' });

    const entries = actSvc.listByProject(projectId, { limit: 50, before: middle.created_at });
    expect(entries.every((e) => e.created_at < middle.created_at)).toBe(true);
  });
});

describe('SettingsService', () => {
  let db: Database.Database;
  let svc: SettingsService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runSchema(db);
    svc = new SettingsService(db);
  });

  it('returns empty settings when none saved', () => {
    const s = svc.getGatewaySettings();
    expect(s.providers).toEqual([]);
    expect(s.activeProvider).toBeNull();
  });

  it('claude-subscription with no model is valid', () => {
    expect(() =>
      svc.setGatewaySettings({
        providers: [{ name: 'Claude', type: 'claude-subscription' }],
        activeProvider: 'Claude',
      })
    ).not.toThrow();

    const saved = svc.getGatewaySettings();
    expect(saved.providers[0].model).toBeUndefined();
  });

  it('claude-subscription with explicit model saves it', () => {
    svc.setGatewaySettings({
      providers: [{ name: 'Claude', type: 'claude-subscription', model: 'claude-opus-4-8' }],
      activeProvider: 'Claude',
    });
    const saved = svc.getGatewaySettings();
    expect(saved.providers[0].model).toBe('claude-opus-4-8');
  });

  it('openai-compatible without model is rejected', () => {
    expect(() =>
      svc.setGatewaySettings({
        providers: [{ name: 'OAI', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: 'k' }],
        activeProvider: 'OAI',
      })
    ).toThrow(/must have a model/);
  });

  it('openai-compatible with model saves correctly', () => {
    svc.setGatewaySettings({
      providers: [{ name: 'OAI', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: 'mykey', model: 'llama3' }],
      activeProvider: 'OAI',
    });
    const saved = svc.getGatewaySettings();
    expect(saved.providers[0].model).toBe('llama3');
  });
});
