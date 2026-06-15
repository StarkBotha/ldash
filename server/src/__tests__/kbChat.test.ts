import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from './helpers.js';
import { getKbChatToolDefinitions, createKbChatToolHandler } from '../chat/kbTools.js';
import { ConversationService } from '../services/conversations.js';
import { buildKbChatContext } from '../gateway/context.js';
import type { Services } from '../types.js';

type App = ReturnType<typeof createTestApp>;

function servicesOf(ctx: App): Services {
  return { projects: ctx.projectService, kb: ctx.kbService } as unknown as Services;
}

describe('KB chat tools', () => {
  let ctx: App;
  let projectId: string;
  let handler: ReturnType<typeof createKbChatToolHandler>;

  beforeEach(() => {
    ctx = createTestApp();
    projectId = ctx.projectService.create({ name: 'KB Chat Project', description: '' }).id;
    handler = createKbChatToolHandler(servicesOf(ctx), projectId);
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('exposes exactly the four KB chat tools', () => {
    const names = getKbChatToolDefinitions().map((t) => t.name).sort();
    expect(names).toEqual(['get_kb_doc', 'list_kb_docs', 'save_kb_doc', 'search_kb_docs']);
  });

  it('list_kb_docs returns documents in the project', async () => {
    ctx.kbService.create({ project_id: projectId, title: 'Alpha', content: 'a' });
    ctx.kbService.create({ project_id: projectId, title: 'Beta', content: 'b' });
    const out = JSON.parse(await handler('list_kb_docs', {})) as { title: string }[];
    expect(out.map((d) => d.title).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('search_kb_docs matches title and content with a snippet', async () => {
    ctx.kbService.create({
      project_id: projectId,
      title: 'Runbook',
      content: 'To deploy, restart the widget service after building.',
    });
    const out = JSON.parse(await handler('search_kb_docs', { query: 'widget' })) as {
      title: string;
      snippet: string;
    }[];
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Runbook');
    expect(out[0].snippet).toContain('widget');
  });

  it('search_kb_docs errors on empty query', async () => {
    expect(await handler('search_kb_docs', { query: '  ' })).toMatch(/Error/);
  });

  it('get_kb_doc resolves by key, id, and title', async () => {
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Architecture', content: 'design' });
    for (const ref of [doc.key, doc.id, 'architecture']) {
      const out = JSON.parse(await handler('get_kb_doc', { doc: ref })) as { content: string };
      expect(out.content).toBe('design');
    }
  });

  it('get_kb_doc errors for an unknown doc', async () => {
    expect(await handler('get_kb_doc', { doc: 'nope' })).toMatch(/not found/);
  });

  it('save_kb_doc creates a new document', async () => {
    const out = JSON.parse(await handler('save_kb_doc', { title: 'New Doc', content: '# hi' })) as {
      action: string;
      id: string;
    };
    expect(out.action).toBe('created');
    const stored = ctx.kbService.get(out.id);
    expect(stored?.content).toBe('# hi');
  });

  it('save_kb_doc upserts an existing document by case-insensitive title', async () => {
    const created = ctx.kbService.create({ project_id: projectId, title: 'Notes', content: 'old' });
    const out = JSON.parse(await handler('save_kb_doc', { title: 'notes', content: 'new' })) as {
      action: string;
      id: string;
    };
    expect(out.action).toBe('updated');
    expect(out.id).toBe(created.id);
    expect(ctx.kbService.get(created.id)?.content).toBe('new');
    // No duplicate created
    expect(ctx.kbService.list(projectId)).toHaveLength(1);
  });

  it('save_kb_doc errors on empty title', async () => {
    expect(await handler('save_kb_doc', { title: '', content: 'x' })).toMatch(/Error/);
  });

  it('is scoped to its project — cannot read another project\'s doc', async () => {
    const other = ctx.projectService.create({ name: 'Other', description: '' }).id;
    const otherDoc = ctx.kbService.create({ project_id: other, title: 'Secret', content: 's' });
    expect(await handler('get_kb_doc', { doc: otherDoc.id })).toMatch(/not found/);
    expect(await handler('get_kb_doc', { doc: otherDoc.key })).toMatch(/not found/);
    const list = JSON.parse(await handler('list_kb_docs', {})) as unknown[];
    expect(list).toHaveLength(0);
  });

  it('save_kb_doc writes an activity row and emits an event (via KbService)', async () => {
    const out = JSON.parse(await handler('save_kb_doc', { title: 'Tracked', content: 'c' })) as {
      id: string;
    };
    const activity = ctx.activityService.listByProject(projectId, { limit: 10 });
    expect(activity.some((a) => a.event_type === 'kb_doc.created')).toBe(true);
    expect(out.id).toBeTruthy();
  });
});

describe('buildKbChatContext', () => {
  let ctx: App;

  beforeEach(() => {
    ctx = createTestApp();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('lists current documents and names the project', () => {
    const projectId = ctx.projectService.create({ name: 'Docs Project', description: '' }).id;
    const doc = ctx.kbService.create({ project_id: projectId, title: 'Overview', content: 'x' });
    const prompt = buildKbChatContext(servicesOf(ctx), projectId);
    expect(prompt).toContain('Docs Project');
    expect(prompt).toContain(doc.key);
    expect(prompt).toContain('Overview');
  });

  it('handles an empty knowledgebase', () => {
    const projectId = ctx.projectService.create({ name: 'Empty Project', description: '' }).id;
    const prompt = buildKbChatContext(servicesOf(ctx), projectId);
    expect(prompt).toContain('empty');
  });
});

describe('getOrCreateKbConversation', () => {
  let ctx: App;
  let convs: ConversationService;

  beforeEach(() => {
    ctx = createTestApp();
    convs = new ConversationService(ctx.db);
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('creates a project-scoped kb conversation and returns the same one on repeat', () => {
    const projectId = ctx.projectService.create({ name: 'Conv Project', description: '' }).id;
    const first = convs.getOrCreateKbConversation(projectId);
    expect(first.type).toBe('kb');
    expect(first.item_id).toBeNull();
    expect(first.project_id).toBe(projectId);
    const second = convs.getOrCreateKbConversation(projectId);
    expect(second.id).toBe(first.id);
  });

  it('is distinct from the planning conversation of the same project', () => {
    const projectId = ctx.projectService.create({ name: 'Conv Project 2', description: '' }).id;
    const kb = convs.getOrCreateKbConversation(projectId);
    const planning = convs.getOrCreatePlanningConversation(projectId);
    expect(kb.id).not.toBe(planning.id);
  });
});
