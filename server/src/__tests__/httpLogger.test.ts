/**
 * Integration test: HTTP request produces a log line in the log file.
 *
 * Because the logger is a cached ESM singleton, we use the exported logFilePath
 * and scan by scope + a unique run identifier.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ProjectService } from '../services/projects.js';
import { ColumnService } from '../services/columns.js';
import { ItemService } from '../services/items.js';
import { ActivityService } from '../services/activity.js';
import { projectsRouter } from '../routes/projects.js';
import { onError } from '../middleware/error.js';
import { httpLoggerMiddleware } from '../middleware/httpLogger.js';
import { logFilePath } from '../logger.js';

function readLogLines(): Array<Record<string, unknown>> {
  if (!existsSync(logFilePath)) return [];
  return readFileSync(logFilePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let app: Hono;
let requestDoneAt: number;
const uniquePath = `/api/projects`;

beforeAll(async () => {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);

  const projectService = new ProjectService(db);
  const columnService = new ColumnService(db);
  const itemService = new ItemService(db);
  const activityService = new ActivityService(db);

  void columnService;
  void itemService;

  app = new Hono();
  app.use('*', httpLoggerMiddleware);
  app.route('/api/projects', projectsRouter(projectService, activityService));
  app.onError(onError);

  // Make the actual request that should produce a log entry
  const res = await app.fetch(
    new Request('http://localhost' + uniquePath, { method: 'GET' })
  );
  expect(res.status).toBe(200);
  requestDoneAt = Date.now();
});

describe('HTTP logger integration', () => {
  it('produces a log line in the file after an HTTP request', () => {
    expect(existsSync(logFilePath)).toBe(true);

    const lines = readLogLines();
    const found = lines.find(
      (obj) =>
        obj.scope === 'http' &&
        obj.method === 'GET' &&
        obj.path === uniquePath &&
        obj.status === 200
    );

    expect(found).toBeDefined();
    expect(typeof found!.duration_ms).toBe('number');
    expect(found!.level).toBe('info');
  });

  it('logs 4xx responses at warn level', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/projects/nonexistent-404-test', { method: 'GET' })
    );
    expect(res.status).toBe(404);

    const lines = readLogLines();
    // The HTTP middleware logs the completed request with msg 'request' at warn for 4xx.
    // onError also logs under scope 'http' with msg 'unhandled error' at error level.
    // We look specifically for the per-request entry (msg === 'request').
    const found = lines.find(
      (obj) =>
        obj.scope === 'http' &&
        obj.msg === 'request' &&
        obj.path === '/api/projects/nonexistent-404-test' &&
        obj.status === 404
    );

    expect(found).toBeDefined();
    expect(found!.level).toBe('warn');
  });
});
