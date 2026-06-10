import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './setup.js';

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('MCP guard: ldash_update_item_status on non-tasks', () => {
  let ctx: TestContext;
  let projectId: string;
  let columns: Array<{ id: string; name: string; position: number }>;

  beforeEach(async () => {
    ctx = await createTestContext();
    const project = ctx.services.projects.create({ name: 'Test Project' });
    projectId = project.id;
    columns = ctx.services.columns.list().sort((a, b) => a.position - b.position);
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('returns isError when trying to move a story', async () => {
    const story = ctx.services.items.create({
      project_id: projectId,
      type: 'story',
      title: 'Story',
      column_id: columns[0].id,
    });
    const doneCol = columns[columns.length - 1];

    const result = await ctx.client.callTool({
      name: 'ldash_update_item_status',
      arguments: { item_id: story.id, column_id: doneCol.name },
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('derived from its tasks');
  });

  it('returns isError when trying to move an epic', async () => {
    const epic = ctx.services.items.create({
      project_id: projectId,
      type: 'epic',
      title: 'Epic',
      column_id: columns[0].id,
    });
    const doneCol = columns[columns.length - 1];

    const result = await ctx.client.callTool({
      name: 'ldash_update_item_status',
      arguments: { item_id: epic.id, column_id: doneCol.name },
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('derived from its tasks');
  });

  it('succeeds moving a task and rolls up parent story', async () => {
    const story = ctx.services.items.create({
      project_id: projectId,
      type: 'story',
      title: 'Story',
      column_id: columns[0].id,
    });
    const task = ctx.services.items.create({
      project_id: projectId,
      type: 'task',
      title: 'Task',
      column_id: columns[0].id,
      parent_id: story.id,
    });
    const doneCol = columns[columns.length - 1];

    const result = await ctx.client.callTool({
      name: 'ldash_update_item_status',
      arguments: { item_id: task.id, column_id: doneCol.name },
    });
    expect(result.isError).toBeFalsy();

    // Story should have been rolled up to Done by rollup
    const storyAfter = ctx.services.items.get(story.id)!;
    expect(storyAfter.column_id).toBe(doneCol.id);
  });
});
