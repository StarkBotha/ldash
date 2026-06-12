import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, req } from './helpers.js';
import { registerKbTools } from '../mcp/tools/kb.js';
import { eventBus } from '../events/bus.js';
import type { BoardEvent } from '../events/types.js';
import type { Services, KbDocument } from '../types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type App = ReturnType<typeof createTestApp>;

function createProject(ctx: App, name = 'KB Test Project') {
  return ctx.projectService.create({ name, description: '' });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('kb migration', () => {
  let ctx: App;

  beforeEach(() => {
    ctx = createTestApp();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('creates the kb_documents table on a fresh DB', () => {
    const row = ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kb_documents'")
      .get();
    expect(row).toBeDefined();
  });

  it('cascades kb docs when their project is deleted', () => {
    const project = createProject(ctx);
    const doc = ctx.kbService.create({ project_id: project.id, title: 'Doomed doc', content: 'x' });
    expect(ctx.kbService.get(doc.id)).toBeDefined();

    ctx.projectService.delete(project.id);

    expect(ctx.kbService.get(doc.id)).toBeUndefined();
    const count = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM kb_documents WHERE project_id = ?')
      .get(project.id) as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('KbService', () => {
  let ctx: App;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestApp();
    projectId = createProject(ctx).id;
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('creates a doc with trimmed title and default empty content', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: '  Architecture  ' });
    expect(doc.id).toBeTruthy();
    expect(doc.project_id).toBe(projectId);
    expect(doc.title).toBe('Architecture');
    expect(doc.content).toBe('');
    expect(doc.created_at).toBeTruthy();
    expect(doc.updated_at).toBeTruthy();
  });

  it('rejects an empty title on create', () => {
    expect(() => ctx.kbService.create({ project_id: projectId, title: '   ' })).toThrow();
  });

  it('get returns undefined for a missing id', () => {
    expect(ctx.kbService.get('nope')).toBeUndefined();
  });

  it('getByTitle matches case-insensitively within the project', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Deploy Runbook', content: 'steps' });
    expect(ctx.kbService.getByTitle(projectId, 'deploy runbook')?.id).toBe(doc.id);
    expect(ctx.kbService.getByTitle(projectId, 'DEPLOY RUNBOOK')?.id).toBe(doc.id);
    expect(ctx.kbService.getByTitle(projectId, 'Deploy')).toBeUndefined();

    const otherProject = createProject(ctx, 'Other Project');
    expect(ctx.kbService.getByTitle(otherProject.id, 'Deploy Runbook')).toBeUndefined();
  });

  it('list returns summaries without content, ordered by title', () => {
    ctx.kbService.create({ project_id: projectId, title: 'Zebra notes', content: 'zzz' });
    ctx.kbService.create({ project_id: projectId, title: 'Architecture', content: 'aaa' });

    const list = ctx.kbService.list(projectId);
    expect(list.map((d) => d.title)).toEqual(['Architecture', 'Zebra notes']);
    for (const summary of list) {
      expect(summary).not.toHaveProperty('content');
      expect(summary.id).toBeTruthy();
      expect(summary.project_id).toBe(projectId);
      expect(summary.created_at).toBeTruthy();
      expect(summary.updated_at).toBeTruthy();
    }
  });

  it('update changes fields and bumps updated_at', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Runbook', content: 'v1' });
    await wait(5);
    const updated = ctx.kbService.update(doc.id, { content: 'v2' });
    expect(updated.content).toBe('v2');
    expect(updated.title).toBe('Runbook');
    expect(updated.updated_at > doc.updated_at).toBe(true);

    const retitled = ctx.kbService.update(doc.id, { title: 'Runbook v2' });
    expect(retitled.title).toBe('Runbook v2');
    expect(retitled.content).toBe('v2');
  });

  it('update rejects an empty title and a missing doc', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Doc' });
    expect(() => ctx.kbService.update(doc.id, { title: '  ' })).toThrow();
    expect(() => ctx.kbService.update('nope', { content: 'x' })).toThrow();
  });

  it('delete returns true when deleted and false for a missing doc', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Doc' });
    expect(ctx.kbService.delete(doc.id)).toBe(true);
    expect(ctx.kbService.get(doc.id)).toBeUndefined();
    expect(ctx.kbService.delete(doc.id)).toBe(false);
  });

  it('writes activity rows with project_id set and item_id null', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Doc', content: 'x' });
    ctx.kbService.update(doc.id, { content: 'y' });
    ctx.kbService.delete(doc.id);

    const entries = ctx.activityService.listByProject(projectId, { limit: 50 });
    const kbEntries = entries.filter((e) => e.event_type.startsWith('kb_doc.'));
    expect(kbEntries.map((e) => e.event_type).sort()).toEqual([
      'kb_doc.created',
      'kb_doc.deleted',
      'kb_doc.updated',
    ]);
    for (const entry of kbEntries) {
      expect(entry.project_id).toBe(projectId);
      expect(entry.item_id).toBeNull();
      expect(entry.payload.doc_id).toBe(doc.id);
      expect(entry.payload.title).toBe('Doc');
    }
  });

  it('emits kb_doc events on the bus', () => {
    const events: BoardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => {
      if (e.type.startsWith('kb_doc.')) events.push(e);
    });

    try {
      const doc = ctx.kbService.create({ project_id: projectId, title: 'Doc' });
      ctx.kbService.update(doc.id, { content: 'updated' });
      ctx.kbService.delete(doc.id);

      expect(events.map((e) => e.type)).toEqual(['kb_doc.created', 'kb_doc.updated', 'kb_doc.deleted']);
      for (const event of events) {
        expect(event.projectId).toBe(projectId);
        expect(event.entityId).toBe(doc.id);
      }
      expect((events[0].data.doc as KbDocument).title).toBe('Doc');
      expect((events[1].data.doc as KbDocument).content).toBe('updated');
      expect(events[2].data).toEqual({ id: doc.id });
    } finally {
      unsubscribe();
    }
  });
});

