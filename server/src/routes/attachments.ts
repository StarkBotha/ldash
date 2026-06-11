import { Hono } from 'hono';
import type { AttachmentService } from '../services/attachments.js';
import type { ItemService } from '../services/items.js';

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB decoded

// Raster types only — SVG is executable (scripts/event handlers) and serving it
// same-origin from /api/attachments would be stored XSS.
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function makeError(msg: string, status: number): Error {
  const err = new Error(msg) as Error & { status: number };
  err.status = status;
  return err;
}

function extensionForMime(mime: string): string {
  const subtype = mime.slice('image/'.length).split('+')[0].toLowerCase();
  if (subtype === 'jpeg') return 'jpg';
  return /^[a-z0-9.-]+$/.test(subtype) ? subtype : 'png';
}

export function itemAttachmentsRouter(
  attachmentService: AttachmentService,
  itemService: ItemService
): Hono {
  const app = new Hono();

  // POST /api/items/:itemId/attachments
  app.post('/', async (c) => {
    const itemId = c.req.param('itemId') as string;
    const body = await c.req.json().catch(() => ({}));
    const { filename, mime, data_base64 } = body as {
      filename?: unknown;
      mime?: unknown;
      data_base64?: unknown;
    };

    if (!mime || typeof mime !== 'string' || !ALLOWED_MIMES.has(mime)) {
      throw makeError('mime must be one of: image/png, image/jpeg, image/gif, image/webp', 400);
    }

    if (!data_base64 || typeof data_base64 !== 'string') {
      throw makeError('data_base64 is required', 400);
    }

    const item = itemService.get(itemId);
    if (!item) {
      throw makeError('Item not found', 404);
    }

    const data = Buffer.from(data_base64, 'base64');
    if (data.length === 0) {
      throw makeError('data_base64 decoded to empty data', 400);
    }
    if (data.length > MAX_SIZE_BYTES) {
      throw makeError('Attachment exceeds 10MB limit', 413);
    }

    const resolvedFilename =
      typeof filename === 'string' && filename.trim() !== ''
        ? filename.trim()
        : `pasted-${Date.now()}.${extensionForMime(mime)}`;

    const attachment = attachmentService.create({
      item_id: itemId,
      filename: resolvedFilename,
      mime,
      data,
    });

    return c.json(attachment, 201);
  });

  // GET /api/items/:itemId/attachments
  app.get('/', (c) => {
    const itemId = c.req.param('itemId') as string;
    const item = itemService.get(itemId);
    if (!item) {
      throw makeError('Item not found', 404);
    }
    return c.json({ attachments: attachmentService.listForItem(itemId) });
  });

  return app;
}

export function attachmentsRouter(attachmentService: AttachmentService): Hono {
  const app = new Hono();

  // GET /api/attachments/:id — raw image bytes
  app.get('/:id', (c) => {
    const { id } = c.req.param();
    const attachment = attachmentService.get(id);
    if (!attachment) {
      throw makeError('Attachment not found', 404);
    }
    return new Response(new Uint8Array(attachment.data), {
      status: 200,
      headers: {
        'Content-Type': attachment.mime,
        'Content-Length': String(attachment.size_bytes),
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Defense in depth: never sniff to an executable type, no scripts even
        // if something executable slips through the upload allowlist.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });

  // DELETE /api/attachments/:id
  app.delete('/:id', (c) => {
    const { id } = c.req.param();
    const existing = attachmentService.getMeta(id);
    if (!existing) {
      throw makeError('Attachment not found', 404);
    }
    attachmentService.delete(id);
    return c.json({ ok: true }, 200);
  });

  return app;
}
