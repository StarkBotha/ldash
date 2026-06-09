import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { openDatabase } from './db/connection.js';
import { runSchema } from './db/schema.js';
import { runMigrations } from './db/migrationRunner.js';
import { seedColumns } from './db/seed.js';
import { ProjectService } from './services/projects.js';
import { ColumnService } from './services/columns.js';
import { ItemService } from './services/items.js';
import { CommentService } from './services/comments.js';
import { ActivityService } from './services/activity.js';
import { ConversationService } from './services/conversations.js';
import { SettingsService } from './services/settings.js';
import { projectsRouter } from './routes/projects.js';
import { columnsRouter } from './routes/columns.js';
import { itemsRouter, projectItemsRouter } from './routes/items.js';
import { commentsRouter, itemCommentsRouter } from './routes/comments.js';
import { projectActivityRouter, itemActivityRouter } from './routes/activity.js';
import { onError } from './middleware/error.js';
import { createMcpRouter } from './routes/mcp.js';
import { createSseRouter } from './routes/sse.js';
import { createConversationsRouter } from './routes/conversations.js';
import { createSettingsRouter } from './routes/settings.js';
import { eventBus } from './events/bus.js';
import type { Services } from './types.js';

const DB_PATH = process.env.DB_PATH ?? './ldash.db';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// 1. Open database
const db = openDatabase(DB_PATH);

// 2. Run schema
runSchema(db);

// 2a. Run migrations
runMigrations(db);

// 3. Seed default columns
seedColumns(db);

// 4. Instantiate services
const projectService = new ProjectService(db);
const columnService = new ColumnService(db);
const itemService = new ItemService(db);
const commentService = new CommentService(db);
const activityService = new ActivityService(db);

// 4a. Instantiate settings service
const settingsService = new SettingsService(db);

// 4b. Instantiate conversation service
const conversationService = new ConversationService(db);

// 4c. Extend services object
const services: Services = {
  projects: projectService,
  items: itemService,
  columns: columnService,
  comments: commentService,
  activity: activityService,
  conversations: conversationService,
  settings: settingsService,
};

// 5. Create Hono app
const app = new Hono();

// 6. Register routes
app.route('/', createSseRouter(eventBus));
app.route('/api/columns', columnsRouter(columnService, activityService, eventBus));
app.route('/api/projects', projectsRouter(projectService, activityService, eventBus));
app.route('/api/items', itemsRouter(itemService, projectService, columnService, activityService, eventBus));

// Nested routes under /api/projects/:projectId
const projectNestedApp = new Hono();
projectNestedApp.route('/items', projectItemsRouter(itemService, projectService, activityService));
projectNestedApp.route('/activity', projectActivityRouter(activityService, projectService));
app.route('/api/projects/:projectId', projectNestedApp);

// Nested routes under /api/items/:itemId
const itemNestedApp = new Hono();
itemNestedApp.route('/comments', itemCommentsRouter(commentService, itemService));
itemNestedApp.route('/activity', itemActivityRouter(activityService, itemService));
app.route('/api/items/:itemId', itemNestedApp);

app.route('/api/comments', commentsRouter(commentService, itemService, activityService, eventBus));

// MCP server
app.route('/mcp', createMcpRouter(services, eventBus));

// Conversations and settings routes
app.route('/', createConversationsRouter(services, conversationService, settingsService));
app.route('/', createSettingsRouter(settingsService));

// 7. Register error middleware
app.onError(onError);

// 8. Start server
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT });

// 9. Log startup
console.log(`ldash listening on http://127.0.0.1:${PORT}`);
