import type Database from 'better-sqlite3';

export const name = '011_column_changed_at';

// Adds a `column_changed_at` timestamp to items, recording when an item last
// changed columns (i.e. when it was moved). Powers UI filters like "show only
// items moved to Done today".
//
// Plain ADD COLUMN — no table rebuild and no FK toggling needed. Existing rows
// are backfilled with their created_at so the column is never null.
//
// This is the sole definer of the column: schema.ts (the frozen baseline) does
// NOT declare it, because on a fresh DB schema.ts runs first and all migrations
// run after it — declaring it in both would make this ADD COLUMN fail with
// "duplicate column".
export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE items ADD COLUMN column_changed_at TEXT`);
  db.exec(`UPDATE items SET column_changed_at = created_at WHERE column_changed_at IS NULL`);
}
