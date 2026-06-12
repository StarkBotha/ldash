import type Database from 'better-sqlite3';

export const name = '008_kb_documents';

// Per-project knowledgebase documents: markdown docs (architecture notes,
// runbooks, mermaid diagrams) maintained by humans and Claude Code agents.
// Not board items — deleting a project removes its docs via ON DELETE CASCADE.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kb_documents_project ON kb_documents(project_id);
  `);
}
