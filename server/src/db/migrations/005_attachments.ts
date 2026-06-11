import type Database from 'better-sqlite3';

export const name = '005_attachments';

// Image attachments on items. Bytes live in the row (BLOB); deleting an item
// removes its attachments via ON DELETE CASCADE (same approach as comments).
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      filename   TEXT NOT NULL,
      mime       TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data       BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_item ON attachments(item_id);
  `);
}
