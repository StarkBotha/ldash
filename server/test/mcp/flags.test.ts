import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './setup.js';

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('flag and block MCP tools', () => {
  let ctx: TestContext;
  let itemId: string;
  let itemKey: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    const project = ctx.services.projects.create({ name: 'Test Project' });
    const columns = ctx.services.columns.list();
    const item = ctx.services.items.create({
      project_id: project.id,
      type: 'task',
      title: 'Test Item',
      column_id: columns[0].id,
    });
    itemId = item.id;
    itemKey = item.key;
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  // ldash_flag_item
  describe('ldash_flag_item', () => {
    it('sets flagged to true', async () => {
      const result = await ctx.client.callTool({
        name: 'ldash_flag_item',
        arguments: { item_id: itemId, flagged: true },
      });
      expect(result.isError).toBeFalsy();
      const item = JSON.parse(getText(result));
      expect(item.flagged).toBe(true);

      const stored = ctx.services.items.get(itemId);
      expect(stored!.flagged).toBe(true);
    });

    it('resolves the item by ticket key', async () => {
      const result = await ctx.client.callTool({
        name: 'ldash_flag_item',
        arguments: { item_id: itemKey, flagged: true },
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(getText(result)).id).toBe(itemId);
      expect(ctx.services.items.get(itemId)!.flagged).toBe(true);
    });

    it('clears flagged to false', async () => {
      // First flag it
      ctx.services.items.setFlag(itemId, true);

      const result = await ctx.client.callTool({
        name: 'ldash_flag_item',
        arguments: { item_id: itemId, flagged: false },
      });
      expect(result.isError).toBeFalsy();
      const item = JSON.parse(getText(result));
      expect(item.flagged).toBe(false);
    });

    it('writes item.flagged activity when flagging', async () => {
      await ctx.client.callTool({
        name: 'ldash_flag_item',
        arguments: { item_id: itemId, flagged: true },
      });

      const activity = ctx.services.activity.listByItem(itemId, { limit: 10 });
      const entry = activity.find(a => a.event_type === 'item.flagged');
      expect(entry).toBeDefined();
      expect(entry!.actor_type).toBe('claude');
    });

    it('writes item.unflagged activity when unflagging', async () => {
      ctx.services.items.setFlag(itemId, true);

      await ctx.client.callTool({
        name: 'ldash_flag_item',
        arguments: { item_id: itemId, flagged: false },
      });

      const activity = ctx.services.activity.listByItem(itemId, { limit: 10 });
      const entry = activity.find(a => a.event_type === 'item.unflagged');
      expect(entry).toBeDefined();
      expect(entry!.actor_type).toBe('claude');
    });
  });

  // ldash_block_item
  describe('ldash_block_item', () => {
    it('sets blocked to true with a reason', async () => {
      const result = await ctx.client.callTool({
        name: 'ldash_block_item',
        arguments: { item_id: itemId, blocked: true, reason: 'Waiting for API keys' },
      });
      expect(result.isError).toBeFalsy();
      const item = JSON.parse(getText(result));
      expect(item.blocked).toBe(true);
      expect(item.blocked_reason).toBe('Waiting for API keys');
    });

    it('resolves the item by ticket key', async () => {
      const result = await ctx.client.callTool({
        name: 'ldash_block_item',
        arguments: { item_id: itemKey, blocked: true, reason: 'Keyed block' },
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(getText(result)).id).toBe(itemId);
      expect(ctx.services.items.get(itemId)!.blocked).toBe(true);
    });

    it('returns isError when blocked=true and no reason given', async () => {
      const result = await ctx.client.callTool({
        name: 'ldash_block_item',
        arguments: { item_id: itemId, blocked: true },
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('reason is required');
    });

    it('clears blocked and blocked_reason when blocked=false', async () => {
      ctx.services.items.setBlock(itemId, true, 'Some reason');

      const result = await ctx.client.callTool({
        name: 'ldash_block_item',
        arguments: { item_id: itemId, blocked: false },
      });
      expect(result.isError).toBeFalsy();
      const item = JSON.parse(getText(result));
      expect(item.blocked).toBe(false);
      expect(item.blocked_reason).toBe('');
    });

    it('writes item.blocked activity with actor_type === "claude"', async () => {
      await ctx.client.callTool({
        name: 'ldash_block_item',
        arguments: { item_id: itemId, blocked: true, reason: 'Blocked reason' },
      });

      const activity = ctx.services.activity.listByItem(itemId, { limit: 10 });
      const entry = activity.find(a => a.event_type === 'item.blocked');
      expect(entry).toBeDefined();
      expect(entry!.actor_type).toBe('claude');
    });

    it('writes item.unblocked activity with actor_type === "claude"', async () => {
      ctx.services.items.setBlock(itemId, true, 'reason');

      await ctx.client.callTool({
        name: 'ldash_block_item',
        arguments: { item_id: itemId, blocked: false },
      });

      const activity = ctx.services.activity.listByItem(itemId, { limit: 10 });
      const entry = activity.find(a => a.event_type === 'item.unblocked');
      expect(entry).toBeDefined();
      expect(entry!.actor_type).toBe('claude');
    });
  });
});
