import type Database from 'better-sqlite3';
import * as migration001 from './migrations/001_initial_conversations.js';
import * as migration002 from './migrations/002_planning_actor.js';
import * as migration003 from './migrations/003_system_actor.js';
import * as migration004 from './migrations/004_ticket_numbers.js';
import * as migration005 from './migrations/005_attachments.js';
import * as migration006 from './migrations/006_bug_investigation_types.js';
import * as migration007 from './migrations/007_cancelled_column.js';
import { createLogger } from '../logger.js';

const logger = createLogger('db');

interface Migration {
  name: string;
  up: (db: Database.Database) => void;
  /** Table-rebuild migrations set this so FK enforcement (and its ON DELETE
   *  actions) is suspended around the rebuild. PRAGMA foreign_keys is a no-op
   *  inside a transaction, so the runner toggles it outside the transaction. */
  disableForeignKeys?: boolean;
}

const MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007];

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

    if (migration.disableForeignKeys) {
      const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
      db.pragma('foreign_keys = OFF');
      try {
        apply();
      } finally {
        if (fkWasOn) db.pragma('foreign_keys = ON');
      }
    } else {
      apply();
    }
    logger.info('migration applied', { name: migration.name });
  }
}