describe('kb routes', () => {
  let ctx: App;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestApp();
    projectId = createProject(ctx).id;
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('GET /api/projects/:projectId/kb returns summaries', async () => {
    ctx.kbService.create({ project_id: projectId, title: 'Doc A', content: 'secret' });
    const res = await req(ctx.app, 'GET', `/api/projects/${projectId}/kb`);
    expect(res.status).toBe(200);
    const list = res.body as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Doc A');
    expect(list[0]).not.toHaveProperty('content');
  });

  it('GET /api/projects/:projectId/kb returns 404 for a missing project', async () => {
    const res = await req(ctx.app, 'GET', '/api/projects/nope/kb');
    expect(res.status).toBe(404);
  });

  it('POST /api/projects/:projectId/kb creates a doc', async () => {
    const res = await req(ctx.app, 'POST', `/api/projects/${projectId}/kb`, {
      title: 'How to deploy',
      content: '# Steps',
    });
    expect(res.status).toBe(201);
    const doc = res.body as KbDocument;
    expect(doc.title).toBe('How to deploy');
    expect(doc.content).toBe('# Steps');
    expect(doc.project_id).toBe(projectId);
  });

  it('POST defaults content to empty string', async () => {
    const res = await req(ctx.app, 'POST', `/api/projects/${projectId}/kb`, { title: 'Bare' });
    expect(res.status).toBe(201);
    expect((res.body as KbDocument).content).toBe('');
  });

  it('POST returns 400 for a missing or empty title', async () => {
    const missing = await req(ctx.app, 'POST', `/api/projects/${projectId}/kb`, { content: 'x' });
    expect(missing.status).toBe(400);
    const empty = await req(ctx.app, 'POST', `/api/projects/${projectId}/kb`, { title: '   ' });
    expect(empty.status).toBe(400);
  });

  it('POST returns 404 for a missing project', async () => {
    const res = await req(ctx.app, 'POST', '/api/projects/nope/kb', { title: 'Doc' });
    expect(res.status).toBe(404);
  });

  it('GET /api/kb/:id returns the full doc', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Doc', content: 'body' });
    const res = await req(ctx.app, 'GET', `/api/kb/${doc.id}`);
    expect(res.status).toBe(200);
    expect((res.body as KbDocument).content).toBe('body');
  });

  it('GET /api/kb/:id returns 404 for a missing doc', async () => {
    const res = await req(ctx.app, 'GET', '/api/kb/nope');
    expect(res.status).toBe(404);
  });

  it('PATCH /api/kb/:id updates title and content', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Old', content: 'v1' });
    const res = await req(ctx.app, 'PATCH', `/api/kb/${doc.id}`, { title: 'New', content: 'v2' });
    expect(res.status).toBe(200);
    const updated = res.body as KbDocument;
    expect(updated.title).toBe('New');
    expect(updated.content).toBe('v2');
  });

  it('PATCH returns 400 for an empty title or an empty body', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Doc' });
    const emptyTitle = await req(ctx.app, 'PATCH', `/api/kb/${doc.id}`, { title: '  ' });
    expect(emptyTitle.status).toBe(400);
    const noFields = await req(ctx.app, 'PATCH', `/api/kb/${doc.id}`, {});
    expect(noFields.status).toBe(400);
  });

  it('PATCH returns 404 for a missing doc', async () => {
    const res = await req(ctx.app, 'PATCH', '/api/kb/nope', { title: 'New' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/kb/:id returns 204 then 404', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Doc' });
    const res = await req(ctx.app, 'DELETE', `/api/kb/${doc.id}`);
    expect(res.status).toBe(204);
    const again = await req(ctx.app, 'DELETE', `/api/kb/${doc.id}`);
    expect(again.status).toBe(404);
  });
});

