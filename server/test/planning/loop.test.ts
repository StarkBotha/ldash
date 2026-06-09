import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runSchema } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrationRunner.js';
import { seedColumns } from '../../src/db/seed.js';
import { ProjectService } from '../../src/services/projects.js';
import { ColumnService } from '../../src/services/columns.js';
import { ItemService } from '../../src/services/items.js';
import { CommentService } from '../../src/services/comments.js';
import { ActivityService } from '../../src/services/activity.js';
import { ConversationService } from '../../src/services/conversations.js';
import { SettingsService } from '../../src/services/settings.js';
import { EventBus } from '../../src/events/bus.js';
import { getPlanningToolDefinitions, createPlanningToolHandler } from '../../src/planning/tools.js';
import { runToolLoop } from '../../src/gateway/loop.js';
import type { ChatAdapter, GatewayChunk } from '../../src/gateway/types.js';
import type { Services } from '../../src/types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);
  return db;
}

function createServices(db: Database.Database): Services {
  return {
    projects: new ProjectService(db),
    items: new ItemService(db),
    columns: new ColumnService(db),
    comments: new CommentService(db),
    activity: new ActivityService(db),
    conversations: new ConversationService(db),
    settings: new SettingsService(db),
  };
}

function mockAdapter(chunks: GatewayChunk[]): ChatAdapter {
  return {
    streamChat: async function* () {},
    callWithTools: async function* () {
      yield* chunks;
    },
  };
}

