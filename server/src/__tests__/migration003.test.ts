import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ActivityService } from '../services/activity.js';
import { ProjectService } from '../services/projects.js';
import { ItemService } from '../services/items.js';
import { ColumnService } from '../services/columns.js';

function createDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);
  return db;
}

describe('migration 003_system_actor', () => {
  it('allows actor_type system in activity entries', () => {
    const db = createDb();
    const actSvc = new ActivityService(db);
    const projectSvc = new ProjectService(db);
    const itemSvc = new ItemService(db);
    const colSvc = new ColumnService(db);

    const project = projectSvc.create({ name: 'P' });
    const col = colSvc.list()[0];
    const item = itemSvc.create({ project_id: project.id, type: 'task', title: 'T', column_id: col.id });

    // Should not throw — 'system' is now a valid actor_type
    const entry = actSvc.append({
      item_id: item.id,
      project_id: project.id,
      actor_type: 'system',
      actor_id: 'rollup',
      event_type: 'item.moved',
      payload: { from_column_id: 'x', to_column_id: 'y' },
    });

    expect(entry.actor_type).toBe('system');
    expect(entry.actor_id).toBe('rollup');
  });

  it('migration is idempotent (applied twice does not fail, second run is skipped)', () => {
    // Running runMigrations twice should be safe
    const db = createDb();
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('activity table has correct CHECK constraint after migration', () => {
    const db = createDb();
    const actSvc = new ActivityService(db);
    const projectSvc = new ProjectService(db);
    const colSvc = new ColumnService(db);

    const project = projectSvc.create({ name: 'P' });

    // All valid actor types should work
    for (const actorType of ['user', 'claude', 'llm', 'system'] as const) {
      expect(() =>
        actSvc.append({
          project_id: project.id,
          actor_type: actorType,
          actor_id: 'test',
          event_type: 'test.event',
        })
      ).not.toThrow();
    }
  });
});
