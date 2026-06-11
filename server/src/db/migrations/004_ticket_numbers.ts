import type Database from 'better-sqlite3';
import { derivePrefix } from '../../services/projectPrefix.js';

export const name = '004_ticket_numbers';

// Per-project ticket keys (e.g. DSW-12). Projects get an immutable prefix and a
// counter; items get a number and a stored key. Existing rows are backfilled in
// creation order. The migration runner wraps this in a transaction.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE projects ADD COLUMN prefix TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN next_number INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE items ADD COLUMN number INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE items ADD COLUMN key TEXT NOT NULL DEFAULT '';
  `);

  const projects = db
    .prepare('SELECT id, name FROM projects ORDER BY created_at ASC')
    .all() as { id: string; name: string }[];
  const taken = new Set<string>();
  const setPrefix = db.prepare('UPDATE projects SET prefix = ?, next_number = ? WHERE id = ?');
  const listItems = db.prepare('SELECT id FROM items WHERE project_id = ? ORDER BY created_at ASC, id ASC');
  const setItem = db.prepare('UPDATE items SET number = ?, key = ? WHERE id = ?');

  for (const project of projects) {
    const prefix = derivePrefix(project.name, taken);
    taken.add(prefix);

    const items = listItems.all(project.id) as { id: string }[];
    let n = 1;
    for (const item of items) {
      setItem.run(n, `${prefix}-${n}`, item.id);
      n++;
    }
    setPrefix.run(prefix, n, project.id);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_prefix ON projects(prefix);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_key ON items(key);
  `);
}
