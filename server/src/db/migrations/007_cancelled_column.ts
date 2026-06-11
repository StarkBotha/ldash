import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

export const name = '007_cancelled_column';

// Adds a nullable `role` column to the columns table so columns can carry
// explicit semantics independent of their name or position, and appends a
// "Cancelled" column (role='cancelled') after the last existing column.
//
// The rollup resolves the done column as "last column whose role is not
// 'cancelled'", so Cancelled sitting after Done does not break the
// positional first/second/last semantics for backlog/in-progress/done.
//
// On a fresh database the columns table is still empty when this runs
// (seedColumns runs after migrations), so the insert is skipped here and
// the seed creates Cancelled instead.
export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE columns ADD COLUMN role TEXT`);

  const count = (db.prepare('SELECT COUNT(*) AS cnt FROM columns').get() as { cnt: number }).cnt;
  if (count === 0) return;

  const existing = db
    .prepare("SELECT id FROM columns WHERE role = 'cancelled'")
    .get();
  if (existing) return;

  const maxRow = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM columns')
    .get() as { maxPos: number };

  db.prepare("INSERT INTO columns (id, name, position, role) VALUES (?, 'Cancelled', ?, 'cancelled')")
    .run(nanoid(), maxRow.maxPos + 1);
}
