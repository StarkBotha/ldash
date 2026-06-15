import type Database from 'better-sqlite3';

export const name = '010_kb_conversation_type';

// SQLite cannot alter a CHECK constraint, so the conversations table must be
// rebuilt to admit the new whole-knowledgebase chat type 'kb' alongside the
// existing 'item' and 'planning' types.
//
// Foreign key enforcement MUST be disabled while this runs (the runner does
// this via the disableForeignKeys flag): with FKs on, DROP TABLE conversations
// would fire ON DELETE actions and cascade-delete messages. The copy/drop/
// rename order keeps messages' "REFERENCES conversations(id)" clause pointing
// at the rebuilt table by name.
export const disableForeignKeys = true;

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE conversations_new (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      item_id    TEXT REFERENCES items(id) ON DELETE CASCADE,
      type       TEXT NOT NULL CHECK (type IN ('item', 'planning', 'kb')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    INSERT INTO conversations_new (id, project_id, item_id, type, created_at)
      SELECT id, project_id, item_id, type, created_at FROM conversations;

    DROP TABLE conversations;

    ALTER TABLE conversations_new RENAME TO conversations;

    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_item    ON conversations(item_id);
  `);

  // Sanity check: the rebuild must not have introduced any FK violations.
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error('010_kb_conversation_type: foreign_key_check failed: ' + JSON.stringify(violations));
  }
}
