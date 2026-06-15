import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ProjectService } from '../services/projects.js';
import { ItemService } from '../services/items.js';
import { ColumnService } from '../services/columns.js';

let db: Database.Database;
let items: ItemService;
let columns: ColumnService;
let projectId: string;
let firstColId: string;
let secondColId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);

  const projects = new ProjectService(db);
  items = new ItemService(db);
  columns = new ColumnService(db);

  projectId = projects.create({ name: 'CCA Project' }).id;
  const cols = columns.list();
  firstColId = cols[0].id;
  secondColId = cols[1].id;
});

describe('column_changed_at', () => {
  it('create() sets column_changed_at non-null and equal to created_at', () => {
    const item = items.create({
      project_id: projectId,
      type: 'task',
      title: 'New Task',
      column_id: firstColId,
    });
    expect(item.column_changed_at).toBeTruthy();
    expect(item.column_changed_at).toBe(item.created_at);
  });

  it('move() updates column_changed_at to a newer value than before the move', async () => {
    const item = items.create({
      project_id: projectId,
      type: 'task',
      title: 'Mover',
      column_id: firstColId,
    });
    const before = item.column_changed_at;

    // ensure the clock advances past the millisecond-resolution timestamp
    await new Promise((r) => setTimeout(r, 5));

    const moved = items.move(item.id, { column_id: secondColId });
    expect(moved.column_changed_at > before).toBe(true);
  });

  it('move() updates column_changed_at for internal (rollup-driven) moves too', async () => {
    const item = items.create({
      project_id: projectId,
      type: 'task',
      title: 'InternalMover',
      column_id: firstColId,
    });
    const before = item.column_changed_at;

    await new Promise((r) => setTimeout(r, 5));

    const moved = items.move(item.id, { column_id: secondColId }, { internal: true });
    expect(moved.column_changed_at > before).toBe(true);
  });
});
