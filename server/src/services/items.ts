import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { isWorkItemType, type Item, type ItemType } from '../types.js';

interface ItemRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  number: number;
  key: string;
  title: string;
  description: string;
  column_id: string;
  position: number;
  flagged: number;
  blocked: number;
  blocked_reason: string;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: ItemRow): Item {
  return {
    id: row.id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    type: row.type as ItemType,
    number: row.number,
    key: row.key,
    title: row.title,
    description: row.description,
    column_id: row.column_id,
    position: row.position,
    flagged: row.flagged === 1,
    blocked: row.blocked === 1,
    blocked_reason: row.blocked_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ItemService {
  constructor(private db: Database.Database) {}

  listByProject(projectId: string): Item[] {
    const rows = this.db
      .prepare('SELECT * FROM items WHERE project_id = ? ORDER BY column_id ASC, position ASC')
      .all(projectId) as ItemRow[];
    return rows.map(rowToItem);
  }

  get(id: string): Item | undefined {
    const row = this.db
      .prepare('SELECT * FROM items WHERE id = ?')
      .get(id) as ItemRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  getByKey(key: string): Item | undefined {
    const row = this.db
      .prepare('SELECT * FROM items WHERE key = ? COLLATE NOCASE')
      .get(key) as ItemRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  search(projectId: string, query: string): Item[] {
    const like = '%' + query.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const rows = this.db
      .prepare(
        "SELECT * FROM items WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\') ORDER BY number ASC"
      )
      .all(projectId, like, like, like) as ItemRow[];
    return rows.map(rowToItem);
  }

  create(data: {
    project_id: string;
    parent_id?: string | null;
    type: ItemType;
    title: string;
    description?: string;
    column_id: string;
  }): Item {
    const posRow = this.db
      .prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM items WHERE column_id = ? AND project_id = ?')
      .get(data.column_id, data.project_id) as { maxPos: number };
    const position = posRow.maxPos + 1;
    const id = nanoid();

    const insert = this.db.transaction(() => {
      const proj = this.db
        .prepare('SELECT prefix, next_number FROM projects WHERE id = ?')
        .get(data.project_id) as { prefix: string; next_number: number } | undefined;
      if (!proj) {
        throw new Error('Project not found: ' + data.project_id);
      }

      this.db
        .prepare(
          'INSERT INTO items (id, project_id, parent_id, type, number, key, title, description, column_id, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          id,
          data.project_id,
          data.parent_id ?? null,
          data.type,
          proj.next_number,
          `${proj.prefix}-${proj.next_number}`,
          data.title,
          data.description ?? '',
          data.column_id,
          position
        );

      this.db
        .prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?')
        .run(data.project_id);
    });
    insert();

    return this.get(id) as Item;
  }

  update(id: string, data: Partial<{ title: string; description: string; parent_id: string | null; type: ItemType }>): Item {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.type !== undefined) {
      const item = this.get(id);
      if (item && data.type !== item.type) {
        if (!isWorkItemType(item.type) || !isWorkItemType(data.type)) {
          throw new Error(
            'Type can only be changed between work item types (task, bug, investigation) — cannot convert ' +
              item.type + ' to ' + data.type
          );
        }
        fields.push('type = ?');
        values.push(data.type);
      }
    }

    if (data.title !== undefined) {
      fields.push('title = ?');
      values.push(data.title);
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      values.push(data.description);
    }
    if ('parent_id' in data) {
      fields.push('parent_id = ?');
      values.push(data.parent_id ?? null);
    }

    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    values.push(id);

    this.db
      .prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.get(id) as Item;
  }

  move(id: string, data: { column_id: string; position?: number }, opts?: { internal?: boolean }): Item {
    if (!opts?.internal) {
      const item = this.get(id);
      if (item && !isWorkItemType(item.type)) {
        throw new Error('Status of a ' + item.type + ' is derived from its tasks and cannot be set directly');
      }
    }

    let position = data.position;
    if (position === undefined) {
      const posRow = this.db
        .prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM items WHERE column_id = ?')
        .get(data.column_id) as { maxPos: number };
      position = posRow.maxPos + 1;
    }

    this.db
      .prepare("UPDATE items SET column_id = ?, position = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(data.column_id, position, id);

    return this.get(id) as Item;
  }

  setFlag(id: string, flagged: boolean): Item {
    this.db
      .prepare("UPDATE items SET flagged = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(flagged ? 1 : 0, id);
    return this.get(id) as Item;
  }

  setBlock(id: string, blocked: boolean, reason: string): Item {
    this.db
      .prepare("UPDATE items SET blocked = ?, blocked_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(blocked ? 1 : 0, reason, id);
    return this.get(id) as Item;
  }

  listFiltered(opts: {
    project_id: string;
    column_id?: string;
    type?: ItemType;
    parent_id?: string | null;
  }): Item[] {
    let sql = 'SELECT * FROM items WHERE project_id = ?';
    const params: unknown[] = [opts.project_id];

    if (opts.column_id !== undefined) {
      sql += ' AND column_id = ?';
      params.push(opts.column_id);
    }
    if (opts.type !== undefined) {
      sql += ' AND type = ?';
      params.push(opts.type);
    }
    if (opts.parent_id !== undefined) {
      if (opts.parent_id === 'null') {
        sql += ' AND parent_id IS NULL';
      } else {
        sql += ' AND parent_id = ?';
        params.push(opts.parent_id);
      }
    }

    sql += ' ORDER BY column_id ASC, position ASC';

    const rows = this.db.prepare(sql).all(...params) as ItemRow[];
    return rows.map(rowToItem);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
  }
}
