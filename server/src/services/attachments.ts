import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Attachment } from '../types.js';
import { EventTypes } from '../types.js';
import type { ActivityService } from './activity.js';
import type { EventBus } from '../events/bus.js';

interface AttachmentRow {
  id: string;
  item_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  data: Buffer;
  created_at: string;
}

type AttachmentMetaRow = Omit<AttachmentRow, 'data'>;

function rowToAttachment(row: AttachmentMetaRow): Attachment {
  return {
    id: row.id,
    item_id: row.item_id,
    filename: row.filename,
    mime: row.mime,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
  };
}

const META_COLUMNS = 'id, item_id, filename, mime, size_bytes, created_at';

export class AttachmentService {
  constructor(
    private db: Database.Database,
    private activityService: ActivityService,
    private bus: EventBus
  ) {}

  listForItem(itemId: string): Attachment[] {
    const rows = this.db
      .prepare(`SELECT ${META_COLUMNS} FROM attachments WHERE item_id = ? ORDER BY created_at ASC`)
      .all(itemId) as AttachmentMetaRow[];
    return rows.map(rowToAttachment);
  }

  get(id: string): (Attachment & { data: Buffer }) | undefined {
    const row = this.db
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .get(id) as AttachmentRow | undefined;
    return row ? { ...rowToAttachment(row), data: row.data } : undefined;
  }

  getMeta(id: string): Attachment | undefined {
    const row = this.db
      .prepare(`SELECT ${META_COLUMNS} FROM attachments WHERE id = ?`)
      .get(id) as AttachmentMetaRow | undefined;
    return row ? rowToAttachment(row) : undefined;
  }

  create(data: { item_id: string; filename: string; mime: string; data: Buffer }): Attachment {
    const item = this.db
      .prepare('SELECT project_id FROM items WHERE id = ?')
      .get(data.item_id) as { project_id: string } | undefined;
    if (!item) {
      throw new Error('Item not found');
    }

    const id = nanoid();
    this.db
      .prepare(
        'INSERT INTO attachments (id, item_id, filename, mime, size_bytes, data) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, data.item_id, data.filename, data.mime, data.data.length, data.data);
    const attachment = this.getMeta(id) as Attachment;

    this.activityService.append({
      project_id: item.project_id,
      item_id: data.item_id,
      event_type: EventTypes.ATTACHMENT_CREATED,
      payload: { attachment_id: id, filename: attachment.filename, mime: attachment.mime, size_bytes: attachment.size_bytes },
    });

    this.bus.emit({
      type: 'attachment.created',
      projectId: item.project_id,
      entityId: data.item_id,
      data: { attachment },
    });

    return attachment;
  }

  delete(id: string): void {
    const attachment = this.getMeta(id);
    if (!attachment) return;

    const item = this.db
      .prepare('SELECT project_id FROM items WHERE id = ?')
      .get(attachment.item_id) as { project_id: string } | undefined;
    const projectId = item?.project_id ?? null;

    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);

    this.activityService.append({
      project_id: projectId,
      item_id: attachment.item_id,
      event_type: EventTypes.ATTACHMENT_DELETED,
      payload: { attachment_id: id, filename: attachment.filename },
    });

    this.bus.emit({
      type: 'attachment.deleted',
      projectId: projectId ?? '',
      entityId: attachment.item_id,
      data: { attachment },
    });
  }
}
