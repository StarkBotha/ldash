import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { ActorType, KbDocument, KbDocumentSummary, KbGlobalSearchResult, KbSearchResult } from '../types.js';
import { EventTypes } from '../types.js';
import type { ActivityService } from './activity.js';
import type { EventBus } from '../events/bus.js';

interface KbDocumentRow {
  id: string;
  project_id: string;
  number: number;
  key: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

type KbDocumentSummaryRow = Omit<KbDocumentRow, 'content'>;

function rowToDoc(row: KbDocumentRow): KbDocument {
  return {
    id: row.id,
    project_id: row.project_id,
    number: row.number,
    key: row.key,
    title: row.title,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SUMMARY_COLUMNS = 'id, project_id, number, key, title, created_at, updated_at';

const SNIPPET_LENGTH = 160;

/** ~160 chars of content centered on the first case-insensitive occurrence of query, or '' when content does not match. */
function makeSnippet(content: string, query: string): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return '';

  const half = Math.max(0, Math.floor((SNIPPET_LENGTH - query.length) / 2));
  let start = Math.max(0, index - half);
  const end = Math.min(content.length, start + SNIPPET_LENGTH);
  if (end - start < SNIPPET_LENGTH) {
    start = Math.max(0, end - SNIPPET_LENGTH);
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end) + suffix;
}

interface Actor {
  actor_type?: ActorType;
  actor_id?: string;
}

export class KbService {
  constructor(
    private db: Database.Database,
    private activityService: ActivityService,
    private bus: EventBus
  ) {}

  create(data: { project_id: string; title: string; content?: string }, actor?: Actor): KbDocument {
    const title = data.title.trim();
    if (title === '') {
      throw new Error('title must be a non-empty string');
    }

    const id = nanoid();
    const insert = this.db.transaction(() => {
      const proj = this.db
        .prepare('SELECT prefix, next_kb_number FROM projects WHERE id = ?')
        .get(data.project_id) as { prefix: string; next_kb_number: number } | undefined;
      if (!proj) {
        throw new Error('Project not found: ' + data.project_id);
      }

      this.db
        .prepare(
          'INSERT INTO kb_documents (id, project_id, number, key, title, content) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(id, data.project_id, proj.next_kb_number, `${proj.prefix}-KB-${proj.next_kb_number}`, title, data.content ?? '');

      this.db
        .prepare('UPDATE projects SET next_kb_number = next_kb_number + 1 WHERE id = ?')
        .run(data.project_id);
    });
    insert();
    const doc = this.get(id) as KbDocument;

    this.activityService.append({
      project_id: data.project_id,
      actor_type: actor?.actor_type,
      actor_id: actor?.actor_id,
      event_type: EventTypes.KB_DOC_CREATED,
      payload: { doc_id: doc.id, title: doc.title },
    });

    this.bus.emit({
      type: 'kb_doc.created',
      projectId: data.project_id,
      entityId: doc.id,
      data: { doc },
    });

    return doc;
  }

  get(id: string): KbDocument | undefined {
    const row = this.db
      .prepare('SELECT * FROM kb_documents WHERE id = ?')
      .get(id) as KbDocumentRow | undefined;
    return row ? rowToDoc(row) : undefined;
  }

  getByTitle(projectId: string, title: string): KbDocument | undefined {
    const row = this.db
      .prepare('SELECT * FROM kb_documents WHERE project_id = ? AND lower(title) = lower(?)')
      .get(projectId, title) as KbDocumentRow | undefined;
    return row ? rowToDoc(row) : undefined;
  }

  getByKey(key: string): KbDocument | undefined {
    const row = this.db
      .prepare('SELECT * FROM kb_documents WHERE key = ? COLLATE NOCASE')
      .get(key) as KbDocumentRow | undefined;
    return row ? rowToDoc(row) : undefined;
  }

  /** Read-only search over titles and content — writes no activity and emits no events. */
  search(projectId: string, query: string): KbSearchResult[] {
    const like = '%' + query.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const rows = this.db
      .prepare(
        "SELECT * FROM kb_documents WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY (title LIKE ? ESCAPE '\\') DESC, title ASC"
      )
      .all(projectId, like, like, like) as KbDocumentRow[];
    return rows.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      key: row.key,
      title: row.title,
      updated_at: row.updated_at,
      snippet: makeSnippet(row.content, query),
    }));
  }

  /** Read-only search over titles and content across ALL projects — writes no activity and emits no events. */
  searchAll(query: string): KbGlobalSearchResult[] {
    const like = '%' + query.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const rows = this.db
      .prepare(
        "SELECT d.*, p.name AS project_name FROM kb_documents d JOIN projects p ON p.id = d.project_id WHERE d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\' ORDER BY (d.title LIKE ? ESCAPE '\\') DESC, d.title ASC"
      )
      .all(like, like, like) as (KbDocumentRow & { project_name: string })[];
    return rows.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      project_name: row.project_name,
      key: row.key,
      title: row.title,
      updated_at: row.updated_at,
      snippet: makeSnippet(row.content, query),
    }));
  }

  list(projectId: string): KbDocumentSummary[] {
    const rows = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM kb_documents WHERE project_id = ? ORDER BY title ASC`)
      .all(projectId) as KbDocumentSummaryRow[];
    return rows;
  }

  update(id: string, data: { title?: string; content?: string }, actor?: Actor): KbDocument {
    const existing = this.get(id);
    if (!existing) {
      throw new Error('Document not found');
    }

    const fields: string[] = [];
    const params: unknown[] = [];

    if (data.title !== undefined) {
      const title = data.title.trim();
      if (title === '') {
        throw new Error('title must be a non-empty string');
      }
      fields.push('title = ?');
      params.push(title);
    }
    if (data.content !== undefined) {
      fields.push('content = ?');
      params.push(data.content);
    }

    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    params.push(id);
    this.db.prepare(`UPDATE kb_documents SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    const doc = this.get(id) as KbDocument;

    this.activityService.append({
      project_id: doc.project_id,
      actor_type: actor?.actor_type,
      actor_id: actor?.actor_id,
      event_type: EventTypes.KB_DOC_UPDATED,
      payload: { doc_id: doc.id, title: doc.title },
    });

    this.bus.emit({
      type: 'kb_doc.updated',
      projectId: doc.project_id,
      entityId: doc.id,
      data: { doc },
    });

    return doc;
  }

  delete(id: string, actor?: Actor): boolean {
    const existing = this.get(id);
    if (!existing) return false;

    this.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id);

    this.activityService.append({
      project_id: existing.project_id,
      actor_type: actor?.actor_type,
      actor_id: actor?.actor_id,
      event_type: EventTypes.KB_DOC_DELETED,
      payload: { doc_id: existing.id, title: existing.title },
    });

    this.bus.emit({
      type: 'kb_doc.deleted',
      projectId: existing.project_id,
      entityId: existing.id,
      data: { id: existing.id },
    });

    return true;
  }
}
