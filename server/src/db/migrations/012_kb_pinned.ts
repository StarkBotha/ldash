import type Database from 'better-sqlite3';

export const name = '012_kb_pinned';

// Adds a `pinned` flag to knowledgebase documents. Pinned docs sort to the top
// of the KB sidebar and stay visible even while a search/filter is active.
//
// Plain ADD COLUMN — no table rebuild and no FK toggling needed. Stored as an
// INTEGER 0/1 (SQLite has no native boolean); existing rows default to 0
// (unpinned). This is the sole definer of the column; schema.ts (the frozen
// baseline) does not declare it.
export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE kb_documents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
}
