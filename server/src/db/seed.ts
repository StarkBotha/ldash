import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

const DEFAULT_COLUMNS = [
  { position: 0, name: 'Backlog' },
  { position: 1, name: 'In Progress' },
  { position: 2, name: 'Review' },
  { position: 3, name: 'Done' },
];

export function seedColumns(db: Database.Database): void {
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM columns').get() as { cnt: number }).cnt;
  if (count > 0) return;

  const insert = db.prepare(
    'INSERT INTO columns (id, name, position) VALUES (?, ?, ?)'
  );

  const seedAll = db.transaction(() => {
    for (const col of DEFAULT_COLUMNS) {
      insert.run(nanoid(), col.name, col.position);
    }
  });

  seedAll();
}
