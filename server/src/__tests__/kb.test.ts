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

describe('KbService keys', () => {
  let ctx: App;

  beforeEach(() => {
    ctx = createTestApp();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('stamps sequential KB keys per project', () => {
    const p = ctx.projectService.create({ name: 'ldash' });
    const a = ctx.kbService.create({ project_id: p.id, title: 'Arch' });
    const b = ctx.kbService.create({ project_id: p.id, title: 'Runbook' });
    expect(a.number).toBe(1);
    expect(a.key).toBe('LDA-KB-1');
    expect(b.number).toBe(2);
    expect(b.key).toBe('LDA-KB-2');
  });

  it('keeps the KB counter independent of the item ticket counter', () => {
    const p = ctx.projectService.create({ name: 'ldash' });
    const col = ctx.columnService.list()[0];
    ctx.itemService.create({ project_id: p.id, type: 'task', title: 'T1', column_id: col.id });
    ctx.itemService.create({ project_id: p.id, type: 'task', title: 'T2', column_id: col.id });
    const doc = ctx.kbService.create({ project_id: p.id, title: 'Doc' });
    // Items took LDA-1, LDA-2; the KB doc still starts at LDA-KB-1
    expect(doc.key).toBe('LDA-KB-1');
  });

  it('keeps KB counters independent between projects', () => {
    const p1 = ctx.projectService.create({ name: 'alpha beta' });
    const p2 = ctx.projectService.create({ name: 'gamma delta' });
    ctx.kbService.create({ project_id: p1.id, title: 'x' });
    const d2 = ctx.kbService.create({ project_id: p2.id, title: 'y' });
    expect(d2.key).toBe('GD-KB-1');
  });

  it('never reuses a KB number after deletion', () => {
    const p = ctx.projectService.create({ name: 'reuse check' });
    const a = ctx.kbService.create({ project_id: p.id, title: 'a' });
    ctx.kbService.delete(a.id);
    const b = ctx.kbService.create({ project_id: p.id, title: 'b' });
    expect(b.number).toBe(2);
    expect(b.key).toBe('RC-KB-2');
  });

  it('throws when creating a doc for a nonexistent project', () => {
    expect(() => ctx.kbService.create({ project_id: 'no-such-project', title: 'x' })).toThrow(
      /Project not found/
    );
  });

  it('getByKey resolves case-insensitively', () => {
    const p = ctx.projectService.create({ name: 'ldash' });
    const doc = ctx.kbService.create({ project_id: p.id, title: 'Arch' });
    expect(ctx.kbService.getByKey('LDA-KB-1')?.id).toBe(doc.id);
    expect(ctx.kbService.getByKey('lda-kb-1')?.id).toBe(doc.id);
    expect(ctx.kbService.getByKey('LDA-KB-99')).toBeUndefined();
  });
});

describe('KbService.search', () => {
  let ctx: App;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestApp();
    projectId = createProject(ctx).id;
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('matches on title with an empty snippet when content does not match', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Deploy runbook', content: 'unrelated body' });
    const results = ctx.kbService.search(projectId, 'deploy');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: doc.id,
      project_id: projectId,
      key: doc.key,
      title: 'Deploy runbook',
      updated_at: doc.updated_at,
      snippet: '',
    });
  });

  it('matches on content with a snippet centered on the first occurrence', () => {
    const content = 'a'.repeat(150) + 'NEEDLE' + 'b'.repeat(150);
    ctx.kbService.create({ project_id: projectId, title: 'Long doc', content });

    const results = ctx.kbService.search(projectId, 'needle');
    expect(results).toHaveLength(1);
    const snippet = results[0].snippet;
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('NEEDLE');
    // 160 chars of content plus the two ellipses
    expect(snippet.length).toBe(162);
  });

  it('omits the leading ellipsis when the match is at the start of content', () => {
    const content = 'needle' + 'x'.repeat(300);
    ctx.kbService.create({ project_id: projectId, title: 'Front doc', content });

    const [result] = ctx.kbService.search(projectId, 'needle');
    expect(result.snippet.startsWith('needle')).toBe(true);
    expect(result.snippet.endsWith('…')).toBe(true);
    expect(result.snippet.length).toBe(161);
  });

  it('omits the trailing ellipsis when the match is at the end of content', () => {
    const content = 'x'.repeat(300) + 'needle';
    ctx.kbService.create({ project_id: projectId, title: 'Back doc', content });

    const [result] = ctx.kbService.search(projectId, 'needle');
    expect(result.snippet.startsWith('…')).toBe(true);
    expect(result.snippet.endsWith('needle')).toBe(true);
    expect(result.snippet.length).toBe(161);
  });

  it('returns short content whole, with no ellipses', () => {
    ctx.kbService.create({ project_id: projectId, title: 'Short doc', content: 'a tiny needle here' });
    const [result] = ctx.kbService.search(projectId, 'needle');
    expect(result.snippet).toBe('a tiny needle here');
  });

  it('matches case-insensitively in both title and content', () => {
    ctx.kbService.create({ project_id: projectId, title: 'ARCHITECTURE', content: 'nothing' });
    ctx.kbService.create({ project_id: projectId, title: 'Other', content: 'the Architecture diagram' });

    const results = ctx.kbService.search(projectId, 'architecture');
    expect(results).toHaveLength(2);
    // Content match snippet windows on the original casing
    expect(results.find((r) => r.title === 'Other')?.snippet).toBe('the Architecture diagram');
  });

  it('escapes LIKE wildcards — % and _ in the query match literally', () => {
    ctx.kbService.create({ project_id: projectId, title: 'Percent doc', content: 'progress is 50% complete' });
    ctx.kbService.create({ project_id: projectId, title: 'Underscore doc', content: 'uses snake_case names' });
    ctx.kbService.create({ project_id: projectId, title: 'Plain doc', content: 'progress is 50 percent' });

    const percent = ctx.kbService.search(projectId, '50%');
    expect(percent.map((r) => r.title)).toEqual(['Percent doc']);

    const underscore = ctx.kbService.search(projectId, 'snake_case');
    expect(underscore.map((r) => r.title)).toEqual(['Underscore doc']);
  });

  it('orders title matches before content-only matches, alphabetically within each group', () => {
    ctx.kbService.create({ project_id: projectId, title: 'Body only B', content: 'mentions needle here' });
    ctx.kbService.create({ project_id: projectId, title: 'Zebra needle', content: 'no match in body' });
    ctx.kbService.create({ project_id: projectId, title: 'Alpha needle', content: 'no match in body' });
    ctx.kbService.create({ project_id: projectId, title: 'Body only A', content: 'another needle mention' });

    const results = ctx.kbService.search(projectId, 'needle');
    expect(results.map((r) => r.title)).toEqual([
      'Alpha needle',
      'Zebra needle',
      'Body only A',
      'Body only B',
    ]);
  });

  it('scopes results to the project', () => {
    ctx.kbService.create({ project_id: projectId, title: 'Mine', content: 'needle' });
    const other = createProject(ctx, 'Other Project');
    ctx.kbService.create({ project_id: other.id, title: 'Theirs', content: 'needle' });

    const results = ctx.kbService.search(projectId, 'needle');
    expect(results.map((r) => r.title)).toEqual(['Mine']);
  });

  it('matches on the doc key, including a bare number fragment (LDA-63)', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Plain title', content: 'plain body' });
    expect(doc.key).toMatch(/-KB-1$/);

    // full key, a key fragment, and the bare number all match
    expect(ctx.kbService.search(projectId, doc.key).map((r) => r.id)).toContain(doc.id);
    expect(ctx.kbService.search(projectId, 'KB').map((r) => r.id)).toContain(doc.id);
    expect(ctx.kbService.search(projectId, '1').map((r) => r.id)).toContain(doc.id);

    // a key-only hit (no title/content match) has an empty snippet
    const hit = ctx.kbService.search(projectId, doc.key).find((r) => r.id === doc.id)!;
    expect(hit.snippet).toBe('');
  });

  it('sorts key matches ahead of content-only matches', () => {
    const keyed = ctx.kbService.create({ project_id: projectId, title: 'Zeta', content: 'no body match' });
    ctx.kbService.create({ project_id: projectId, title: 'Alpha', content: `mentions ${keyed.key} in the body` });

    const results = ctx.kbService.search(projectId, keyed.key);
    // The doc whose KEY matches ranks above the doc that only mentions it in content
    expect(results[0].id).toBe(keyed.id);
  });

  it('is read-only — writes no activity and emits no bus events', () => {
    ctx.kbService.create({ project_id: projectId, title: 'Doc', content: 'needle' });
    const before = ctx.activityService.listByProject(projectId, { limit: 50 }).length;

    const events: BoardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    try {
      ctx.kbService.search(projectId, 'needle');
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([]);
    expect(ctx.activityService.listByProject(projectId, { limit: 50 }).length).toBe(before);
  });
});

