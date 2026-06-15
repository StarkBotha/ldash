import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from './helpers.js';
import { registerItemTools } from '../mcp/tools/items.js';
import { eventBus } from '../events/bus.js';
import type { Services, Column } from '../types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type App = ReturnType<typeof createTestApp>;
type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

describe('item MCP tools: delete + reparent', () => {
  let ctx: App;
  let projectId: string;
  let tools: Map<string, ToolHandler>;
  let cols: Column[];
  const col = (name: string) => cols.find((c) => c.name === name)!;

  beforeEach(() => {
    ctx = createTestApp();
    projectId = ctx.projectService.create({ name: 'Items MCP', description: '' }).id;
    cols = ctx.columnService.list().sort((a, b) => a.position - b.position);

    tools = new Map();
    const fakeServer = {
      tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;

    const services = {
      projects: ctx.projectService,
      items: ctx.itemService,
      columns: ctx.columnService,
      activity: ctx.activityService,
      comments: ctx.commentService,
      attachments: ctx.attachmentService,
    } as unknown as Services;

    registerItemTools(fakeServer, services, eventBus, ctx.db);
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('registers the delete and reparent tools', () => {
    expect(tools.has('ldash_delete_item')).toBe(true);
    expect(tools.has('ldash_reparent_item')).toBe(true);
  });

  // ---- ldash_delete_item ----

  it('deletes an item and reports success; unknown id errors', async () => {
    const del = tools.get('ldash_delete_item')!;
    const task = ctx.itemService.create({ project_id: projectId, type: 'task', title: 'Doomed', column_id: col('Backlog').id });

    const res = await del({ item_id: task.key });
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toContain(`Deleted ${task.key}`);
    expect(ctx.itemService.get(task.id)).toBeUndefined();

    const missing = await del({ item_id: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('deleting a story orphans its children (not cascade) and reports the count', async () => {
    const del = tools.get('ldash_delete_item')!;
    const story = ctx.itemService.create({ project_id: projectId, type: 'story', title: 'Parent', column_id: col('Backlog').id });
    const child = ctx.itemService.create({ project_id: projectId, parent_id: story.id, type: 'task', title: 'Child', column_id: col('Backlog').id });

    const res = await del({ item_id: story.id });
    expect(textOf(res)).toContain('1 child item was orphaned');
    // Child survives but is now top-level
    const reloaded = ctx.itemService.get(child.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.parent_id).toBeNull();
  });

  it('deleting a leaf re-derives the parent story status', async () => {
    const del = tools.get('ldash_delete_item')!;
    const story = ctx.itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: col('Backlog').id });
    ctx.itemService.create({ project_id: projectId, parent_id: story.id, type: 'task', title: 'done one', column_id: col('Done').id });
    const inProg = ctx.itemService.create({ project_id: projectId, parent_id: story.id, type: 'task', title: 'wip one', column_id: col('In Progress').id });

    // Removing the only In-Progress task leaves an all-Done set → story derives Done
    await del({ item_id: inProg.id });
    expect(ctx.itemService.get(story.id)!.column_id).toBe(col('Done').id);
  });

  // ---- ldash_reparent_item ----

  it('moves a task to a new parent and re-derives the new parent status', async () => {
    const reparent = tools.get('ldash_reparent_item')!;
    const storyA = ctx.itemService.create({ project_id: projectId, type: 'story', title: 'A', column_id: col('In Progress').id });
    const storyB = ctx.itemService.create({ project_id: projectId, type: 'story', title: 'B', column_id: col('Backlog').id });
    const task = ctx.itemService.create({ project_id: projectId, parent_id: storyA.id, type: 'task', title: 'T', column_id: col('In Progress').id });

    const res = await reparent({ item_id: task.key, new_parent: storyB.key });
    expect(res.isError).toBeUndefined();
    expect(ctx.itemService.get(task.id)!.parent_id).toBe(storyB.id);
    // B gained an In-Progress task → its derived status becomes In Progress
    expect(ctx.itemService.get(storyB.id)!.column_id).toBe(col('In Progress').id);
  });

  it('detaches to top-level when new_parent is null or empty', async () => {
    const reparent = tools.get('ldash_reparent_item')!;
    const story = ctx.itemService.create({ project_id: projectId, type: 'story', title: 'S', column_id: col('Backlog').id });
    const task = ctx.itemService.create({ project_id: projectId, parent_id: story.id, type: 'task', title: 'T', column_id: col('Backlog').id });

    await reparent({ item_id: task.id, new_parent: null });
    expect(ctx.itemService.get(task.id)!.parent_id).toBeNull();
  });

  it('rejects a non-story/epic parent', async () => {
    const reparent = tools.get('ldash_reparent_item')!;
    const t1 = ctx.itemService.create({ project_id: projectId, type: 'task', title: 'T1', column_id: col('Backlog').id });
    const t2 = ctx.itemService.create({ project_id: projectId, type: 'task', title: 'T2', column_id: col('Backlog').id });

    const res = await reparent({ item_id: t1.id, new_parent: t2.id });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('parent must be a story or epic');
    expect(ctx.itemService.get(t1.id)!.parent_id).toBeNull();
  });

  it('rejects a cycle (parenting an epic under its own descendant story)', async () => {
    const reparent = tools.get('ldash_reparent_item')!;
    const epic = ctx.itemService.create({ project_id: projectId, type: 'epic', title: 'E', column_id: col('Backlog').id });
    const story = ctx.itemService.create({ project_id: projectId, parent_id: epic.id, type: 'story', title: 'S', column_id: col('Backlog').id });

    const res = await reparent({ item_id: epic.id, new_parent: story.id });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('itself or one of its own descendants');
    expect(ctx.itemService.get(epic.id)!.parent_id).toBeNull();
  });

  it('rejects an unknown new parent', async () => {
    const reparent = tools.get('ldash_reparent_item')!;
    const task = ctx.itemService.create({ project_id: projectId, type: 'task', title: 'T', column_id: col('Backlog').id });
    const res = await reparent({ item_id: task.id, new_parent: 'nope' });
    expect(res.isError).toBe(true);
  });
});
