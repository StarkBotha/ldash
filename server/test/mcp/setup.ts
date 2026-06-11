import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { runSchema } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrationRunner.js';
import { seedColumns } from '../../src/db/seed.js';
import { ProjectService } from '../../src/services/projects.js';
import { ColumnService } from '../../src/services/columns.js';
import { ItemService } from '../../src/services/items.js';
import { CommentService } from '../../src/services/comments.js';
import { AttachmentService } from '../../src/services/attachments.js';
import { ActivityService } from '../../src/services/activity.js';
import { ConversationService } from '../../src/services/conversations.js';
import { SettingsService } from '../../src/services/settings.js';
import { projectsRouter } from '../../src/routes/projects.js';
import { columnsRouter } from '../../src/routes/columns.js';
import { itemsRouter, projectItemsRouter } from '../../src/routes/items.js';
import { commentsRouter, itemCommentsRouter } from '../../src/routes/comments.js';
import { projectActivityRouter, itemActivityRouter } from '../../src/routes/activity.js';
import { onError } from '../../src/middleware/error.js';
import { createMcpRouter } from '../../src/routes/mcp.js';
import { EventBus } from '../../src/events/bus.js';
import type { Services } from '../../src/types.js';

export interface TestContext {
  baseUrl: string;
  client: Client;
  services: {
    projects: ProjectService;
    items: ItemService;
    columns: ColumnService;
    comments: CommentService;
    attachments: AttachmentService;
    activity: ActivityService;
  };
  teardown: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  // 1. Open in-memory SQLite database
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 2. Run schema, migrations, and seed
  runSchema(db);
  runMigrations(db);
  seedColumns(db);

  // 3. Instantiate services
  const projectService = new ProjectService(db);
  const columnService = new ColumnService(db);
  const itemService = new ItemService(db);
  const commentService = new CommentService(db);
  const activityService = new ActivityService(db);
  const attachmentService = new AttachmentService(db, activityService, new EventBus());

  const conversationService = new ConversationService(db);
  const settingsService = new SettingsService(db);

  const services: Services = {
    projects: projectService,
    items: itemService,
    columns: columnService,
    comments: commentService,
    attachments: attachmentService,
    activity: activityService,
    conversations: conversationService,
    settings: settingsService,
  };

  // 4. Build the Hono app
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
  itemNestedApp.route('/activity', itemActivityRouter(activityService, itemService));
  app.route('/api/items/:itemId', itemNestedApp);

  app.route('/api/comments', commentsRouter(commentService, itemService, activityService));
  app.route('/mcp', createMcpRouter(services, undefined, db));

  app.onError(onError);

  // 5. Start server on random port
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });

  // 6. Get assigned port
  await new Promise<void>((resolve) => {
    // The server may already be listening if serve() is synchronous
    if ((server as any).listening) {
      resolve();
    } else {
      server.once('listening', () => resolve());
    }
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // 7. Create MCP Client
  const client = new Client({ name: 'ldash-test', version: '1.0.0' });

  // 8. Connect client
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  await client.connect(transport);

  // 9. Return context
  const teardown = async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return {
    baseUrl,
    client,
    services: {
      projects: projectService,
      items: itemService,
      columns: columnService,
      comments: commentService,
      attachments: attachmentService,
      activity: activityService,
    },
    teardown,
  };
}
