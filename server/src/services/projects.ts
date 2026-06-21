import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Project } from '../types.js';
import { derivePrefix } from './projectPrefix.js';

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  prefix: string;
  repo_path: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prefix: row.prefix,
    repo_path: row.repo_path ?? null,
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

  create(data: { name: string; description?: string; repo_path?: string | null }): Project {
    const id = nanoid();
    const existing = this.db.prepare('SELECT prefix FROM projects').all() as { prefix: string }[];
    const prefix = derivePrefix(data.name, new Set(existing.map((r) => r.prefix)));
    this.db
      .prepare('INSERT INTO projects (id, name, description, prefix, repo_path) VALUES (?, ?, ?, ?, ?)')
      .run(id, data.name, data.description ?? '', prefix, data.repo_path ?? null);
    return this.get(id) as Project;
  }

  update(id: string, data: Partial<{ name: string; description: string; repo_path: string | null }>): Project {
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
    if (data.repo_path !== undefined) {
      fields.push('repo_path = ?');
      values.push(data.repo_path);
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
