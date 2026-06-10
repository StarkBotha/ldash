export type ItemType = 'epic' | 'story' | 'task';
export type ActorType = 'user' | 'claude';

export interface Column {
  id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: ItemType;
  title: string;
  description: string;
  column_id: string;
  position: number;
  flagged: boolean;
  blocked: boolean;
  blocked_reason: string;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  item_id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface ActivityEntry {
  id: string;
  item_id: string | null;
  project_id: string | null;
  actor_type: ActorType;
  actor_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export type ConversationType = 'item' | 'planning';

export interface Conversation {
  id: string;
  project_id: string;
  item_id: string | null;
  type: ConversationType;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: unknown[] | null;
  created_at: string;
}

export type ProviderType = 'claude-subscription' | 'openai-compatible';

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface GatewaySettings {
  providers: ProviderConfig[];
  activeProvider: string | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export type PlanningStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolName: string; label: string }
  | { type: 'tool_result'; toolName: string; success: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type BoardEventType =
  | 'item.created'
  | 'item.updated'
  | 'item.moved'
  | 'item.deleted'
  | 'item.flagged'
  | 'item.unflagged'
  | 'item.blocked'
  | 'item.unblocked'
  | 'comment.created'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'column.created'
  | 'column.updated'
  | 'column.reordered';

export interface BoardEvent {
  type: BoardEventType;
  projectId: string;
  entityId: string;
  data: Record<string, unknown>;
}
