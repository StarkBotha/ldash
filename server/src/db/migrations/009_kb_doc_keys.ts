import type Database from 'better-sqlite3';

export const name = '009_kb_doc_keys';

// Per-project knowledgebase keys (e.g. LDA-KB-1), mirroring item ticket keys
// (migration 004) but on their own counter so KB numbering is independent of
// board numbering. Projects get a next_kb_number counter; kb docs get a number
// and a stored key. Existing docs are backfilled in creation order. The
// migration runner wraps this in a transaction.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE projects ADD COLUMN next_kb_number INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE kb_documents ADD COLUMN number INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE kb_documents ADD COLUMN key TEXT NOT NULL DEFAULT '';
  `);

  const projects = db
    .prepare('SELECT id, prefix FROM projects ORDER BY created_at ASC')
    .all() as { id: string; prefix: string }[];
  const setKbNumber = db.prepare('UPDATE projects SET next_kb_number = ? WHERE id = ?');
  const listDocs = db.prepare(
    'SELECT id FROM kb_documents WHERE project_id = ? ORDER BY created_at ASC, id ASC'
  );
  const setDoc = db.prepare('UPDATE kb_documents SET number = ?, key = ? WHERE id = ?');

  for (const project of projects) {
    const docs = listDocs.all(project.id) as { id: string }[];
    let n = 1;
    for (const doc of docs) {
      setDoc.run(n, `${project.prefix}-KB-${n}`, doc.id);
      n++;
    }
    setKbNumber.run(n, project.id);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_documents_key ON kb_documents(key);
  `);
}
