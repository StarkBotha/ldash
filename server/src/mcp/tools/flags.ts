import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Services } from '../../types.js';
import { eventBus as defaultBus } from '../../events/bus.js';
import type { EventBus } from '../../events/bus.js';

export function registerFlagTools(server: McpServer, services: Services, bus: EventBus = defaultBus): void {
  // ldash_flag_item
  server.tool(
    'ldash_flag_item',
    'Set or clear the flag on an item. Flagging is a general attention marker — use it to highlight items that need human review, have unresolved questions, or were touched in a way that warrants a second look. The flag state is visible on the board card.',
    {
      item_id: z.string().describe('The id of the item to flag or unflag.'),
      flagged: z.boolean().describe('true to set the flag, false to clear it.'),
    },
    async (input) => {
      const item = services.items.get(input.item_id);
      if (!item) {
        return { content: [{ type: 'text' as const, text: 'Error: item not found' }], isError: true };
      }

      const updatedItem = services.items.setFlag(input.item_id, input.flagged);

      services.activity.append({
        item_id: input.item_id,
        project_id: item.project_id,
        actor_type: 'claude',
        actor_id: 'claude-code',
        event_type: input.flagged ? 'item.flagged' : 'item.unflagged',
        payload: { flagged: input.flagged },
      });

      bus.emit({
        type: input.flagged ? 'item.flagged' : 'item.unflagged',
        projectId: item.project_id,
        entityId: input.item_id,
        data: { item: updatedItem },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(updatedItem, null, 2) }] };
    }
  );

  // ldash_block_item
  server.tool(
    'ldash_block_item',
    'Mark an item as blocked (or unblocked). Use this when you cannot proceed because of an external dependency, a missing decision, or a prerequisite that is not yet done. Blocked items are highlighted on the board. A reason is required when blocking.',
    {
      item_id: z.string().describe('The id of the item to block or unblock.'),
      blocked: z.boolean().describe('true to mark as blocked, false to clear the block.'),
      reason: z.string().optional().describe('Required when blocked is true. Describe what is blocking this item — for example "Waiting for design decision on modal layout". Ignored when blocked is false.'),
    },
    async (input) => {
      const item = services.items.get(input.item_id);
      if (!item) {
        return { content: [{ type: 'text' as const, text: 'Error: item not found' }], isError: true };
      }

      if (input.blocked === true && (input.reason === undefined || input.reason.trim() === '')) {
        return { content: [{ type: 'text' as const, text: 'Error: reason is required when blocking an item' }], isError: true };
      }

      const updatedItem = services.items.setBlock(
        input.item_id,
        input.blocked,
        input.blocked ? input.reason!.trim() : ''
      );

      services.activity.append({
        item_id: input.item_id,
        project_id: item.project_id,
        actor_type: 'claude',
        actor_id: 'claude-code',
        event_type: input.blocked ? 'item.blocked' : 'item.unblocked',
        payload: input.blocked ? { blocked: true, reason: input.reason } : { blocked: false },
      });

      bus.emit({
        type: input.blocked ? 'item.blocked' : 'item.unblocked',
        projectId: item.project_id,
        entityId: input.item_id,
        data: { item: updatedItem },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(updatedItem, null, 2) }] };
    }
  );
}
