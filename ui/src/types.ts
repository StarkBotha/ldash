export type ItemType = 'epic' | 'story' | 'task' | 'bug' | 'investigation';

/** Leaf work item types: directly movable between columns; stories/epics have
 *  derived status. Mirrors the server-side helper in server/src/types.ts. */
export const WORK_ITEM_TYPES = ['task', 'bug', 'investigation'] as const;

export function isWorkItemType(type: string): type is (typeof WORK_ITEM_TYPES)[number] {
  return (WORK_ITEM_TYPES as readonly string[]).includes(type);
}
export type ActorType = 'user' | 'claude';

export interface Column {
  id: string;
  name: string;
  position: number;
  /** 'cancelled' marks the Cancelled column; null = ordinary column. */
  role: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  prefix: string;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: ItemType;
  number: number;
  key: string;
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

export interface Attachment {
  id: string;
  item_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
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

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: ToolCall[] | null;
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
  | { type: 'tool_call'; toolName: string }
  | { type: 'tool_result'; toolName: string; success: boolean }
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
  | 'attachment.created'
  | 'attachment.deleted'
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
