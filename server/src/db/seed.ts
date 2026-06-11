import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

const DEFAULT_COLUMNS = [
  { position: 0, name: 'Backlog', role: null },
  { position: 1, name: 'In Progress', role: null },
  { position: 2, name: 'Review', role: null },
  { position: 3, name: 'Done', role: null },
  { position: 4, name: 'Cancelled', role: 'cancelled' },
];

export function seedColumns(db: Database.Database): void {
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM columns').get() as { cnt: number }).cnt;
  if (count > 0) return;

  const insert = db.prepare(
    'INSERT INTO columns (id, name, position, role) VALUES (?, ?, ?, ?)'
  );

  const seedAll = db.transaction(() => {
    for (const col of DEFAULT_COLUMNS) {
      insert.run(nanoid(), col.name, col.position, col.role);
    }
  });

  seedAll();
}
