import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Services } from '../../types.js';
import { eventBus as defaultBus } from '../../events/bus.js';
import type { EventBus } from '../../events/bus.js';
import { recomputeAncestors, recomputeAncestorsByParent } from '../../services/rollup.js';
import type Database from 'better-sqlite3';

export function registerItemTools(server: McpServer, services: Services, bus: EventBus = defaultBus, db?: Database.Database): void {
  // ldash_list_items
  server.tool(
    'ldash_list_items',
    'List items (epics, stories, tasks) on the board. Use this to find what work is planned and what its current status is. Filter by project_id (required), and optionally by status column name or id, item type, or parent item id. Returns id, title, type, column_id, flagged, blocked, and parent_id for each item.',
    {
      project_id: z.string().describe('The id of the project to list items from. Required.'),
      column_id: z.string().optional().describe('Filter to items in this column. Accepts either a column id or a column name (case-insensitive). Optional.'),
      type: z.enum(['epic', 'story', 'task']).optional().describe('Filter to items of this type. Optional.'),
      parent_id: z.string().optional().describe('Filter to items whose parent_id matches this value. Pass "null" as a string to get top-level items with no parent. Optional.'),
    },
    async (input) => {
      const project = services.projects.get(input.project_id);
      if (!project) {
        return { content: [{ type: 'text' as const, text: 'Error: project not found' }], isError: true };
      }

      let resolvedColumnId: string | undefined = input.column_id;

      if (input.column_id !== undefined) {
        // Try to find column by id first
        const colById = services.columns.get(input.column_id);
        if (!colById) {
          // Try by name (case-insensitive)
          const cols = services.columns.list();
          const colByName = cols.find(c => c.name.toLowerCase() === input.column_id!.toLowerCase());
          if (!colByName) {
            return { content: [{ type: 'text' as const, text: 'Error: column not found' }], isError: true };
          }
          resolvedColumnId = colByName.id;
        }
      }

      const items = services.items.listFiltered({
        project_id: input.project_id,
        column_id: resolvedColumnId,
        type: input.type,
        parent_id: input.parent_id,
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
    }
  );

  // ldash_get_item
  server.tool(
    'ldash_get_item',
    'Get full details of a single item including its description, current status, flag and block state, all comments, attachment metadata, and the 20 most recent activity entries. Use this before working on a task so you understand its current state and any prior discussion. Accepts either an item id or a ticket key like "DUN-12". Attachments are listed as metadata only (id, filename, mime, size) — use ldash_get_attachment with the attachment id to view an image.',
    {
      item_id: z.string().describe('The id of the item to retrieve, or its ticket key (e.g. "DUN-12").'),
    },
    async (input) => {
      const item = services.items.get(input.item_id) ?? services.items.getByKey(input.item_id);
      if (!item) {
        return { content: [{ type: 'text' as const, text: 'Error: item not found' }], isError: true };
      }

      const comments = services.comments.listByItem(item.id);
      const attachments = services.attachments.listForItem(item.id);
      const recent_activity = services.activity.listByItem(item.id, { limit: 20 });

      const assembled = { item, comments, attachments, recent_activity };
      return { content: [{ type: 'text' as const, text: JSON.stringify(assembled, null, 2) }] };
    }
  );

  // ldash_get_attachment
  server.tool(
    'ldash_get_attachment',
    'Fetch an attachment by id and return it as an image content block. Attachment ids and metadata appear in the "attachments" array of ldash_get_item. WARNING: images consume significant context — only fetch an attachment deliberately, when the image is relevant to the work at hand.',
    {
      attachment_id: z.string().describe('The id of the attachment to fetch, as listed in ldash_get_item\'s attachments array.'),
    },
    async (input) => {
      const attachment = services.attachments.get(input.attachment_id);
      if (!attachment) {
        return { content: [{ type: 'text' as const, text: 'Error: attachment not found' }], isError: true };
      }

      return {
        content: [
          { type: 'text' as const, text: `${attachment.filename} (${attachment.mime}, ${attachment.size_bytes} bytes)` },
          { type: 'image' as const, data: attachment.data.toString('base64'), mimeType: attachment.mime },
        ],
      };
    }
  );

  // ldash_search_items
  server.tool(
    'ldash_search_items',
    'Search items in a project by free text. Matches title, description, and ticket key (case-insensitive substring). Returns ONLY the matching ticket keys — use ldash_get_item with a key to read a ticket\'s full details.',
    {
      project_id: z.string().describe('The id of the project to search in. Required.'),
      query: z.string().min(1).describe('Text to search for. Required and must not be empty.'),
    },
    async (input) => {
      const project = services.projects.get(input.project_id);
      if (!project) {
        return { content: [{ type: 'text' as const, text: 'Error: project not found' }], isError: true };
      }

      const keys = services.items.search(input.project_id, input.query).map((i) => i.key);
      return { content: [{ type: 'text' as const, text: JSON.stringify(keys) }] };
    }
  );

  // ldash_create_item
  server.tool(
    'ldash_create_item',
    'Create a new item (epic, story, or task) on the board. Use this to file follow-up work discovered while completing a task — for example, a bug found while implementing a feature, or a refactor that should happen later. The item is created in the specified column (defaults to the first column if omitted).',
    {
      project_id: z.string().describe('The id of the project this item belongs to.'),
      type: z.enum(['epic', 'story', 'task']).describe('The item type. Use "task" for concrete work items, "story" for grouped work, "epic" for large themes.'),
      title: z.string().min(1).describe('Short title for the item. Required and must not be empty.'),
      description: z.string().optional().describe('Longer description of the work. Markdown is accepted. Optional.'),
      column_id: z.string().optional().describe('The id or name of the column to place the item in. Defaults to the first column (Backlog) if omitted.'),
      parent_id: z.string().optional().describe('The id of a parent item. Optional. Use to nest a task under a story, or a story under an epic.'),
    },
    async (input) => {
      const project = services.projects.get(input.project_id);
      if (!project) {
        return { content: [{ type: 'text' as const, text: 'Error: project not found' }], isError: true };
      }

      // Resolve column_id
      let resolvedColumnId: string;
      if (input.column_id === undefined) {
        const cols = services.columns.list();
        if (cols.length === 0) {
          return { content: [{ type: 'text' as const, text: 'Error: no columns available' }], isError: true };
        }
        resolvedColumnId = cols[0].id;
      } else {
        const colById = services.columns.get(input.column_id);
        if (colById) {
          resolvedColumnId = colById.id;
        } else {
          const cols = services.columns.list();
          const colByName = cols.find(c => c.name.toLowerCase() === input.column_id!.toLowerCase());
          if (!colByName) {
            return { content: [{ type: 'text' as const, text: 'Error: column not found' }], isError: true };
          }
          resolvedColumnId = colByName.id;
        }
      }

      // Validate parent_id if provided
      if (input.parent_id !== undefined) {
        const parent = services.items.get(input.parent_id);
        if (!parent || parent.project_id !== input.project_id) {
          return { content: [{ type: 'text' as const, text: 'Error: parent item not found or belongs to a different project' }], isError: true };
        }
      }

      const item = services.items.create({
        project_id: input.project_id,
        parent_id: input.parent_id ?? null,
        type: input.type,
        title: input.title,
        description: input.description,
        column_id: resolvedColumnId,
      });

      services.activity.append({
        item_id: item.id,
        project_id: input.project_id,
        actor_type: 'claude',
        actor_id: 'claude-code',
        event_type: 'item.created',
        payload: { title: item.title, type: item.type, column_id: item.column_id },
      });

      bus.emit({
        type: 'item.created',
        projectId: item.project_id,
        entityId: item.id,
        data: { item },
      });

      // Rollup: after a task is created, recompute ancestor story/epic status
      if (item.type === 'task' && db) {
        recomputeAncestors(item.id, db, services.items, services.activity, services.columns, bus);
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }] };
    }
  );

  // ldash_update_item_fields
  server.tool(
    'ldash_update_item_fields',
    'Update the title and/or description of an item. Use this to correct a title, add detail to a description, or clarify scope after investigation. Does not change status — use ldash_update_item_status for that.',
    {
      item_id: z.string().describe('The id of the item to update.'),
      title: z.string().min(1).optional().describe('New title. Optional — omit to leave unchanged.'),
      description: z.string().optional().describe('New description. Optional — omit to leave unchanged. Pass an empty string to clear the description.'),
    },
    async (input) => {
      const oldItem = services.items.get(input.item_id);
      if (!oldItem) {
        return { content: [{ type: 'text' as const, text: 'Error: item not found' }], isError: true };
      }

      if (input.title === undefined && input.description === undefined) {
        return { content: [{ type: 'text' as const, text: 'Error: provide at least one field to update' }], isError: true };
      }

      const updatedItem = services.items.update(input.item_id, {
        title: input.title,
        description: input.description,
      });

      // Build fields payload showing what changed
      const fields: Record<string, { old: unknown; new: unknown }> = {};
      if (input.title !== undefined && input.title !== oldItem.title) {
        fields['title'] = { old: oldItem.title, new: input.title };
      }
      if (input.description !== undefined && input.description !== oldItem.description) {
        fields['description'] = { old: oldItem.description, new: input.description };
      }

      services.activity.append({
        item_id: input.item_id,
        project_id: oldItem.project_id,
        actor_type: 'claude',
        actor_id: 'claude-code',
        event_type: 'item.updated',
        payload: { fields },
      });

      bus.emit({
        type: 'item.updated',
        projectId: oldItem.project_id,
        entityId: input.item_id,
        data: { item: updatedItem },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(updatedItem, null, 2) }] };
    }
  );

  // ldash_update_item_status
  server.tool(
    'ldash_update_item_status',
    'Move a TASK to a different status column. Use this to advance a task through the board — for example, moving a task from "In Progress" to "Review" after completing the implementation. Accepts either a column id or a column name. Stories and epics derive their status automatically from their tasks — do not call this tool on them.',
    {
      item_id: z.string().describe('The id of the item to move.'),
      column_id: z.string().describe('The target column. Accepts either a column id or a column name (case-insensitive match). Examples: "Done", "In Progress", or the raw id.'),
    },
    async (input) => {
      const oldItem = services.items.get(input.item_id);
      if (!oldItem) {
        return { content: [{ type: 'text' as const, text: 'Error: item not found' }], isError: true };
      }

      // Resolve column
      const cols = services.columns.list();
      let resolvedColumn = services.columns.get(input.column_id);
      if (!resolvedColumn) {
        resolvedColumn = cols.find(c => c.name.toLowerCase() === input.column_id.toLowerCase());
      }
      if (!resolvedColumn) {
        const names = cols.map(c => c.name).join(', ');
        return { content: [{ type: 'text' as const, text: `Error: column not found. Available columns: ${names}` }], isError: true };
      }

      let movedItem;
      try {
        movedItem = services.items.move(input.item_id, { column_id: resolvedColumn.id });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Status of a ')) {
          return { content: [{ type: 'text' as const, text: 'Error: ' + err.message }], isError: true };
        }
        throw err;
      }

      const fromColumn = cols.find(c => c.id === oldItem.column_id);
      const fromColumnName = fromColumn?.name ?? oldItem.column_id;
      const toColumnName = resolvedColumn.name;

      services.activity.append({
        item_id: input.item_id,
        project_id: oldItem.project_id,
        actor_type: 'claude',
        actor_id: 'claude-code',
        event_type: 'item.moved',
        payload: {
          from_column_id: oldItem.column_id,
          to_column_id: resolvedColumn.id,
          from_column_name: fromColumnName,
          to_column_name: toColumnName,
        },
      });

      bus.emit({
        type: 'item.moved',
        projectId: oldItem.project_id,
        entityId: input.item_id,
        data: { item: movedItem, fromColumnId: oldItem.column_id, toColumnId: resolvedColumn.id },
      });

      // Rollup: after a successful task move, recompute ancestor story/epic status
      if (oldItem.type === 'task' && db) {
        recomputeAncestors(input.item_id, db, services.items, services.activity, services.columns, bus);
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(movedItem, null, 2) }] };
    }
  );
}
