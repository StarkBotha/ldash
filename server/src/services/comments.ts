import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Comment } from '../types.js';

interface CommentRow {
  id: string;
  item_id: string;
  author: string;
  body: string;
  created_at: string;
}

function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id,
    item_id: row.item_id,
    author: row.author,
    body: row.body,
    created_at: row.created_at,
  };
}

export class CommentService {
  constructor(private db: Database.Database) {}

  listByItem(itemId: string): Comment[] {
    const rows = this.db
      .prepare('SELECT * FROM comments WHERE item_id = ? ORDER BY created_at ASC')
      .all(itemId) as CommentRow[];
    return rows.map(rowToComment);
  }

  get(id: string): Comment | undefined {
    const row = this.db
      .prepare('SELECT * FROM comments WHERE id = ?')
      .get(id) as CommentRow | undefined;
    return row ? rowToComment(row) : undefined;
  }

  create(data: { item_id: string; body: string; author?: string }): Comment {
    const id = nanoid();
    this.db
      .prepare('INSERT INTO comments (id, item_id, author, body) VALUES (?, ?, ?, ?)')
      .run(id, data.item_id, data.author ?? 'user', data.body);
    return this.get(id) as Comment;
  }

  update(id: string, data: { body: string }): Comment {
    const existing = this.get(id);
    if (!existing) {
      throw new Error('Comment not found');
    }
    this.db.prepare('UPDATE comments SET body = ? WHERE id = ?').run(data.body, id);
    return this.get(id) as Comment;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  }
}
