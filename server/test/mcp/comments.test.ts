import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './setup.js';

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('ldash_add_comment', () => {
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

  it('creates a comment with author === "claude-code"', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_add_comment',
      arguments: { item_id: itemId, body: 'This is a comment' },
    });
    expect(result.isError).toBeFalsy();
    const comment = JSON.parse(getText(result));
    expect(comment.author).toBe('claude-code');
    expect(comment.body).toBe('This is a comment');
    expect(comment.item_id).toBe(itemId);
  });

  it('comment appears in GET /api/items/:itemId/comments', async () => {
    await ctx.client.callTool({
      name: 'ldash_add_comment',
      arguments: { item_id: itemId, body: 'HTTP visible comment' },
    });

    const comments = ctx.services.comments.listByItem(itemId);
    expect(comments.some(c => c.body === 'HTTP visible comment')).toBe(true);
  });

  it('resolves the item by ticket key', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_add_comment',
      arguments: { item_id: itemKey, body: 'Keyed comment' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(getText(result)).item_id).toBe(itemId);
    expect(ctx.services.comments.listByItem(itemId).some(c => c.body === 'Keyed comment')).toBe(true);
  });

  it('returns isError for empty body (Zod validation)', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_add_comment',
      arguments: { item_id: itemId, body: '' },
    });
    expect(result.isError).toBe(true);
  });

  it('returns isError for nonexistent item_id', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_add_comment',
      arguments: { item_id: 'no-such-item', body: 'Hello' },
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('not found');
  });

  it('writes comment.created activity with actor_type === "claude"', async () => {
    await ctx.client.callTool({
      name: 'ldash_add_comment',
      arguments: { item_id: itemId, body: 'Activity comment' },
    });

    const activity = ctx.services.activity.listByItem(itemId, { limit: 10 });
    const entry = activity.find(a => a.event_type === 'comment.created');
    expect(entry).toBeDefined();
    expect(entry!.actor_type).toBe('claude');
    expect(entry!.actor_id).toBe('claude-code');
  });
});

describe('ldash_edit_comment', () => {
  let ctx: TestContext;
  let itemId: string;
  let commentId: string;

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
    const comment = ctx.services.comments.create({ item_id: itemId, body: 'original text', author: 'claude-code' });
    commentId = comment.id;
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('replaces the comment body and preserves id, item, and author', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_edit_comment',
      arguments: { comment_id: commentId, body: 'corrected text' },
    });
    expect(result.isError).toBeFalsy();
    const comment = JSON.parse(getText(result));
    expect(comment.id).toBe(commentId);
    expect(comment.item_id).toBe(itemId);
    expect(comment.body).toBe('corrected text');
    expect(comment.author).toBe('claude-code');

    // Persisted
    expect(ctx.services.comments.get(commentId)!.body).toBe('corrected text');
  });

  it('returns isError for empty body (Zod validation)', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_edit_comment',
      arguments: { comment_id: commentId, body: '' },
    });
    expect(result.isError).toBe(true);
  });

  it('returns isError for a nonexistent comment_id', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_edit_comment',
      arguments: { comment_id: 'no-such-comment', body: 'Hello' },
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('not found');
  });

  it('writes comment.updated activity with actor_type === "claude"', async () => {
    await ctx.client.callTool({
      name: 'ldash_edit_comment',
      arguments: { comment_id: commentId, body: 'edited for activity' },
    });

    const activity = ctx.services.activity.listByItem(itemId, { limit: 10 });
    const entry = activity.find(a => a.event_type === 'comment.updated');
    expect(entry).toBeDefined();
    expect(entry!.actor_type).toBe('claude');
    expect(entry!.actor_id).toBe('claude-code');
    expect((entry!.payload as { comment_id?: string }).comment_id).toBe(commentId);
  });
});
