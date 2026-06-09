import type Database from 'better-sqlite3';
import * as migration001 from './migrations/001_initial_conversations.js';
import * as migration002 from './migrations/002_planning_actor.js';

const MIGRATIONS = [migration001, migration002];

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
    console.log(`[migration] applied: ${migration.name}`);
  }
}
