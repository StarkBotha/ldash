import type { Item, Comment, Column, Project } from '../types.js';

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
  projectId: string;   // always present; for project-level events this is the project's own id
  entityId: string;    // id of the primary entity (item id, comment id, project id, column id)
  data: Record<string, unknown>; // the changed record or minimal delta
}

// Re-export for convenience
export type { Item, Comment, Column, Project };
