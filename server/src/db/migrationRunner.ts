import type Database from 'better-sqlite3';
import * as migration001 from './migrations/001_initial_conversations.js';
import * as migration002 from './migrations/002_planning_actor.js';
import * as migration003 from './migrations/003_system_actor.js';
import { createLogger } from '../logger.js';

const logger = createLogger('db');
const MIGRATIONS = [migration001, migration002, migration003];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const checkStmt = db.prepare('SELECT id FROM migrations WHERE name = ?');
  const insertStmt = db.prepare(
    "INSERT INTO migrations (name) VALUES (?)"
  );

  for (const migration of MIGRATIONS) {
    const existing = checkStmt.get(migration.name);
    if (existing) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      insertStmt.run(migration.name);
    });

    apply();
    logger.info('migration applied', { name: migration.name });
  }
}
