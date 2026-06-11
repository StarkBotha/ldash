import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import http from 'node:http';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ProjectService } from '../services/projects.js';
import { ColumnService } from '../services/columns.js';
import { ItemService } from '../services/items.js';
import { CommentService } from '../services/comments.js';
import { ActivityService } from '../services/activity.js';
import { EventBus } from '../events/bus.js';
import { createSseRouter } from '../routes/sse.js';
import { projectsRouter } from '../routes/projects.js';
import { columnsRouter } from '../routes/columns.js';
import { itemsRouter } from '../routes/items.js';
import { commentsRouter } from '../routes/comments.js';
import { onError } from '../middleware/error.js';
import type { BoardEvent } from '../events/types.js';
import type { Server } from 'node:http';

interface SseConnection {
  events: BoardEvent[];
  raw: string[];
  close: () => void;
}

function connectSSE(port: number, projectId: string): Promise<SseConnection> {
  return new Promise((resolve) => {
    const events: BoardEvent[] = [];
    const raw: string[] = [];
    let buffer = '';

    const req = http.get(
      `http://127.0.0.1:${port}/api/sse?projectId=${encodeURIComponent(projectId)}`,
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          raw.push(chunk);

          // Parse complete SSE messages (split on double newline)
          const messages = buffer.split('\n\n');
          // Keep the last incomplete chunk in the buffer
          buffer = messages.pop() ?? '';

          for (const msg of messages) {
            if (!msg.trim()) continue;
            const lines = msg.split('\n');
            let eventName = '';
            let dataLine = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventName = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                dataLine = line.slice(6).trim();
              }
            }
            if (eventName === 'board' && dataLine) {
              try {
                const parsed = JSON.parse(dataLine) as BoardEvent;
                events.push(parsed);
              } catch {
                // ignore parse errors
              }
            }
          }
        });
      }
    );

    req.on('socket', () => {
      // Resolve once we have the socket, giving time to establish connection
    });

    // Resolve after a short delay to let connection establish
    setTimeout(() => {
      resolve({
        events,
        raw,
        close: () => req.destroy(),
      });
    }, 50);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let db: Database.Database;
let server: Server;
let port: number;
let bus: EventBus;
let projectService: ProjectService;
let columnService: ColumnService;
let itemService: ItemService;
let commentService: CommentService;
let activityService: ActivityService;
let app: Hono;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runSchema(db);
  runMigrations(db);
  seedColumns(db);

  projectService = new ProjectService(db);
  columnService = new ColumnService(db);
  itemService = new ItemService(db);
  commentService = new CommentService(db);
  activityService = new ActivityService(db);

  bus = new EventBus();

  app = new Hono();
  app.route('/', createSseRouter(bus, { heartbeatIntervalMs: 100 }));
  app.route('/api/columns', columnsRouter(columnService, activityService, bus));
  app.route('/api/projects', projectsRouter(projectService, activityService, bus));
  app.route('/api/items', itemsRouter(itemService, projectService, columnService, activityService, bus));
  app.route('/api/comments', commentsRouter(commentService, itemService, activityService, bus));
  app.onError(onError);

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  db.close();
});

describe('SSE endpoint', () => {
  it('returns 400 when projectId is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sse`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('projectId query param required');
  });

  it('responds with text/event-stream content type (EventSource requirement)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sse?projectId=proj_ct`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });

  it('connects and receives initial : connected comment', async () => {
    const conn = await connectSSE(port, 'proj_test');
    await wait(100);

    const allRaw = conn.raw.join('');
    expect(allRaw).toContain(': connected');
    conn.close();
  });

  it('does not deliver events for a different project', async () => {
    // Create two projects
    const projA = projectService.create({ name: 'Project A', description: '' });
    const projB = projectService.create({ name: 'Project B', description: '' });

    const conn = await connectSSE(port, projA.id);
    await wait(50);

    // Create an item in project B
    const cols = columnService.list();
    itemService.create({
      project_id: projB.id,
      parent_id: null,
      type: 'task',
      title: 'B task',
      description: '',
      column_id: cols[0].id,
    });

    bus.emit({
      type: 'item.created',
      projectId: projB.id,
      entityId: 'item_b',
      data: { item: { id: 'item_b' } },
    });

    await wait(200);
    expect(conn.events).toHaveLength(0);
    conn.close();
  });

  it('receives item.created event when item is created in the subscribed project', async () => {
    const project = projectService.create({ name: 'My Project', description: '' });
    const cols = columnService.list();

    const conn = await connectSSE(port, project.id);
    await wait(50);

    // POST a new item via the items route by directly triggering the service + emitting
    const item = itemService.create({
      project_id: project.id,
      parent_id: null,
      type: 'task',
      title: 'New Task',
      description: '',
      column_id: cols[0].id,
    });

    bus.emit({
      type: 'item.created',
      projectId: project.id,
      entityId: item.id,
      data: { item },
    });

    await wait(200);

    expect(conn.events.length).toBeGreaterThanOrEqual(1);
    const found = conn.events.find((e) => e.type === 'item.created');
    expect(found).toBeDefined();
    expect((found!.data.item as { id: string }).id).toBe(item.id);
    conn.close();
  });

  it('receives item.moved event when item is moved', async () => {
    const project = projectService.create({ name: 'Move Project', description: '' });
    const cols = columnService.list();

    const item = itemService.create({
      project_id: project.id,
      parent_id: null,
      type: 'task',
      title: 'Moveable Task',
      description: '',
      column_id: cols[0].id,
    });

    const conn = await connectSSE(port, project.id);
    await wait(50);

    const movedItem = itemService.move(item.id, { column_id: cols[1].id });

    bus.emit({
      type: 'item.moved',
      projectId: project.id,
      entityId: item.id,
      data: { item: movedItem, fromColumnId: cols[0].id, toColumnId: cols[1].id },
    });

    await wait(200);

    const found = conn.events.find((e) => e.type === 'item.moved');
    expect(found).toBeDefined();
    conn.close();
  });

  it('column.reordered event is delivered regardless of projectId', async () => {
    const cols = columnService.list();
    const conn = await connectSSE(port, 'some-project-id');
    await wait(50);

    const reordered = columnService.reorder(cols.map((c) => c.id).reverse());

    bus.emit({
      type: 'column.reordered',
      projectId: '',
      entityId: '',
      data: { columns: reordered },
    });

    await wait(200);

    const found = conn.events.find((e) => e.type === 'column.reordered');
    expect(found).toBeDefined();
    conn.close();
  });

  it('heartbeat is sent within the configured interval', async () => {
    const conn = await connectSSE(port, 'proj_heartbeat');
    // heartbeatIntervalMs is 100ms in test setup
    await wait(250);

    const allRaw = conn.raw.join('');
    expect(allRaw).toContain(': heartbeat');
    conn.close();
  });
});
