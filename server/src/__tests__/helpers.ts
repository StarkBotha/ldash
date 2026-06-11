import Database from 'better-sqlite3';
import { runSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrationRunner.js';
import { seedColumns } from '../db/seed.js';
import { ProjectService } from '../services/projects.js';
import { ColumnService } from '../services/columns.js';
import { ItemService } from '../services/items.js';
import { CommentService } from '../services/comments.js';
import { AttachmentService } from '../services/attachments.js';
import { ActivityService } from '../services/activity.js';
import { projectsRouter } from '../routes/projects.js';
import { columnsRouter } from '../routes/columns.js';
import { itemsRouter, projectItemsRouter } from '../routes/items.js';
import { commentsRouter, itemCommentsRouter } from '../routes/comments.js';
import { attachmentsRouter, itemAttachmentsRouter } from '../routes/attachments.js';
import { projectActivityRouter, itemActivityRouter } from '../routes/activity.js';
import { onError } from '../middleware/error.js';
import { eventBus } from '../events/bus.js';
import { Hono } from 'hono';

export function createTestApp() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runSchema(db);
  runMigrations(db);
  seedColumns(db);

  const projectService = new ProjectService(db);
  const columnService = new ColumnService(db);
  const itemService = new ItemService(db);
  const commentService = new CommentService(db);
  const activityService = new ActivityService(db);
  const attachmentService = new AttachmentService(db, activityService, eventBus);

  const app = new Hono();

  app.route('/api/columns', columnsRouter(columnService, activityService));
  app.route('/api/projects', projectsRouter(projectService, activityService));
  app.route('/api/items', itemsRouter(itemService, projectService, columnService, activityService));

  const projectNestedApp = new Hono();
  projectNestedApp.route('/items', projectItemsRouter(itemService, projectService, activityService));
  projectNestedApp.route('/activity', projectActivityRouter(activityService, projectService));
  app.route('/api/projects/:projectId', projectNestedApp);

  const itemNestedApp = new Hono();
  itemNestedApp.route('/comments', itemCommentsRouter(commentService, itemService));
  itemNestedApp.route('/attachments', itemAttachmentsRouter(attachmentService, itemService));
  itemNestedApp.route('/activity', itemActivityRouter(activityService, itemService));
  app.route('/api/items/:itemId', itemNestedApp);

  app.route('/api/comments', commentsRouter(commentService, itemService, activityService));
  app.route('/api/attachments', attachmentsRouter(attachmentService));

  app.onError(onError);

  return { app, db, projectService, columnService, itemService, commentService, attachmentService, activityService };
}

export async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  let parsed: unknown;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    parsed = await res.json();
  } else {
    parsed = await res.text();
  }
  return { status: res.status, body: parsed };
}
