import type Database from 'better-sqlite3';

export const name = '006_bug_investigation_types';

// SQLite cannot alter a CHECK constraint, so the items table must be rebuilt
// to admit the new leaf work item types 'bug' and 'investigation'.
//
// Foreign key enforcement MUST be disabled while this runs (the runner does
// this via the disableForeignKeys flag): with FKs on, DROP TABLE items would
// fire ON DELETE actions and cascade-delete comments/attachments and null out
// activity rows. The copy/drop/rename order keeps every other table's
// "REFERENCES items(id)" clause pointing at the rebuilt table by name.
export const disableForeignKeys = true;

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE items_new (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id   TEXT REFERENCES items(id) ON DELETE SET NULL,
      type        TEXT NOT NULL CHECK (type IN ('epic', 'story', 'task', 'bug', 'investigation')),
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      column_id   TEXT NOT NULL REFERENCES columns(id),
      position    INTEGER NOT NULL DEFAULT 0,
      flagged     INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
      blocked     INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
      blocked_reason TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      number      INTEGER NOT NULL DEFAULT 0,
      key         TEXT NOT NULL DEFAULT ''
    );

    INSERT INTO items_new (id, project_id, parent_id, type, title, description, column_id, position,
                           flagged, blocked, blocked_reason, created_at, updated_at, number, key)
      SELECT id, project_id, parent_id, type, title, description, column_id, position,
             flagged, blocked, blocked_reason, created_at, updated_at, number, key
      FROM items;

    DROP TABLE items;

    ALTER TABLE items_new RENAME TO items;

    CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id);
    CREATE INDEX IF NOT EXISTS idx_items_column  ON items(column_id);
    CREATE INDEX IF NOT EXISTS idx_items_parent  ON items(parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_key ON items(key);
  `);

  // Sanity check: the rebuild must not have introduced any FK violations.
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error('006_bug_investigation_types: foreign_key_check failed: ' + JSON.stringify(violations));
  }
}
