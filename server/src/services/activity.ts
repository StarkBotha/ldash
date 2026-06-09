import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { ActivityEntry, ActorType } from '../types.js';

interface ActivityRow {
  id: string;
  item_id: string | null;
  project_id: string | null;
  actor_type: string;
  actor_id: string;
  event_type: string;
  payload: string;
  created_at: string;
}

function rowToEntry(row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    item_id: row.item_id,
    project_id: row.project_id,
    actor_type: row.actor_type as ActorType,
    actor_id: row.actor_id,
    event_type: row.event_type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

export class ActivityService {
  constructor(private db: Database.Database) {}

  append(data: {
    item_id?: string | null;
    project_id?: string | null;
    actor_type?: ActorType;
    actor_id?: string;
    event_type: string;
    payload?: Record<string, unknown>;
  }): ActivityEntry {
    const id = nanoid();
    this.db
      .prepare(
        'INSERT INTO activity (id, item_id, project_id, actor_type, actor_id, event_type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        data.item_id ?? null,
        data.project_id ?? null,
        data.actor_type ?? 'user',
        data.actor_id ?? 'user',
        data.event_type,
        JSON.stringify(data.payload ?? {})
      );

    const row = this.db
      .prepare('SELECT * FROM activity WHERE id = ?')
      .get(id) as ActivityRow;
    return rowToEntry(row);
  }

  listByProject(projectId: string, opts: { limit: number; before?: string }): ActivityEntry[] {
    let sql = 'SELECT * FROM activity WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (opts.before) {
      sql += ' AND created_at < ?';
      params.push(opts.before);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(opts.limit);

    const rows = this.db.prepare(sql).all(...params) as ActivityRow[];
    return rows.map(rowToEntry);
  }

  listByItem(itemId: string, opts: { limit: number; before?: string }): ActivityEntry[] {
    let sql = 'SELECT * FROM activity WHERE item_id = ?';
    const params: unknown[] = [itemId];

    if (opts.before) {
      sql += ' AND created_at < ?';
      params.push(opts.before);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(opts.limit);

    const rows = this.db.prepare(sql).all(...params) as ActivityRow[];
    return rows.map(rowToEntry);
  }
}