describe('runToolLoop', () => {
  it('text-only response emits text chunks and returns history', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, project.id, bus);

    const chunks: GatewayChunk[] = [
      { type: 'text', text: 'Hello' },
      { type: 'done' },
    ];

    const adapter = mockAdapter(chunks);
    const textSink = vi.fn();
    const toolCallSink = vi.fn();

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'Hi' }],
      tools,
      toolHandler,
      textSink,
      toolCallSink
    );

    expect(textSink).toHaveBeenCalledOnce();
    expect(textSink).toHaveBeenCalledWith('Hello');
    // For text-only turns, no assistant message is appended to history (spec: break when pendingCalls is empty)
    // The history contains only the initial messages.
    expect(history[0]).toMatchObject({ role: 'user', content: 'Hi' });
    expect(toolCallSink).not.toHaveBeenCalled();
  });

  it('create_item tool call creates an item in the database', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, project.id, bus);

    let callCount = 0;
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'tool_call' as const,
            id: '1',
            name: 'create_item',
            args: JSON.stringify({ type: 'task', title: 'Test task', column_id: backlogCol.id }),
          };
          yield { type: 'done' as const };
        } else {
          yield { type: 'text' as const, text: 'Done' };
          yield { type: 'done' as const };
        }
      },
    };

    const textSink = vi.fn();
    const toolCallSink = vi.fn();

    await runToolLoop(
      adapter,
      [{ role: 'user', content: 'Create a task' }],
      tools,
      toolHandler,
      textSink,
      toolCallSink
    );

    const items = services.items.listByProject(project.id);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Test task');
  });

  it('update_item tool call updates an existing item', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    const existingItem = services.items.create({
      project_id: project.id,
      type: 'task',
      title: 'Old title',
      column_id: backlogCol.id,
    });

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, project.id, bus);

    let callCount = 0;
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'tool_call' as const,
            id: '1',
            name: 'update_item',
            args: JSON.stringify({ item_id: existingItem.id, title: 'New title' }),
          };
          yield { type: 'done' as const };
        } else {
          yield { type: 'text' as const, text: 'Updated' };
          yield { type: 'done' as const };
        }
      },
    };

    await runToolLoop(
      adapter,
      [{ role: 'user', content: 'Update item' }],
      tools,
      toolHandler,
      vi.fn(),
      vi.fn()
    );

    const updated = services.items.get(existingItem.id);
    expect(updated?.title).toBe('New title');
  });

  it('list_items tool call returns existing items', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    const item1 = services.items.create({
      project_id: project.id,
      type: 'epic',
      title: 'Epic 1',
      column_id: backlogCol.id,
    });
    const item2 = services.items.create({
      project_id: project.id,
      type: 'story',
      title: 'Story 1',
      column_id: backlogCol.id,
    });

    const tools = getPlanningToolDefinitions();

    let capturedResult: string | null = null;
    const toolHandlerWithCapture = async (name: string, args: Record<string, unknown>) => {
      const baseHandler = createPlanningToolHandler(services, project.id, bus);
      const result = await baseHandler(name, args);
      if (name === 'list_items') capturedResult = result;
      return result;
    };

    let callCount = 0;
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_call' as const, id: '1', name: 'list_items', args: '{}' };
          yield { type: 'done' as const };
        } else {
          yield { type: 'text' as const, text: 'Listed' };
          yield { type: 'done' as const };
        }
      },
    };

    await runToolLoop(
      adapter,
      [{ role: 'user', content: 'List items' }],
      tools,
      toolHandlerWithCapture,
      vi.fn(),
      vi.fn()
    );

    expect(capturedResult).not.toBeNull();
    expect(capturedResult).toContain(item1.id);
    expect(capturedResult).toContain(item2.id);
  });

  it('unknown tool returns error string without throwing', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, project.id, bus);

    let callCount = 0;
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_call' as const, id: '1', name: 'nonexistent_tool', args: '{}' };
          yield { type: 'done' as const };
        } else {
          yield { type: 'text' as const, text: 'Done' };
          yield { type: 'done' as const };
        }
      },
    };

    let loopThrew = false;
    let finalHistory;
    try {
      finalHistory = await runToolLoop(
        adapter,
        [{ role: 'user', content: 'Call unknown' }],
        tools,
        toolHandler,
        vi.fn(),
        vi.fn()
      );
    } catch {
      loopThrew = true;
    }

    expect(loopThrew).toBe(false);
    // Tool result message should contain the error string
    const toolResultMsg = finalHistory?.find((m) => m.role === 'tool');
    expect(toolResultMsg?.content).toContain('Error: unknown tool');
  });

  it('error chunk terminates the loop and throws', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, project.id, bus);

    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        yield { type: 'error' as const, message: 'provider failure' };
      },
    };

    await expect(
      runToolLoop(
        adapter,
        [{ role: 'user', content: 'test' }],
        tools,
        toolHandler,
        vi.fn(),
        vi.fn()
      )
    ).rejects.toThrow('provider failure');
  });

  it('maxTurns exceeded appends safety message', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, project.id, bus);

    // Adapter always yields tool_call then done — never terminates naturally
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        yield {
          type: 'tool_call' as const,
          id: '1',
          name: 'create_item',
          args: JSON.stringify({ type: 'task', title: `Task ${Date.now()}`, column_id: backlogCol.id }),
        };
        yield { type: 'done' as const };
      },
    };

    const finalHistory = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'test' }],
      tools,
      toolHandler,
      vi.fn(),
      vi.fn(),
      { maxTurns: 3 }
    );

    const lastMsg = finalHistory[finalHistory.length - 1];
    expect(lastMsg.content).toContain('maximum turns');
  });

  it('activity entry is written with actor_type llm', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, project.id, bus);

    let callCount = 0;
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'tool_call' as const,
            id: '1',
            name: 'create_item',
            args: JSON.stringify({ type: 'task', title: 'Activity test task', column_id: backlogCol.id }),
          };
          yield { type: 'done' as const };
        } else {
          yield { type: 'text' as const, text: 'Done' };
          yield { type: 'done' as const };
        }
      },
    };

    await runToolLoop(
      adapter,
      [{ role: 'user', content: 'create' }],
      tools,
      toolHandler,
      vi.fn(),
      vi.fn()
    );

    const items = services.items.listByProject(project.id);
    expect(items).toHaveLength(1);
    const createdItemId = items[0].id;

    const activityEntries = services.activity.listByItem(createdItemId, { limit: 1 });
    expect(activityEntries).toHaveLength(1);
    expect(activityEntries[0].actor_type).toBe('llm');
    expect(activityEntries[0].actor_id).toBe('planning-llm');
  });

  it('eventBus emits item.created on create_item tool call', async () => {
    const db = createTestDb();
    const services = createServices(db);
    const bus = new EventBus();
    const project = services.projects.create({ name: 'Test', description: '' });
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, project.id, bus);

    const emittedEvents: unknown[] = [];
    bus.subscribe((event) => {
      emittedEvents.push(event);
    });

    let callCount = 0;
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'tool_call' as const,
            id: '1',
            name: 'create_item',
            args: JSON.stringify({ type: 'task', title: 'Bus test task', column_id: backlogCol.id }),
          };
          yield { type: 'done' as const };
        } else {
          yield { type: 'text' as const, text: 'Done' };
          yield { type: 'done' as const };
        }
      },
    };

    await runToolLoop(
      adapter,
      [{ role: 'user', content: 'create' }],
      tools,
      toolHandler,
      vi.fn(),
      vi.fn()
    );

    expect(emittedEvents).toHaveLength(1);
    expect((emittedEvents[0] as { type: string }).type).toBe('item.created');
  });
});
