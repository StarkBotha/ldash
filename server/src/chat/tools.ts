import type Database from 'better-sqlite3';
import type { ToolDefinition } from '../gateway/types.js';
import type { ToolHandler } from '../gateway/loop.js';
import { isWorkItemType, type Services } from '../types.js';
import type { EventBus } from '../events/bus.js';
import { getPlanningToolDefinitions, createPlanningToolHandler } from '../planning/tools.js';
import { recomputeAncestors } from '../services/rollup.js';

const CHAT_ACTOR_ID = 'chat-llm';

// Item chat gets the planning toolset (create/update/list) plus tools for
// acting on individual tickets: moving tasks, commenting, and reading details.
export function getItemChatToolDefinitions(): ToolDefinition[] {
  return [
    ...getPlanningToolDefinitions(),
    {
      name: 'move_task',
      description:
        'Move a TASK, BUG, or INVESTIGATION to a different status column. Only these leaf work items can be moved — story and epic status is derived from their child work items automatically, so never call this on them. Use when the user asks to start, finish, or reprioritize a work item.',
      parameters: {
        type: 'object',
        required: ['item_id', 'column_id'],
        properties: {
          item_id: {
            type: 'string',
            description: 'The id of the task/bug/investigation to move, or its ticket key (e.g. "DUN-12").',
          },
          column_id: {
            type: 'string',
            description: 'The target column. Accepts a column id or a column name (case-insensitive), e.g. "Done" or "In Progress".',
          },
        },
      },
    },
    {
      name: 'add_comment',
      description:
        'Post a comment on an item. Use this to record decisions, summaries, or follow-up notes from this conversation so they are visible on the ticket. Markdown is accepted.',
      parameters: {
        type: 'object',
        required: ['item_id', 'body'],
        properties: {
          item_id: {
            type: 'string',
            description: 'The id of the item to comment on, or its ticket key (e.g. "DUN-12").',
          },
          body: {
            type: 'string',
            description: 'The comment text. Must not be empty.',
          },
        },
      },
    },
    {
      name: 'get_item',
      description:
        'Get full details of an item including its description, current column, flags, and all comments. Use this before discussing or modifying a ticket other than the one this chat is attached to.',
      parameters: {
        type: 'object',
        required: ['item_id'],
        properties: {
          item_id: {
            type: 'string',
            description: 'The id of the item, or its ticket key (e.g. "DUN-12").',
          },
        },
      },
    },
  ];
}

export function createItemChatToolHandler(
  services: Services,
  projectId: string,
  bus: EventBus,
  db?: Database.Database
): ToolHandler {
  const planningHandler = createPlanningToolHandler(services, projectId, bus, db);

  // Resolve by id first, then by ticket key; must belong to this project
  function resolveItem(ref: unknown) {
    if (typeof ref !== 'string' || ref.trim() === '') return undefined;
    const item = services.items.get(ref) ?? services.items.getByKey(ref);
    if (!item || item.project_id !== projectId) return undefined;
    return item;
  }

  return async function toolHandler(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'move_task') {
      const item = resolveItem(args['item_id']);
      if (!item) {
        return 'Error: item not found in this project';
      }

      const cols = services.columns.list();
      const colArg = args['column_id'];
      if (typeof colArg !== 'string') {
        return 'Error: column_id is required';
      }
      let resolvedColumn = services.columns.get(colArg);
      if (!resolvedColumn) {
        resolvedColumn = cols.find((c) => c.name.toLowerCase() === colArg.toLowerCase());
      }
      if (!resolvedColumn) {
        return 'Error: column not found. Available columns: ' + cols.map((c) => c.name).join(', ');
      }

      let movedItem;
      try {
        movedItem = services.items.move(item.id, { column_id: resolvedColumn.id });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Status of a ')) {
          return 'Error: ' + err.message;
        }
        throw err;
      }

      services.activity.append({
        item_id: item.id,
        project_id: projectId,
        actor_type: 'llm',
        actor_id: CHAT_ACTOR_ID,
        event_type: 'item.moved',
        payload: {
          from_column_id: item.column_id,
          to_column_id: resolvedColumn.id,
          from_column_name: cols.find((c) => c.id === item.column_id)?.name ?? item.column_id,
          to_column_name: resolvedColumn.name,
        },
      });

      bus.emit({
        type: 'item.moved',
        projectId,
        entityId: item.id,
        data: { item: movedItem, fromColumnId: item.column_id, toColumnId: resolvedColumn.id },
      });

      if (isWorkItemType(item.type) && db) {
        recomputeAncestors(item.id, db, services.items, services.activity, services.columns, bus);
      }

      return JSON.stringify({ success: true, item: movedItem });
    }

    if (name === 'add_comment') {
      const item = resolveItem(args['item_id']);
      if (!item) {
        return 'Error: item not found in this project';
      }
      const body = args['body'];
      if (typeof body !== 'string' || body.trim() === '') {
        return 'Error: body is required';
      }

      const comment = services.comments.create({
        item_id: item.id,
        body,
        author: CHAT_ACTOR_ID,
      });

      services.activity.append({
        item_id: item.id,
        project_id: projectId,
        actor_type: 'llm',
        actor_id: CHAT_ACTOR_ID,
        event_type: 'comment.created',
        payload: { comment_id: comment.id, author: CHAT_ACTOR_ID },
      });

      bus.emit({
        type: 'comment.created',
        projectId,
        entityId: comment.id,
        data: { comment },
      });

      return JSON.stringify({ success: true, comment });
    }

    if (name === 'get_item') {
      const item = resolveItem(args['item_id']);
      if (!item) {
        return 'Error: item not found in this project';
      }
      const comments = services.comments.listByItem(item.id);
      return JSON.stringify({ item, comments });
    }

    return planningHandler(name, args);
  };
}
