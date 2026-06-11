import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './setup.js';

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

// Minimal valid 1x1 PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('attachment MCP tools', () => {
  let ctx: TestContext;
  let projectId: string;
  let columns: Array<{ id: string; name: string }>;

  beforeEach(async () => {
    ctx = await createTestContext();
    const project = ctx.services.projects.create({ name: 'Test Project' });
    projectId = project.id;
    columns = ctx.services.columns.list();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  describe('ldash_get_item attachments', () => {
    it('includes attachment metadata in the attachments array', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task With Image', column_id: columns[0].id });
      const attachment = ctx.services.attachments.create({ item_id: item.id, filename: 'pixel.png', mime: 'image/png', data: PNG_BYTES });

      const result = await ctx.client.callTool({ name: 'ldash_get_item', arguments: { item_id: item.id } });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(getText(result));
      expect(data).toHaveProperty('attachments');
      expect(data.attachments).toHaveLength(1);
      expect(data.attachments[0]).toEqual({
        id: attachment.id,
        item_id: item.id,
        filename: 'pixel.png',
        mime: 'image/png',
        size_bytes: PNG_BYTES.length,
        created_at: attachment.created_at,
      });
      expect(data.attachments[0]).not.toHaveProperty('data');
    });

    it('returns an empty attachments array when the item has none', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Bare Task', column_id: columns[0].id });

      const result = await ctx.client.callTool({ name: 'ldash_get_item', arguments: { item_id: item.id } });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(getText(result));
      expect(data.attachments).toEqual([]);
    });
  });

  describe('ldash_get_attachment', () => {
    it('returns the image as an image content block with the seeded bytes', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task With Image', column_id: columns[0].id });
      const attachment = ctx.services.attachments.create({ item_id: item.id, filename: 'pixel.png', mime: 'image/png', data: PNG_BYTES });

      const result = await ctx.client.callTool({ name: 'ldash_get_attachment', arguments: { attachment_id: attachment.id } });
      expect(result.isError).toBeFalsy();

      const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      const textBlock = content.find((c) => c.type === 'text');
      expect(textBlock?.text).toContain('pixel.png');
      expect(textBlock?.text).toContain(String(PNG_BYTES.length));

      const imageBlock = content.find((c) => c.type === 'image');
      expect(imageBlock).toBeDefined();
      expect(imageBlock!.mimeType).toBe('image/png');
      expect(Buffer.from(imageBlock!.data!, 'base64').equals(PNG_BYTES)).toBe(true);
    });

    it('returns isError for an unknown attachment id', async () => {
      const result = await ctx.client.callTool({ name: 'ldash_get_attachment', arguments: { attachment_id: 'no-such-attachment' } });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });
});
