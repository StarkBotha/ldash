import type { ToolDefinition } from '../gateway/types.js';
import type { ToolHandler } from '../gateway/loop.js';
import type { Services, ItemType } from '../types.js';
import type { EventBus } from '../events/bus.js';

export function getPlanningToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'create_item',
      description:
        'Create a new item (epic, story, or task) on the project board. Call this when the user has agreed to add a piece of work. Epics represent large themes (weeks of work), stories represent a coherent user-facing feature or component (days), tasks represent a single concrete unit of work (hours). Always place epics in the Backlog column unless the user specifies otherwise.',
      parameters: {
        type: 'object',
        required: ['type', 'title', 'column_id'],
        properties: {
          type: {
            type: 'string',
            enum: ['epic', 'story', 'task'],
            description: 'The item type.',
          },
          title: {
            type: 'string',
            description:
              'Short, action-oriented title. For tasks start with a verb (e.g. "Implement login endpoint").',
          },
          description: {
            type: 'string',
            description:
              'Longer description of the work. Optional. Use to capture acceptance criteria or technical notes.',
          },
          column_id: {
            type: 'string',
            description:
              'The id of the column to place this item in. Use the column id from the project context, not the name.',
          },
          parent_id: {
            type: 'string',
            description:
              'The id of the parent item. Required for stories (parent must be an epic) and tasks (parent must be a story or epic). Omit for top-level epics.',
          },
        },
      },
    },
    {
      name: 'update_item',
      description:
        'Update the title or description of an existing item. Use this to refine an item you just created, or to improve a pre-existing item based on the planning conversation.',
      parameters: {
        type: 'object',
        required: ['item_id'],
        properties: {
          item_id: {
            type: 'string',
            description: 'The id of the item to update.',
          },
          title: {
            type: 'string',
            description: 'New title. Omit to leave unchanged.',
          },
          description: {
            type: 'string',
            description: 'New description. Omit to leave unchanged.',
          },
        },
      },
    },
    {
      name: 'list_items',
      description:
        'List the current items on the board for this project. Use this to check what already exists before creating duplicates, or to find the id of an item you want to update or set as a parent.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['epic', 'story', 'task'],
            description: 'Filter by item type. Omit to list all types.',
          },
        },
      },
    },
  ];
}

export function createPlanningToolHandler(
  services: Services,
  projectId: string,
  bus: EventBus
): ToolHandler {
  return async function toolHandler(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'create_item') {
      // Validate type
      const type = args['type'];
      if (type !== 'epic' && type !== 'story' && type !== 'task') {
        return 'Error: type must be epic, story, or task';
      }

      // Validate title
      const title = args['title'];
      if (typeof title !== 'string' || title.trim() === '') {
        return 'Error: title is required';
      }

      // Validate column_id
      const columnIdArg = args['column_id'];
      if (typeof columnIdArg !== 'string') {
        return 'Error: column_id is required';
      }

      // Verify column exists
      let resolvedColumnId = columnIdArg;
      let column = services.columns.get(columnIdArg);
      if (!column) {
        // Try case-insensitive name match
        const allColumns = services.columns.list();
        const matched = allColumns.find(
          (c) => c.name.toLowerCase() === columnIdArg.toLowerCase()
        );
        if (!matched) {
          return 'Error: column not found';
        }
        resolvedColumnId = matched.id;
        column = matched;
      }

      // Validate parent_id if provided
      const parentId = args['parent_id'];
      if (parentId !== undefined && parentId !== null) {
        if (typeof parentId !== 'string') {
          return 'Error: parent_id must be a string';
        }
        const parentItem = services.items.get(parentId);
        if (!parentItem || parentItem.project_id !== projectId) {
          return 'Error: parent item not found in this project';
        }
      }

      const item = services.items.create({
        project_id: projectId,
        type: type as ItemType,
        title: title as string,
        description: typeof args['description'] === 'string' ? args['description'] : '',
        column_id: resolvedColumnId,
        parent_id: typeof parentId === 'string' ? parentId : null,
      });

      services.activity.append({
        item_id: item.id,
        project_id: projectId,
        actor_type: 'llm',
        actor_id: 'planning-llm',
        event_type: 'item.created',
        payload: { title: item.title, type: item.type, column_id: item.column_id },
      });

      bus.emit({
        type: 'item.created',
        projectId,
        entityId: item.id,
        data: { item },
      });

      return JSON.stringify({ success: true, item });
    }

    if (name === 'update_item') {
      const itemId = args['item_id'];
      if (typeof itemId !== 'string' || itemId.trim() === '') {
        return 'Error: item_id is required';
      }

      const existingItem = services.items.get(itemId);
      if (!existingItem || existingItem.project_id !== projectId) {
        return 'Error: item not found in this project';
      }

      const newTitle = args['title'];
      const newDescription = args['description'];

      if (newTitle === undefined && newDescription === undefined) {
        return 'Error: provide title or description to update';
      }

      const updateData: Partial<{ title: string; description: string }> = {};
      const fields: Record<string, unknown> = {};

      if (typeof newTitle === 'string') {
        updateData.title = newTitle;
        fields['title'] = { from: existingItem.title, to: newTitle };
      }
      if (typeof newDescription === 'string') {
        updateData.description = newDescription;
        fields['description'] = { from: existingItem.description, to: newDescription };
      }

      const updatedItem = services.items.update(itemId, updateData);

      services.activity.append({
        item_id: itemId,
        project_id: projectId,
        actor_type: 'llm',
        actor_id: 'planning-llm',
        event_type: 'item.updated',
        payload: { fields },
      });

      bus.emit({
        type: 'item.updated',
        projectId,
        entityId: updatedItem.id,
        data: { item: updatedItem },
      });

      return JSON.stringify({ success: true, item: updatedItem });
    }

    if (name === 'list_items') {
      const typeFilter = args['type'] as ItemType | undefined;
      const items = services.items.listFiltered({
        project_id: projectId,
        type: typeFilter,
      });

      const compact = items.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        column_id: item.column_id,
        parent_id: item.parent_id,
      }));

      return JSON.stringify(compact);
    }

    return 'Error: unknown tool ' + name;
  };
}
