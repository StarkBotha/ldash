import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, req } from './helpers.js';
import type { Hono } from 'hono';
import type { Project, ActivityEntry } from '../types.js';

let app: Hono;

beforeEach(() => {
  ({ app } = createTestApp());
});

describe('Projects', () => {
  it('AC1: GET /api/projects returns 200 with empty array on fresh DB', async () => {
    const { status, body } = await req(app, 'GET', '/api/projects');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('AC2: POST /api/projects creates a project with correct shape', async () => {
    const { status, body } = await req(app, 'POST', '/api/projects', { name: 'My Project' });
    expect(status).toBe(201);
    const p = body as Project;
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('My Project');
    expect(p.description).toBe('');
    expect(p.created_at).toBeTruthy();
    expect(p.updated_at).toBeTruthy();
  });

  it('AC3: POST /api/projects with missing name returns 400', async () => {
    const { status } = await req(app, 'POST', '/api/projects', {});
    expect(status).toBe(400);
  });

  it('AC4: POST /api/projects with empty name returns 400', async () => {
    const { status } = await req(app, 'POST', '/api/projects', { name: '' });
    expect(status).toBe(400);
  });

  it('AC5: GET /api/projects/:id returns 200 with project after creation', async () => {
    const { body: created } = await req(app, 'POST', '/api/projects', { name: 'Fetch Me' });
    const p = created as Project;
    const { status, body } = await req(app, 'GET', `/api/projects/${p.id}`);
    expect(status).toBe(200);
    expect((body as Project).id).toBe(p.id);
  });

  it('AC6: GET /api/projects/:nonexistent returns 404', async () => {
    const { status } = await req(app, 'GET', '/api/projects/doesnotexist');
    expect(status).toBe(404);
  });

  it('AC7: PATCH /api/projects/:id renames and updates updated_at', async () => {
    const { body: created } = await req(app, 'POST', '/api/projects', { name: 'Old Name' });
    const p = created as Project;
    const { status, body } = await req(app, 'PATCH', `/api/projects/${p.id}`, { name: 'Renamed' });
    expect(status).toBe(200);
    const updated = body as Project;
    expect(updated.name).toBe('Renamed');
    expect(updated.updated_at >= p.updated_at).toBe(true);
  });

  it('AC8: PATCH /api/projects/:id with empty body returns 400', async () => {
    const { body: created } = await req(app, 'POST', '/api/projects', { name: 'X' });
    const p = created as Project;
    const { status } = await req(app, 'PATCH', `/api/projects/${p.id}`, {});
    expect(status).toBe(400);
  });

  it('AC9: DELETE /api/projects/:id returns 204, subsequent GET returns 404', async () => {
    const { body: created } = await req(app, 'POST', '/api/projects', { name: 'To Delete' });
    const p = created as Project;
    const { status: delStatus } = await req(app, 'DELETE', `/api/projects/${p.id}`);
    expect(delStatus).toBe(204);
    const { status: getStatus } = await req(app, 'GET', `/api/projects/${p.id}`);
    expect(getStatus).toBe(404);
  });

  it('AC10: After POST /api/projects, activity has project.created entry', async () => {
    const { body: created } = await req(app, 'POST', '/api/projects', { name: 'Activity Test' });
    const p = created as Project;
    const { status, body } = await req(app, 'GET', `/api/projects/${p.id}/activity`);
    expect(status).toBe(200);
    const { entries } = body as { entries: ActivityEntry[] };
    expect(entries.some((e) => e.event_type === 'project.created')).toBe(true);
  });
});
