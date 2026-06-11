import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './setup.js';

describe('ldash_search_items', () => {
  let ctx: TestContext;
  let projectId: string;
  let colId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    const project = ctx.services.projects.create({ name: 'dungeon sweeper' });
    projectId = project.id;
    colId = ctx.services.columns.list()[0].id;
    ctx.services.items.create({ project_id: projectId, type: 'epic', title: 'Combat system', column_id: colId });
    ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Add monster spawning', description: 'goblins and skeletons', column_id: colId });
    ctx.services.items.create({ project_id: projectId, type: 'task', title: 'Tile rendering', column_id: colId });
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  async function search(args: Record<string, unknown>) {
    const result = await ctx.client.callTool({ name: 'ldash_search_items', arguments: args });
    return { result, body: (result.content[0] as { type: 'text'; text: string }).text };
  }

  it('returns only ticket keys for title matches, case-insensitively', async () => {
    const { result, body } = await search({ project_id: projectId, query: 'MONSTER' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(body)).toEqual(['DS-2']);
  });

  it('matches description text', async () => {
    const { body } = await search({ project_id: projectId, query: 'goblin' });
    expect(JSON.parse(body)).toEqual(['DS-2']);
  });

  it('matches ticket keys', async () => {
    const { body } = await search({ project_id: projectId, query: 'DS-3' });
    expect(JSON.parse(body)).toEqual(['DS-3']);
  });

  it('returns an empty array when nothing matches', async () => {
    const { body } = await search({ project_id: projectId, query: 'zzz-nothing' });
    expect(JSON.parse(body)).toEqual([]);
  });

  it('does not treat LIKE wildcards in the query as wildcards', async () => {
    const { body } = await search({ project_id: projectId, query: '%' });
    expect(JSON.parse(body)).toEqual([]);
  });

  it('errors for an unknown project', async () => {
    const { result } = await search({ project_id: 'nope', query: 'x' });
    expect(result.isError).toBe(true);
  });
});

describe('ldash_get_item by ticket key', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('resolves a ticket key (case-insensitively) to the same item as its id', async () => {
    const project = ctx.services.projects.create({ name: 'keyed' });
    const colId = ctx.services.columns.list()[0].id;
    const item = ctx.services.items.create({ project_id: project.id, type: 'task', title: 'by key', column_id: colId });

    const byKey = await ctx.client.callTool({ name: 'ldash_get_item', arguments: { item_id: 'key-1' } });
    expect(byKey.isError).toBeFalsy();
    const assembled = JSON.parse((byKey.content[0] as { type: 'text'; text: string }).text);
    expect(assembled.item.id).toBe(item.id);
    expect(assembled.item.key).toBe('KEY-1');
  });
});
