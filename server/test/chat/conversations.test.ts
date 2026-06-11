import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runSchema } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrationRunner.js';
import { seedColumns } from '../../src/db/seed.js';
import { ProjectService } from '../../src/services/projects.js';
import { ColumnService } from '../../src/services/columns.js';
import { ItemService } from '../../src/services/items.js';
import { ConversationService } from '../../src/services/conversations.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);
  return db;
}

describe('ConversationService', () => {
  let conversations: ConversationService;
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    const db = createTestDb();
    const projects = new ProjectService(db);
    const columns = new ColumnService(db);
    const items = new ItemService(db);
    conversations = new ConversationService(db);

    const project = projects.create({ name: 'Test Project' });
    projectId = project.id;

    const cols = columns.list();
    const item = items.create({
      project_id: projectId,
      type: 'task',
      title: 'Test Item',
      column_id: cols[0].id,
    });
    itemId = item.id;
  });

  it('getOrCreateItemConversation creates a new conversation when none exists', () => {
    const convo = conversations.getOrCreateItemConversation(projectId, itemId);

    expect(convo.type).toBe('item');
    expect(convo.item_id).toBe(itemId);
    expect(convo.project_id).toBe(projectId);
    expect(typeof convo.id).toBe('string');
  });

  it('getOrCreateItemConversation returns the same conversation on repeated calls', () => {
    const first = conversations.getOrCreateItemConversation(projectId, itemId);
    const second = conversations.getOrCreateItemConversation(projectId, itemId);

    expect(first.id).toBe(second.id);
  });

  it('getOrCreatePlanningConversation creates a planning conversation with null item_id', () => {
    const convo = conversations.getOrCreatePlanningConversation(projectId);

    expect(convo.type).toBe('planning');
    expect(convo.item_id).toBeNull();
    expect(convo.project_id).toBe(projectId);
  });

  it('appendMessage persists a user message', () => {
    const convo = conversations.getOrCreateItemConversation(projectId, itemId);
    conversations.appendMessage(convo.id, { role: 'user', content: 'Hello there' });

    const messages = conversations.getMessages(convo.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello there');
  });

  it('appendMessage persists tool_calls as JSON', () => {
    const convo = conversations.getOrCreateItemConversation(projectId, itemId);
    conversations.appendMessage(convo.id, {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'test', arguments: '{}' }],
    });

    const messages = conversations.getMessages(convo.id);
    expect(messages[0].tool_calls).not.toBeNull();
    expect(messages[0].tool_calls![0].id).toBe('c1');
  });

  it('getMessages returns messages in created_at ASC order', () => {
    const convo = conversations.getOrCreateItemConversation(projectId, itemId);
    conversations.appendMessage(convo.id, { role: 'user', content: 'First' });
    conversations.appendMessage(convo.id, { role: 'assistant', content: 'Second' });
    conversations.appendMessage(convo.id, { role: 'user', content: 'Third' });

    const messages = conversations.getMessages(convo.id);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('First');
    expect(messages[1].content).toBe('Second');
    expect(messages[2].content).toBe('Third');
  });

  it('clearMessages removes all messages but not the conversation', () => {
    const convo = conversations.getOrCreateItemConversation(projectId, itemId);
    conversations.appendMessage(convo.id, { role: 'user', content: 'msg 1' });
    conversations.appendMessage(convo.id, { role: 'assistant', content: 'msg 2' });

    conversations.clearMessages(convo.id);

    const messages = conversations.getMessages(convo.id);
    expect(messages).toHaveLength(0);

    const stillExists = conversations.getConversation(convo.id);
    expect(stillExists).toBeDefined();
    expect(stillExists?.id).toBe(convo.id);
  });

  it('two items in the same project each get their own conversation', () => {
    const db2 = createTestDb();
    const projects2 = new ProjectService(db2);
    const columns2 = new ColumnService(db2);
    const items2 = new ItemService(db2);
    const convos2 = new ConversationService(db2);

    const proj = projects2.create({ name: 'Proj' });
    const cols = columns2.list();
    const item1 = items2.create({ project_id: proj.id, type: 'task', title: 'Item 1', column_id: cols[0].id });
    const item2 = items2.create({ project_id: proj.id, type: 'task', title: 'Item 2', column_id: cols[0].id });

    const convo1 = convos2.getOrCreateItemConversation(proj.id, item1.id);
    const convo2 = convos2.getOrCreateItemConversation(proj.id, item2.id);

    expect(convo1.id).not.toBe(convo2.id);
  });
});