describe('kb MCP tools', () => {
  type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
  type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

  let ctx: App;
  let projectId: string;
  let tools: Map<string, ToolHandler>;

  function textOf(result: ToolResult): string {
    return result.content[0]?.text ?? '';
  }

  beforeEach(() => {
    ctx = createTestApp();
    projectId = createProject(ctx).id;

    // No existing MCP tool tests in the suite — capture the registered handlers
    // through a stub server and invoke them directly.
    tools = new Map();
    const fakeServer = {
      tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;

    const services = { projects: ctx.projectService, kb: ctx.kbService } as unknown as Services;
    registerKbTools(fakeServer, services);
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('registers the four kb tools', () => {
    expect([...tools.keys()].sort()).toEqual([
      'ldash_delete_kb_doc',
      'ldash_get_kb_doc',
      'ldash_list_kb_docs',
      'ldash_save_kb_doc',
    ]);
  });

  it('ldash_save_kb_doc creates then updates (upsert by case-insensitive title)', async () => {
    const save = tools.get('ldash_save_kb_doc')!;

    const first = await save({ project_id: projectId, title: 'Hosting Info', content: 'v1' });
    expect(first.isError).toBeUndefined();
    const created = JSON.parse(textOf(first)) as { id: string; title: string; action: string };
    expect(created.action).toBe('created');
    expect(created.title).toBe('Hosting Info');

    const second = await save({ project_id: projectId, title: 'hosting info', content: 'v2' });
    const updated = JSON.parse(textOf(second)) as { id: string; title: string; action: string };
    expect(updated.action).toBe('updated');
    expect(updated.id).toBe(created.id);
    // Canonical casing follows the latest save
    expect(updated.title).toBe('hosting info');

    const doc = ctx.kbService.get(created.id)!;
    expect(doc.content).toBe('v2');
    expect(doc.title).toBe('hosting info');
    expect(ctx.kbService.list(projectId)).toHaveLength(1);
  });

  it('ldash_save_kb_doc writes activity as the claude actor', async () => {
    const save = tools.get('ldash_save_kb_doc')!;
    await save({ project_id: projectId, title: 'Doc', content: 'x' });

    const entries = ctx.activityService.listByProject(projectId, { limit: 10 });
    const created = entries.find((e) => e.event_type === 'kb_doc.created')!;
    expect(created.actor_type).toBe('claude');
    expect(created.actor_id).toBe('claude-code');
  });

  it('ldash_get_kb_doc resolves by id and by title', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Architecture', content: '# Arch' });
    const get = tools.get('ldash_get_kb_doc')!;

    const byId = await get({ project_id: projectId, doc: doc.id });
    expect((JSON.parse(textOf(byId)) as KbDocument).content).toBe('# Arch');

    const byTitle = await get({ project_id: projectId, doc: 'architecture' });
    expect((JSON.parse(textOf(byTitle)) as KbDocument).id).toBe(doc.id);

    const missing = await get({ project_id: projectId, doc: 'nope' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('document not found');
  });

  it('ldash_list_kb_docs returns id, title, and updated_at', async () => {
    ctx.kbService.create({ project_id: projectId, title: 'B doc', content: 'b' });
    ctx.kbService.create({ project_id: projectId, title: 'A doc', content: 'a' });

    const list = tools.get('ldash_list_kb_docs')!;
    const result = await list({ project_id: projectId });
    const docs = JSON.parse(textOf(result)) as Record<string, unknown>[];
    expect(docs.map((d) => d.title)).toEqual(['A doc', 'B doc']);
    for (const d of docs) {
      expect(Object.keys(d).sort()).toEqual(['id', 'title', 'updated_at']);
    }
  });

  it('ldash_delete_kb_doc deletes by title and errors when missing', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Old runbook' });
    const del = tools.get('ldash_delete_kb_doc')!;

    const result = await del({ project_id: projectId, doc: 'old runbook' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Old runbook');
    expect(ctx.kbService.get(doc.id)).toBeUndefined();

    const missing = await del({ project_id: projectId, doc: 'old runbook' });
    expect(missing.isError).toBe(true);
  });

  it('all four tools error on a missing project', async () => {
    for (const [name, handler] of tools) {
      const input: Record<string, unknown> = { project_id: 'nope', title: 'x', content: 'x', doc: 'x' };
      const result = await handler(input);
      expect(result.isError, `${name} should error`).toBe(true);
      expect(textOf(result)).toContain('project not found');
    }
  });
});
