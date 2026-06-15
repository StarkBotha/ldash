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
import * as m010 from '../db/migrations/010_kb_conversation_type.js';

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

// A DB migrated up to 009 — conversations.type CHECK is ('item', 'planning').
function dbAt009(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  for (const mig of [m001, m002, m003, m004, m005, m006, m007, m008, m009] as Mig[]) {
    apply(db, mig);
  }
  return db;
}

function insertProject(db: Database.Database, name: string, prefix: string): string {
  const id = nanoid();
  db.prepare('INSERT INTO projects (id, name, prefix) VALUES (?, ?, ?)').run(id, name, prefix);
  return id;
}

describe('migration 010_kb_conversation_type', () => {
  it("rejects type 'kb' before the migration and accepts it after", () => {
    const db = dbAt009();
    const p = insertProject(db, 'ldash', 'LDA');

    // Before: the old CHECK constraint forbids 'kb'.
    expect(() =>
      db
        .prepare('INSERT INTO conversations (id, project_id, item_id, type) VALUES (?, ?, NULL, ?)')
        .run(nanoid(), p, 'kb')
    ).toThrow(/CHECK/);

    apply(db, m010 as Mig);

    // After: 'kb' is admitted.
    const kbId = nanoid();
    expect(() =>
      db
        .prepare('INSERT INTO conversations (id, project_id, item_id, type) VALUES (?, ?, NULL, ?)')
        .run(kbId, p, 'kb')
    ).not.toThrow();
    const row = db.prepare('SELECT type FROM conversations WHERE id = ?').get(kbId) as { type: string };
    expect(row.type).toBe('kb');

    db.close();
  });

  it('preserves existing conversations and their messages across the rebuild', () => {
    const db = dbAt009();
    const p = insertProject(db, 'ldash', 'LDA');
    const convId = nanoid();
    db.prepare('INSERT INTO conversations (id, project_id, item_id, type) VALUES (?, ?, NULL, ?)').run(
      convId,
      p,
      'planning'
    );
    const msgId = nanoid();
    db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
      msgId,
      convId,
      'user',
      'hello'
    );

    apply(db, m010 as Mig);

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as
      | { id: string; type: string }
      | undefined;
    expect(conv?.type).toBe('planning');
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId) as
      | { content: string }
      | undefined;
    expect(msg?.content).toBe('hello');

    db.close();
  });

  it('still rejects an unknown conversation type after the migration', () => {
    const db = dbAt009();
    const p = insertProject(db, 'ldash', 'LDA');
    apply(db, m010 as Mig);
    expect(() =>
      db
        .prepare('INSERT INTO conversations (id, project_id, item_id, type) VALUES (?, ?, NULL, ?)')
        .run(nanoid(), p, 'bogus')
    ).toThrow(/CHECK/);
    db.close();
  });
});
