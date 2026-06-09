import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './setup.js';

describe('ldash_list_projects', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('returns an empty array when no projects exist', async () => {
    const result = await ctx.client.callTool({ name: 'ldash_list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    const projects = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(Array.isArray(projects)).toBe(true);
    expect(projects).toHaveLength(0);
  });

  it('returns a project after creating one via service', async () => {
    const created = ctx.services.projects.create({ name: 'Test Project', description: 'A test' });

    const result = await ctx.client.callTool({ name: 'ldash_list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    const projects = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(created.id);
    expect(projects[0].name).toBe('Test Project');
    expect(projects[0].description).toBe('A test');
  });

  it('returns valid project fields', async () => {
    ctx.services.projects.create({ name: 'My Project' });

    const result = await ctx.client.callTool({ name: 'ldash_list_projects', arguments: {} });
    const projects = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    const p = projects[0];
    expect(typeof p.id).toBe('string');
    expect(p.id.length).toBeGreaterThan(0);
    expect(p.name).toBe('My Project');
    expect(typeof p.created_at).toBe('string');
    expect(typeof p.updated_at).toBe('string');
  });
});
