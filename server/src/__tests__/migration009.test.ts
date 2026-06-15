import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { runSchema } from '../db/schema.js';
import * as m001 from '../db/migrations/001_initial_conversations.js';
import * as m002 from '../db/migrations/002_planning_actor.js';
import * as m003 from '../db/migrations/003_system_actor.js';
import * as m004 from '../db/migrations/004_ticket_numbers.js';
import * as m005 from '../db/migrations/005_attachments.js';
import * as m006 from '../db/migrations/006_bug_investigation_types.js';
import * as m007 from '../db/migrations/007_cancelled_column.js';
import * as m008 from '../db/migrations/008_kb_documents.js';
import * as m009 from '../db/migrations/009_kb_doc_keys.js';

interface Mig {
  name: string;
  up: (db: Database.Database) => void;
  disableForeignKeys?: boolean;
}

// Apply a migration the way the runner does, honouring its FK toggle.
function apply(db: Database.Database, mig: Mig) {
  const run = db.transaction(() => mig.up(db));
  if (mig.disableForeignKeys) {
    db.pragma('foreign_keys = OFF');
    try {
      run();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  } else {
    run();
  }
}

// A DB migrated up to 008 — kb_documents exists with NO number/key columns yet.
function dbAt008(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  for (const mig of [m001, m002, m003, m004, m005, m006, m007, m008] as Mig[]) {
    apply(db, mig);
  }
  return db;
}

function insertProject(db: Database.Database, name: string, prefix: string): string {
  const id = nanoid();
  db.prepare('INSERT INTO projects (id, name, prefix) VALUES (?, ?, ?)').run(id, name, prefix);
  return id;
}

function insertDoc(db: Database.Database, projectId: string, title: string, createdAt: string): string {
  const id = nanoid();
  db.prepare(
    'INSERT INTO kb_documents (id, project_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, projectId, title, '', createdAt);
  return id;
}

describe('migration 009_kb_doc_keys', () => {
  it('backfills keys in creation order and sets next_kb_number per project', () => {
    const db = dbAt008();
    const p1 = insertProject(db, 'ldash', 'LDA');
    const p2 = insertProject(db, 'gamma delta', 'GD');

    // p1 docs out of insertion order on purpose — backfill must follow created_at
    const d1b = insertDoc(db, p1, 'Second', '2026-01-02T00:00:00.000Z');
    const d1a = insertDoc(db, p1, 'First', '2026-01-01T00:00:00.000Z');
    const d2 = insertDoc(db, p2, 'Solo', '2026-01-01T00:00:00.000Z');

    apply(db, m009 as Mig);

    const keyOf = (id: string) =>
      (db.prepare('SELECT number, key FROM kb_documents WHERE id = ?').get(id) as {
        number: number;
        key: string;
      });

    expect(keyOf(d1a)).toEqual({ number: 1, key: 'LDA-KB-1' });
    expect(keyOf(d1b)).toEqual({ number: 2, key: 'LDA-KB-2' });
    expect(keyOf(d2)).toEqual({ number: 1, key: 'GD-KB-1' });

    const next = (id: string) =>
      (db.prepare('SELECT next_kb_number FROM projects WHERE id = ?').get(id) as {
        next_kb_number: number;
      }).next_kb_number;
    expect(next(p1)).toBe(3);
    expect(next(p2)).toBe(2);

    db.close();
  });

  it('enforces a unique index on kb_documents.key', () => {
    const db = dbAt008();
    const p = insertProject(db, 'ldash', 'LDA');
    insertDoc(db, p, 'A', '2026-01-01T00:00:00.000Z');
    apply(db, m009 as Mig);

    expect(() =>
      db
        .prepare('INSERT INTO kb_documents (id, project_id, title, key) VALUES (?, ?, ?, ?)')
        .run(nanoid(), p, 'Dup', 'LDA-KB-1')
    ).toThrow(/UNIQUE/);

    db.close();
  });

  it('leaves next_kb_number at 1 for a project with no docs', () => {
    const db = dbAt008();
    const p = insertProject(db, 'empty', 'EMP');
    apply(db, m009 as Mig);
    const row = db.prepare('SELECT next_kb_number FROM projects WHERE id = ?').get(p) as {
      next_kb_number: number;
    };
    expect(row.next_kb_number).toBe(1);
    db.close();
  });
});
