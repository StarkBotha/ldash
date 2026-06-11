export type ItemType = 'epic' | 'story' | 'task' | 'bug' | 'investigation';

/** Leaf work item types: directly movable between columns, and the inputs to
 *  story/epic status rollup. Stories and epics are aggregates with derived status. */
export const WORK_ITEM_TYPES = ['task', 'bug', 'investigation'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export function isWorkItemType(type: string): type is WorkItemType {
  return (WORK_ITEM_TYPES as readonly string[]).includes(type);
}

export const ITEM_TYPES = ['epic', 'story', 'task', 'bug', 'investigation'] as const;
export type ActorType = 'user' | 'claude' | 'llm' | 'system';

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

export interface Attachment {
  id: string;
  item_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
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

// Event type constants
export const EventTypes = {
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_DELETED: 'project.deleted',
  ITEM_CREATED: 'item.created',
  ITEM_UPDATED: 'item.updated',
  ITEM_MOVED: 'item.moved',
  ITEM_DELETED: 'item.deleted',
  ITEM_FLAGGED: 'item.flagged',
  ITEM_UNFLAGGED: 'item.unflagged',
  ITEM_BLOCKED: 'item.blocked',
  ITEM_UNBLOCKED: 'item.unblocked',
  COMMENT_CREATED: 'comment.created',
  ATTACHMENT_CREATED: 'attachment.created',
  ATTACHMENT_DELETED: 'attachment.deleted',
  COLUMN_CREATED: 'column.created',
  COLUMN_UPDATED: 'column.updated',
  COLUMN_REORDERED: 'column.reordered',
} as const;

export type EventType = typeof EventTypes[keyof typeof EventTypes];

// Re-export ToolCallRequest from gateway types so callers don't need to import from gateway module
export type { ToolCallRequest } from './gateway/types.js';

export type ConversationType = 'item' | 'planning';

export interface Conversation {
  id: string;
  project_id: string;
  item_id: string | null;
  type: ConversationType;
  created_at: string;
}

import type { ToolCallRequest } from './gateway/types.js';

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: ToolCallRequest[] | null;
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

// Services bundle used by the MCP server
import type { ProjectService } from './services/projects.js';
import type { ItemService } from './services/items.js';
import type { ColumnService } from './services/columns.js';
import type { CommentService } from './services/comments.js';
import type { AttachmentService } from './services/attachments.js';
import type { ActivityService } from './services/activity.js';
import type { ConversationService } from './services/conversations.js';
import type { SettingsService } from './services/settings.js';

export interface Services {
  projects: ProjectService;
  items: ItemService;
  columns: ColumnService;
  comments: CommentService;
  attachments: AttachmentService;
  activity: ActivityService;
  conversations: ConversationService;
  settings: SettingsService;
}
