import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Project } from '../types.js';

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ProjectService {
  constructor(private db: Database.Database) {}

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY created_at ASC')
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  get(id: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : undefined;
  }

  create(data: { name: string; description?: string }): Project {
    const id = nanoid();
    this.db
      .prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)')
      .run(id, data.name, data.description ?? '');
    return this.get(id) as Project;
  }

  update(id: string, data: Partial<{ name: string; description: string }>): Project {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      values.push(data.description);
    }

    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    values.push(id);

    this.db
      .prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.get(id) as Project;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
