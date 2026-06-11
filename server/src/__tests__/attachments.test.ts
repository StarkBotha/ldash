import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, req } from './helpers.js';
import { eventBus } from '../events/bus.js';
import type { BoardEvent } from '../events/types.js';
import type { Hono } from 'hono';
import type { Column, Item, Attachment, ActivityEntry } from '../types.js';

let app: Hono;
let projectId: string;
let itemId: string;

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);

function upload(overrides: Record<string, unknown> = {}, targetItemId = itemId) {
  return req(app, 'POST', `/api/items/${targetItemId}/attachments`, {
    filename: 'screenshot.png',
    mime: 'image/png',
    data_base64: PNG_BYTES.toString('base64'),
    ...overrides,
  });
}

beforeEach(async () => {
  ({ app } = createTestApp());
  const { body: cols } = await req(app, 'GET', '/api/columns');
  const colId = (cols as Column[])[0].id;
  const { body: project } = await req(app, 'POST', '/api/projects', { name: 'AttachProj' });
  projectId = (project as { id: string }).id;
  const { body: item } = await req(app, 'POST', '/api/items', {
    project_id: projectId, type: 'task', title: 'AttachItem', column_id: colId,
  });
  itemId = (item as Item).id;
});

describe('Attachments', () => {
  it('upload, list, and get bytes roundtrip', async () => {
    const { status, body } = await upload();
    expect(status).toBe(201);
    const attachment = body as Attachment;
    expect(attachment.id).toBeTruthy();
    expect(attachment.item_id).toBe(itemId);
    expect(attachment.filename).toBe('screenshot.png');
    expect(attachment.mime).toBe('image/png');
    expect(attachment.size_bytes).toBe(PNG_BYTES.length);
    expect(attachment.created_at).toBeTruthy();
    expect((attachment as Record<string, unknown>).data).toBeUndefined();

    const { status: listStatus, body: listBody } = await req(app, 'GET', `/api/items/${itemId}/attachments`);
    expect(listStatus).toBe(200);
    const { attachments } = listBody as { attachments: Attachment[] };
    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe(attachment.id);

    const res = await app.fetch(new Request(`http://localhost/api/attachments/${attachment.id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(PNG_BYTES)).toBe(true);
  });

  it('defaults filename when omitted', async () => {
    const { status, body } = await upload({ filename: undefined });
    expect(status).toBe(201);
    expect((body as Attachment).filename).toMatch(/^pasted-\d+\.png$/);
  });

  it('rejects non-image mime with 400', async () => {
    const { status } = await upload({ mime: 'application/pdf' });
    expect(status).toBe(400);
  });

  it('rejects image/svg+xml with 400 (scriptable, stored-XSS risk)', async () => {
    const { status } = await upload({ mime: 'image/svg+xml' });
    expect(status).toBe(400);
  });

  it('rejects payloads over 10MB with 413', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    const { status } = await upload({ data_base64: big.toString('base64') });
    expect(status).toBe(413);
  });

  it('returns 404 for unknown item on upload and list', async () => {
    const { status } = await upload({}, 'no-such-item');
    expect(status).toBe(404);
    const { status: listStatus } = await req(app, 'GET', '/api/items/no-such-item/attachments');
    expect(listStatus).toBe(404);
  });

  it('returns 404 for unknown attachment on get and delete', async () => {
    const { status: getStatus } = await req(app, 'GET', '/api/attachments/no-such-attachment');
    expect(getStatus).toBe(404);
    const { status: delStatus } = await req(app, 'DELETE', '/api/attachments/no-such-attachment');
    expect(delStatus).toBe(404);
  });

  it('DELETE returns 200 and attachment 404s afterwards', async () => {
    const { body } = await upload();
    const attachment = body as Attachment;

    const { status: delStatus } = await req(app, 'DELETE', `/api/attachments/${attachment.id}`);
    expect(delStatus).toBe(200);

    const { status: getStatus } = await req(app, 'GET', `/api/attachments/${attachment.id}`);
    expect(getStatus).toBe(404);

    const { body: listBody } = await req(app, 'GET', `/api/items/${itemId}/attachments`);
    expect((listBody as { attachments: Attachment[] }).attachments).toHaveLength(0);
  });

  it('deleting the item removes its attachments', async () => {
    const { body } = await upload();
    const attachment = body as Attachment;

    const { status: delStatus } = await req(app, 'DELETE', `/api/items/${itemId}`);
    expect(delStatus).toBe(204);

    const { status: getStatus } = await req(app, 'GET', `/api/attachments/${attachment.id}`);
    expect(getStatus).toBe(404);
  });

  it('create and delete write activity rows', async () => {
    const { body } = await upload();
    const attachment = body as Attachment;
    await req(app, 'DELETE', `/api/attachments/${attachment.id}`);

    const { body: actBody } = await req(app, 'GET', `/api/items/${itemId}/activity`);
    const entries = (actBody as { entries: ActivityEntry[] }).entries;
    const created = entries.find((e) => e.event_type === 'attachment.created');
    const deleted = entries.find((e) => e.event_type === 'attachment.deleted');
    expect(created).toBeDefined();
    expect(created?.payload.attachment_id).toBe(attachment.id);
    expect(deleted).toBeDefined();
    expect(deleted?.payload.attachment_id).toBe(attachment.id);
  });

  it('create and delete emit bus events with item entityId and metadata only', async () => {
    const events: BoardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => {
      if (e.type === 'attachment.created' || e.type === 'attachment.deleted') events.push(e);
    });
    try {
      const { body } = await upload();
      const attachment = body as Attachment;
      await req(app, 'DELETE', `/api/attachments/${attachment.id}`);

      expect(events).toHaveLength(2);
      const [created, deleted] = events;
      expect(created.type).toBe('attachment.created');
      expect(created.projectId).toBe(projectId);
      expect(created.entityId).toBe(itemId);
      expect((created.data.attachment as Attachment).id).toBe(attachment.id);
      expect((created.data.attachment as Record<string, unknown>).data).toBeUndefined();
      expect(deleted.type).toBe('attachment.deleted');
      expect(deleted.projectId).toBe(projectId);
      expect(deleted.entityId).toBe(itemId);
      expect((deleted.data.attachment as Attachment).id).toBe(attachment.id);
    } finally {
      unsubscribe();
    }
  });
});
