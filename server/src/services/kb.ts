import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { ActorType, KbDocument, KbDocumentSummary } from '../types.js';
import { EventTypes } from '../types.js';
import type { ActivityService } from './activity.js';
import type { EventBus } from '../events/bus.js';

interface KbDocumentRow {
  id: string;
  project_id: string;
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
    title: row.title,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SUMMARY_COLUMNS = 'id, project_id, title, created_at, updated_at';

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
    this.db
      .prepare('INSERT INTO kb_documents (id, project_id, title, content) VALUES (?, ?, ?, ?)')
      .run(id, data.project_id, title, data.content ?? '');
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
