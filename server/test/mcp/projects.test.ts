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

describe('ldash_create_project', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('creates a project and returns it', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_create_project',
      arguments: { name: 'New Project', description: 'From MCP' },
    });
    expect(result.isError).toBeFalsy();
    const project = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(typeof project.id).toBe('string');
    expect(project.name).toBe('New Project');
    expect(project.description).toBe('From MCP');

    const stored = ctx.services.projects.get(project.id);
    expect(stored?.name).toBe('New Project');
  });

  it('trims the name and defaults description to empty string', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_create_project',
      arguments: { name: '  Trimmed  ' },
    });
    expect(result.isError).toBeFalsy();
    const project = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(project.name).toBe('Trimmed');
    expect(project.description).toBe('');
  });

  it('rejects a whitespace-only name', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_create_project',
      arguments: { name: '   ' },
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('name must not be empty');
    expect(ctx.services.projects.list()).toHaveLength(0);
  });

  it('writes an activity entry with actor claude', async () => {
    const result = await ctx.client.callTool({
      name: 'ldash_create_project',
      arguments: { name: 'Audited' },
    });
    const project = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    const entries = ctx.services.activity.listByProject(project.id, { limit: 10 });
    const created = entries.find((e) => e.event_type === 'project.created');
    expect(created).toBeDefined();
    expect(created?.actor_type).toBe('claude');
    expect(created?.actor_id).toBe('claude-code');
    expect(created?.payload).toEqual({ name: 'Audited' });
  });
});