describe('KbService.searchAll', () => {
  let ctx: App;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestApp();
    projectId = createProject(ctx).id;
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('returns hits from all projects with the owning project name, ordered title-matches-first then alphabetically', () => {
    const other = createProject(ctx, 'Other Project');
    ctx.kbService.create({ project_id: other.id, title: 'Zebra needle', content: 'no match in body' });
    ctx.kbService.create({ project_id: projectId, title: 'Body only B', content: 'mentions needle here' });
    ctx.kbService.create({ project_id: projectId, title: 'Alpha needle', content: 'no match in body' });
    ctx.kbService.create({ project_id: other.id, title: 'Body only A', content: 'another needle mention' });

    const results = ctx.kbService.searchAll('needle');
    // Title matches first, alphabetical within each group — project is NOT an ordering key
    expect(results.map((r) => r.title)).toEqual([
      'Alpha needle',
      'Zebra needle',
      'Body only A',
      'Body only B',
    ]);
    expect(results.map((r) => r.project_name)).toEqual([
      'KB Test Project',
      'Other Project',
      'Other Project',
      'KB Test Project',
    ]);
    expect(results.map((r) => r.project_id)).toEqual([projectId, other.id, other.id, projectId]);
  });

  it('reuses the snippet semantics — content match snippets, title-only match yields empty snippet', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Runbook', content: 'restart the needle service' });
    ctx.kbService.create({ project_id: projectId, title: 'Needle title only', content: 'unrelated body' });

    const results = ctx.kbService.searchAll('needle');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: results[0].id,
      project_id: projectId,
      project_name: 'KB Test Project',
      key: results[0].key,
      title: 'Needle title only',
      updated_at: results[0].updated_at,
      snippet: '',
    });
    expect(results[1].id).toBe(doc.id);
    expect(results[1].snippet).toBe('restart the needle service');
  });

  it('escapes LIKE wildcards in the query', () => {
    ctx.kbService.create({ project_id: projectId, title: 'Percent doc', content: 'progress is 50% complete' });
    ctx.kbService.create({ project_id: projectId, title: 'Plain doc', content: 'progress is 50 percent' });

    const results = ctx.kbService.searchAll('50%');
    expect(results.map((r) => r.title)).toEqual(['Percent doc']);
  });

  it('matches on the doc key across projects', () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Plain', content: 'plain body' });
    const results = ctx.kbService.searchAll(doc.key);
    expect(results.map((r) => r.id)).toContain(doc.id);
  });

  it('is read-only — writes no activity and emits no bus events', () => {
    ctx.kbService.create({ project_id: projectId, title: 'Doc', content: 'needle' });
    const before = ctx.activityService.listByProject(projectId, { limit: 50 }).length;

    const events: BoardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    try {
      ctx.kbService.searchAll('needle');
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([]);
    expect(ctx.activityService.listByProject(projectId, { limit: 50 }).length).toBe(before);
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

  it('GET /api/projects/:projectId/kb/search returns matching results with snippets', async () => {
    ctx.kbService.create({ project_id: projectId, title: 'Runbook', content: 'restart the needle service' });
    ctx.kbService.create({ project_id: projectId, title: 'Unrelated', content: 'nothing here' });

    const res = await req(ctx.app, 'GET', `/api/projects/${projectId}/kb/search?q=needle`);
    expect(res.status).toBe(200);
    const results = res.body as Record<string, unknown>[];
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]).sort()).toEqual(['id', 'key', 'project_id', 'snippet', 'title', 'updated_at']);
    expect(results[0].title).toBe('Runbook');
    expect(results[0].snippet).toBe('restart the needle service');
  });

  it('GET /api/projects/:projectId/kb/search returns 400 for a missing or blank q', async () => {
    const missing = await req(ctx.app, 'GET', `/api/projects/${projectId}/kb/search`);
    expect(missing.status).toBe(400);
    const blank = await req(ctx.app, 'GET', `/api/projects/${projectId}/kb/search?q=%20%20`);
    expect(blank.status).toBe(400);
  });

  it('GET /api/projects/:projectId/kb/search returns 404 for a missing project', async () => {
    const res = await req(ctx.app, 'GET', '/api/projects/nope/kb/search?q=needle');
    expect(res.status).toBe(404);
  });

  it('GET /api/kb/search returns cross-project results with project_name', async () => {
    const other = createProject(ctx, 'Other Project');
    ctx.kbService.create({ project_id: projectId, title: 'Runbook', content: 'restart the needle service' });
    ctx.kbService.create({ project_id: other.id, title: 'Needle notes', content: 'nothing else' });

    const res = await req(ctx.app, 'GET', '/api/kb/search?q=needle');
    expect(res.status).toBe(200);
    const results = res.body as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    expect(Object.keys(results[0]).sort()).toEqual([
      'id',
      'key',
      'project_id',
      'project_name',
      'snippet',
      'title',
      'updated_at',
    ]);
    // Title match first
    expect(results[0].title).toBe('Needle notes');
    expect(results[0].project_name).toBe('Other Project');
    expect(results[1].title).toBe('Runbook');
    expect(results[1].project_name).toBe('KB Test Project');
    expect(results[1].snippet).toBe('restart the needle service');
  });

  it('GET /api/kb/search returns 400 for a missing or blank q — not shadowed by /:id', async () => {
    // A blank q must hit the search handler (400), not fall through to the
    // GET /api/kb/:id doc lookup (which would 404 on a "search" id).
    const missing = await req(ctx.app, 'GET', '/api/kb/search');
    expect(missing.status).toBe(400);
    const blank = await req(ctx.app, 'GET', '/api/kb/search?q=%20%20');
    expect(blank.status).toBe(400);
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

  it('registers the five kb tools', () => {
    expect([...tools.keys()].sort()).toEqual([
      'ldash_delete_kb_doc',
      'ldash_get_kb_doc',
      'ldash_list_kb_docs',
      'ldash_save_kb_doc',
      'ldash_search_kb_docs',
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

  it('ldash_get_kb_doc resolves by key (e.g. LDA-KB-1)', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Keyed', content: '# K' });
    const get = tools.get('ldash_get_kb_doc')!;

    const byKey = await get({ project_id: projectId, doc: doc.key });
    expect((JSON.parse(textOf(byKey)) as KbDocument).id).toBe(doc.id);

    const byKeyLower = await get({ project_id: projectId, doc: doc.key.toLowerCase() });
    expect((JSON.parse(textOf(byKeyLower)) as KbDocument).id).toBe(doc.id);
  });

  it('ldash_save_kb_doc returns the key on create and update', async () => {
    const save = tools.get('ldash_save_kb_doc')!;
    const created = JSON.parse(textOf(await save({ project_id: projectId, title: 'Doc', content: 'v1' }))) as {
      key: string;
      action: string;
    };
    expect(created.action).toBe('created');
    expect(created.key).toBeTruthy();

    const updated = JSON.parse(textOf(await save({ project_id: projectId, title: 'Doc', content: 'v2' }))) as {
      key: string;
      action: string;
    };
    expect(updated.action).toBe('updated');
    expect(updated.key).toBe(created.key);
  });

  it('ldash_list_kb_docs returns id, title, and updated_at', async () => {
    ctx.kbService.create({ project_id: projectId, title: 'B doc', content: 'b' });
    ctx.kbService.create({ project_id: projectId, title: 'A doc', content: 'a' });

    const list = tools.get('ldash_list_kb_docs')!;
    const result = await list({ project_id: projectId });
    const docs = JSON.parse(textOf(result)) as Record<string, unknown>[];
    expect(docs.map((d) => d.title)).toEqual(['A doc', 'B doc']);
    for (const d of docs) {
      expect(Object.keys(d).sort()).toEqual(['id', 'key', 'title', 'updated_at']);
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

  it('ldash_search_kb_docs returns matching docs with snippets', async () => {
    ctx.kbService.create({ project_id: projectId, title: 'Deploy runbook', content: 'restart the needle service' });
    ctx.kbService.create({ project_id: projectId, title: 'Unrelated', content: 'nothing here' });

    const search = tools.get('ldash_search_kb_docs')!;
    const result = await search({ project_id: projectId, query: 'needle' });
    expect(result.isError).toBeUndefined();

    const docs = JSON.parse(textOf(result)) as Record<string, unknown>[];
    expect(docs).toHaveLength(1);
    expect(Object.keys(docs[0]).sort()).toEqual(['id', 'key', 'snippet', 'title', 'updated_at']);
    expect(docs[0].title).toBe('Deploy runbook');
    expect(docs[0].snippet).toBe('restart the needle service');
  });

  it('ldash_search_kb_docs with project_id stays scoped to that project', async () => {
    const other = createProject(ctx, 'Other Project');
    ctx.kbService.create({ project_id: projectId, title: 'Mine', content: 'needle' });
    ctx.kbService.create({ project_id: other.id, title: 'Theirs', content: 'needle' });

    const search = tools.get('ldash_search_kb_docs')!;
    const result = await search({ project_id: projectId, query: 'needle' });
    expect(result.isError).toBeUndefined();

    const docs = JSON.parse(textOf(result)) as Record<string, unknown>[];
    expect(docs.map((d) => d.title)).toEqual(['Mine']);
    expect(docs[0]).not.toHaveProperty('project_name');
  });

  it('ldash_search_kb_docs without project_id searches all projects and includes project_name', async () => {
    const other = createProject(ctx, 'Other Project');
    ctx.kbService.create({ project_id: projectId, title: 'Mine', content: 'restart the needle service' });
    ctx.kbService.create({ project_id: other.id, title: 'Needle theirs', content: 'no body match' });

    const search = tools.get('ldash_search_kb_docs')!;
    const result = await search({ query: 'needle' });
    expect(result.isError).toBeUndefined();

    const docs = JSON.parse(textOf(result)) as Record<string, unknown>[];
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect(Object.keys(d).sort()).toEqual(['id', 'key', 'project_name', 'snippet', 'title', 'updated_at']);
    }
    // Title match first, with each hit carrying its owning project's name
    expect(docs[0].title).toBe('Needle theirs');
    expect(docs[0].project_name).toBe('Other Project');
    expect(docs[1].title).toBe('Mine');
    expect(docs[1].project_name).toBe('KB Test Project');
    expect(docs[1].snippet).toBe('restart the needle service');
  });

  it('ldash_search_kb_docs errors on a blank query in both modes', async () => {
    const search = tools.get('ldash_search_kb_docs')!;

    const scoped = await search({ project_id: projectId, query: '   ' });
    expect(scoped.isError).toBe(true);
    expect(textOf(scoped)).toContain('query must not be empty');

    const global = await search({ query: '   ' });
    expect(global.isError).toBe(true);
    expect(textOf(global)).toContain('query must not be empty');
  });

  it('ldash_search_kb_docs errors on a missing project', async () => {
    const search = tools.get('ldash_search_kb_docs')!;
    const result = await search({ project_id: 'nope', query: 'needle' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('project not found');
  });

  it('all five tools error on a missing project', async () => {
    for (const [name, handler] of tools) {
      const input: Record<string, unknown> = { project_id: 'nope', title: 'x', content: 'x', doc: 'x', query: 'x' };
      const result = await handler(input);
      expect(result.isError, `${name} should error`).toBe(true);
      expect(textOf(result)).toContain('project not found');
    }
  });
});
