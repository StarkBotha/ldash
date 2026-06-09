import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './setup.js';

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('item MCP tools', () => {
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

  // ldash_list_items
  describe('ldash_list_items', () => {
    it('returns all items for a project', async () => {
      ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task 1', column_id: columns[0].id });
      ctx.services.items.create({ project_id: projectId, type: 'story', title: 'Story 1', column_id: columns[1].id });

      const result = await ctx.client.callTool({ name: 'ldash_list_items', arguments: { project_id: projectId } });
      expect(result.isError).toBeFalsy();
      const items = JSON.parse(getText(result));
      expect(items).toHaveLength(2);
    });

    it('filters by type', async () => {
      ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task 1', column_id: columns[0].id });
      ctx.services.items.create({ project_id: projectId, type: 'story', title: 'Story 1', column_id: columns[0].id });

      const result = await ctx.client.callTool({ name: 'ldash_list_items', arguments: { project_id: projectId, type: 'task' } });
      expect(result.isError).toBeFalsy();
      const items = JSON.parse(getText(result));
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('task');
    });

    it('filters by column_id as a name', async () => {
      ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task 1', column_id: columns[0].id });
      ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task 2', column_id: columns[1].id });

      const result = await ctx.client.callTool({
        name: 'ldash_list_items',
        arguments: { project_id: projectId, column_id: columns[0].name },
      });
      expect(result.isError).toBeFalsy();
      const items = JSON.parse(getText(result));
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Task 1');
    });

    it('filters by parent_id: "null" returns top-level items', async () => {
      const parent = ctx.services.items.create({ project_id: projectId, type: 'story', title: 'Parent', column_id: columns[0].id });
      ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Child', column_id: columns[0].id, parent_id: parent.id });

      const result = await ctx.client.callTool({
        name: 'ldash_list_items',
        arguments: { project_id: projectId, parent_id: 'null' },
      });
      expect(result.isError).toBeFalsy();
      const items = JSON.parse(getText(result));
      expect(items.every((i: { parent_id: null }) => i.parent_id === null)).toBe(true);
    });

    it('returns isError when project not found', async () => {
      const result = await ctx.client.callTool({ name: 'ldash_list_items', arguments: { project_id: 'nonexistent' } });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ldash_get_item
  describe('ldash_get_item', () => {
    it('returns item, empty comments, and activity array', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'My Task', column_id: columns[0].id });

      const result = await ctx.client.callTool({ name: 'ldash_get_item', arguments: { item_id: item.id } });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(getText(result));
      expect(data).toHaveProperty('item');
      expect(data).toHaveProperty('comments');
      expect(data).toHaveProperty('recent_activity');
      expect(data.item.id).toBe(item.id);
      expect(Array.isArray(data.comments)).toBe(true);
      expect(Array.isArray(data.recent_activity)).toBe(true);
    });

    it('returns isError for nonexistent item', async () => {
      const result = await ctx.client.callTool({ name: 'ldash_get_item', arguments: { item_id: 'no-such-item' } });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ldash_create_item
  describe('ldash_create_item', () => {
    it('creates an item that appears in ldash_list_items', async () => {
      await ctx.client.callTool({
        name: 'ldash_create_item',
        arguments: { project_id: projectId, type: 'task', title: 'New Task' },
      });

      const listResult = await ctx.client.callTool({ name: 'ldash_list_items', arguments: { project_id: projectId } });
      const items = JSON.parse(getText(listResult));
      expect(items.some((i: { title: string }) => i.title === 'New Task')).toBe(true);
    });

    it('places item in Backlog (first column) when column_id is omitted', async () => {
      const result = await ctx.client.callTool({
        name: 'ldash_create_item',
        arguments: { project_id: projectId, type: 'task', title: 'Backlog Task' },
      });
      expect(result.isError).toBeFalsy();
      const item = JSON.parse(getText(result));
      expect(item.column_id).toBe(columns[0].id);
    });

    it('places item in named column when column name is given', async () => {
      const inProgressCol = columns.find(c => c.name === 'In Progress')!;
      const result = await ctx.client.callTool({
        name: 'ldash_create_item',
        arguments: { project_id: projectId, type: 'task', title: 'WIP Task', column_id: 'In Progress' },
      });
      expect(result.isError).toBeFalsy();
      const item = JSON.parse(getText(result));
      expect(item.column_id).toBe(inProgressCol.id);
    });

    it('writes item.created activity with actor_type === "claude"', async () => {
      const result = await ctx.client.callTool({
        name: 'ldash_create_item',
        arguments: { project_id: projectId, type: 'task', title: 'Activity Task' },
      });
      const item = JSON.parse(getText(result));
      const activity = ctx.services.activity.listByItem(item.id, { limit: 5 });
      const entry = activity.find(a => a.event_type === 'item.created');
      expect(entry).toBeDefined();
      expect(entry!.actor_type).toBe('claude');
      expect(entry!.actor_id).toBe('claude-code');
    });

    it('returns isError for nonexistent project', async () => {
      const result = await ctx.client.callTool({
        name: 'ldash_create_item',
        arguments: { project_id: 'no-such', type: 'task', title: 'Fail' },
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ldash_update_item_fields
  describe('ldash_update_item_fields', () => {
    it('changes the title and ldash_get_item reflects it', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Old Title', column_id: columns[0].id });

      await ctx.client.callTool({
        name: 'ldash_update_item_fields',
        arguments: { item_id: item.id, title: 'New Title' },
      });

      const getResult = await ctx.client.callTool({ name: 'ldash_get_item', arguments: { item_id: item.id } });
      const data = JSON.parse(getText(getResult));
      expect(data.item.title).toBe('New Title');
    });

    it('returns isError when no fields are provided', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task', column_id: columns[0].id });

      const result = await ctx.client.callTool({
        name: 'ldash_update_item_fields',
        arguments: { item_id: item.id },
      });
      expect(result.isError).toBe(true);
    });

    it('writes item.updated activity with actor_type === "claude"', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task', column_id: columns[0].id });

      await ctx.client.callTool({
        name: 'ldash_update_item_fields',
        arguments: { item_id: item.id, title: 'Updated Title' },
      });

      const activity = ctx.services.activity.listByItem(item.id, { limit: 10 });
      const entry = activity.find(a => a.event_type === 'item.updated');
      expect(entry).toBeDefined();
      expect(entry!.actor_type).toBe('claude');
    });
  });

  // ldash_update_item_status
  describe('ldash_update_item_status', () => {
    it('moves item by column name', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task', column_id: columns[0].id });
      const doneCol = columns.find(c => c.name === 'Done')!;

      const result = await ctx.client.callTool({
        name: 'ldash_update_item_status',
        arguments: { item_id: item.id, column_id: 'Done' },
      });
      expect(result.isError).toBeFalsy();
      const movedItem = JSON.parse(getText(result));
      expect(movedItem.column_id).toBe(doneCol.id);
    });

    it('moves item by column id', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task', column_id: columns[0].id });
      const reviewCol = columns.find(c => c.name === 'Review')!;

      const result = await ctx.client.callTool({
        name: 'ldash_update_item_status',
        arguments: { item_id: item.id, column_id: reviewCol.id },
      });
      expect(result.isError).toBeFalsy();
      const movedItem = JSON.parse(getText(result));
      expect(movedItem.column_id).toBe(reviewCol.id);
    });

    it('returns isError with available columns for unknown column', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task', column_id: columns[0].id });

      const result = await ctx.client.callTool({
        name: 'ldash_update_item_status',
        arguments: { item_id: item.id, column_id: 'NoSuchColumn' },
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
      expect(getText(result)).toContain('Available columns');
    });

    it('writes item.moved activity with actor_type === "claude"', async () => {
      const item = ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Task', column_id: columns[0].id });

      await ctx.client.callTool({
        name: 'ldash_update_item_status',
        arguments: { item_id: item.id, column_id: 'Done' },
      });

      const activity = ctx.services.activity.listByItem(item.id, { limit: 10 });
      const entry = activity.find(a => a.event_type === 'item.moved');
      expect(entry).toBeDefined();
      expect(entry!.actor_type).toBe('claude');
    });
  });
});
