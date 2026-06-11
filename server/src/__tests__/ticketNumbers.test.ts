import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, req } from './helpers.js';
import type { Hono } from 'hono';
import type { Column, Item, Project } from '../types.js';
import { derivePrefix } from '../services/projectPrefix.js';

describe('derivePrefix', () => {
  it('uses initials for multi-word names', () => {
    expect(derivePrefix('dungeon sweeper', new Set())).toBe('DS');
    expect(derivePrefix('My Cool Project', new Set())).toBe('MCP');
  });

  it('uses first three letters for single-word names', () => {
    expect(derivePrefix('dungeonsweeper', new Set())).toBe('DUN');
    expect(derivePrefix('ldash', new Set())).toBe('LDA');
  });

  it('ignores digits and punctuation', () => {
    expect(derivePrefix('2fa-tool', new Set())).toBe('FT');
  });

  it('falls back to PRJ when the name has no letters', () => {
    expect(derivePrefix('123', new Set())).toBe('PRJ');
  });

  it('dedupes against taken prefixes with a numeric suffix', () => {
    expect(derivePrefix('ldash', new Set(['LDA']))).toBe('LDA2');
    expect(derivePrefix('ldash', new Set(['LDA', 'LDA2']))).toBe('LDA3');
  });
});

describe('ticket numbers', () => {
  let app: Hono;
  let firstColId: string;
  let projects: ReturnType<typeof createTestApp>['projectService'];
  let items: ReturnType<typeof createTestApp>['itemService'];

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    projects = ctx.projectService;
    items = ctx.itemService;
    const { body: cols } = await req(app, 'GET', '/api/columns');
    firstColId = (cols as Column[])[0].id;
  });

  it('assigns a prefix to new projects', () => {
    const p = projects.create({ name: 'dungeon sweeper' });
    expect(p.prefix).toBe('DS');
  });

  it('assigns unique prefixes to same-named projects', () => {
    const a = projects.create({ name: 'tool' });
    const b = projects.create({ name: 'tool' });
    expect(a.prefix).toBe('TOO');
    expect(b.prefix).toBe('TOO2');
  });

  it('numbers items sequentially per project and stores the key', () => {
    const p = projects.create({ name: 'ldash' });
    const a = items.create({ project_id: p.id, type: 'epic', title: 'E1', column_id: firstColId });
    const b = items.create({ project_id: p.id, type: 'task', title: 'T1', column_id: firstColId });
    expect(a.number).toBe(1);
    expect(a.key).toBe('LDA-1');
    expect(b.number).toBe(2);
    expect(b.key).toBe('LDA-2');
  });

  it('keeps counters independent between projects', () => {
    const p1 = projects.create({ name: 'alpha beta' });
    const p2 = projects.create({ name: 'gamma delta' });
    items.create({ project_id: p1.id, type: 'task', title: 'x', column_id: firstColId });
    const i2 = items.create({ project_id: p2.id, type: 'task', title: 'y', column_id: firstColId });
    expect(i2.key).toBe('GD-1');
  });

  it('never reuses a number after deletion', () => {
    const p = projects.create({ name: 'reuse check' });
    const a = items.create({ project_id: p.id, type: 'task', title: 'a', column_id: firstColId });
    items.delete(a.id);
    const b = items.create({ project_id: p.id, type: 'task', title: 'b', column_id: firstColId });
    expect(b.number).toBe(2);
    expect(b.key).toBe('RC-2');
  });

  it('throws when creating an item for a nonexistent project', () => {
    expect(() =>
      items.create({ project_id: 'no-such-project', type: 'task', title: 'x', column_id: firstColId })
    ).toThrow(/Project not found/);
  });

  it('exposes key and number through the HTTP API', async () => {
    const { body: project } = await req(app, 'POST', '/api/projects', { name: 'Http Test' });
    expect((project as Project).prefix).toBe('HT');
    const { body: item } = await req(app, 'POST', '/api/items', {
      project_id: (project as Project).id,
      type: 'task',
      title: 'via http',
      column_id: firstColId,
    });
    expect((item as Item).key).toBe('HT-1');
    expect((item as Item).number).toBe(1);
  });
});
