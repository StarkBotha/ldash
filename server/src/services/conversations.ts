import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Conversation, Message } from '../types.js';
import type { ToolCallRequest } from '../gateway/types.js';

interface ConversationRow {
  id: string;
  project_id: string;
  item_id: string | null;
  type: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    project_id: row.project_id,
    item_id: row.item_id,
    type: row.type as 'item' | 'planning' | 'kb',
    created_at: row.created_at,
  };
}

function rowToMessage(row: MessageRow): Message {
  let tool_calls: ToolCallRequest[] | null = null;
  if (row.tool_calls) {
    try {
      tool_calls = JSON.parse(row.tool_calls) as ToolCallRequest[];
    } catch {
      tool_calls = null;
    }
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role as 'user' | 'assistant' | 'tool',
    content: row.content,
    tool_calls,
    created_at: row.created_at,
  };
}

export class ConversationService {
  constructor(private db: Database.Database) {}

  getOrCreateItemConversation(projectId: string, itemId: string): Conversation {
    const existing = this.db
      .prepare('SELECT * FROM conversations WHERE item_id = ? AND type = ?')
      .get(itemId, 'item') as ConversationRow | undefined;

    if (existing) {
      return rowToConversation(existing);
    }

    const id = nanoid();
    this.db
      .prepare('INSERT INTO conversations (id, project_id, item_id, type) VALUES (?, ?, ?, ?)')
      .run(id, projectId, itemId, 'item');

    return rowToConversation(
      this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow
    );
  }

  getOrCreatePlanningConversation(projectId: string): Conversation {
    const existing = this.db
      .prepare('SELECT * FROM conversations WHERE project_id = ? AND item_id IS NULL AND type = ?')
      .get(projectId, 'planning') as ConversationRow | undefined;

    if (existing) {
      return rowToConversation(existing);
    }

    const id = nanoid();
    this.db
      .prepare('INSERT INTO conversations (id, project_id, item_id, type) VALUES (?, ?, NULL, ?)')
      .run(id, projectId, 'planning');

    return rowToConversation(
      this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow
    );
  }

  getOrCreateKbConversation(projectId: string): Conversation {
    const existing = this.db
      .prepare('SELECT * FROM conversations WHERE project_id = ? AND item_id IS NULL AND type = ?')
      .get(projectId, 'kb') as ConversationRow | undefined;

    if (existing) {
      return rowToConversation(existing);
    }

    const id = nanoid();
    this.db
      .prepare('INSERT INTO conversations (id, project_id, item_id, type) VALUES (?, ?, NULL, ?)')
      .run(id, projectId, 'kb');

    return rowToConversation(
      this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow
    );
  }

  getConversation(conversationId: string): Conversation | undefined {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as ConversationRow | undefined;
    return row ? rowToConversation(row) : undefined;
  }

  getMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  appendMessage(
    conversationId: string,
    data: {
      role: 'user' | 'assistant' | 'tool';
      content: string;
      tool_calls?: ToolCallRequest[] | null;
    }
  ): Message {
    const id = nanoid();
    const toolCallsJson = data.tool_calls ? JSON.stringify(data.tool_calls) : null;
    this.db
      .prepare('INSERT INTO messages (id, conversation_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)')
      .run(id, conversationId, data.role, data.content, toolCallsJson);

    return rowToMessage(
      this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
    );
  }

  clearMessages(conversationId: string): void {
    this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
  }
}
