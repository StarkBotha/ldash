import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Column } from '../types.js';

interface ColumnRow {
  id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

function rowToColumn(row: ColumnRow): Column {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ColumnService {
  constructor(private db: Database.Database) {}

  list(): Column[] {
    const rows = this.db
      .prepare('SELECT * FROM columns ORDER BY position ASC')
      .all() as ColumnRow[];
    return rows.map(rowToColumn);
  }

  get(id: string): Column | undefined {
    const row = this.db
      .prepare('SELECT * FROM columns WHERE id = ?')
      .get(id) as ColumnRow | undefined;
    return row ? rowToColumn(row) : undefined;
  }

  create(data: { name: string }): Column {
    const maxRow = this.db
      .prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM columns')
      .get() as { maxPos: number };
    const position = maxRow.maxPos + 1;
    const id = nanoid();
    this.db
      .prepare('INSERT INTO columns (id, name, position) VALUES (?, ?, ?)')
      .run(id, data.name, position);
    return this.get(id) as Column;
  }

  update(id: string, data: { name: string }): Column {
    this.db
      .prepare("UPDATE columns SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(data.name, id);
    return this.get(id) as Column;
  }

  reorder(orderedIds: string[]): Column[] {
    const updateStmt = this.db.prepare(
      "UPDATE columns SET position = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    );

    const doReorder = this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        updateStmt.run(i, orderedIds[i]);
      }
    });

    doReorder();
    return this.list();
  }

  countItems(id: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM items WHERE column_id = ?')
      .get(id) as { cnt: number };
    return row.cnt;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM columns WHERE id = ?').run(id);
  }
}
