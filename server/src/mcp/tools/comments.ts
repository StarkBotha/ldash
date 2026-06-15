import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Services } from '../../types.js';
import { eventBus as defaultBus } from '../../events/bus.js';
import type { EventBus } from '../../events/bus.js';

export function registerCommentTools(server: McpServer, services: Services, bus: EventBus = defaultBus): void {
  server.tool(
    'ldash_add_comment',
    'Post a comment on an item. Use this to leave notes about implementation decisions, blockers encountered, questions for the human reviewer, or a summary of what was done. Comments are visible to the user in the item detail panel.',
    {
      item_id: z.string().describe('The id of the item to comment on.'),
      body: z.string().min(1).describe('The comment text. Markdown is accepted. Must not be empty.'),
    },
    async (input) => {
      const itemCheck = services.items.get(input.item_id);
      if (!itemCheck) {
        return { content: [{ type: 'text' as const, text: 'Error: item not found' }], isError: true };
      }

      const comment = services.comments.create({
        item_id: input.item_id,
        body: input.body,
        author: 'claude-code',
      });

      const item = services.items.get(input.item_id)!;

      services.activity.append({
        item_id: input.item_id,
        project_id: item.project_id,
        actor_type: 'claude',
        actor_id: 'claude-code',
        event_type: 'comment.created',
        payload: { comment_id: comment.id, author: 'claude-code' },
      });

      bus.emit({
        type: 'comment.created',
        projectId: item.project_id,
        entityId: comment.id,
        data: { comment },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(comment, null, 2) }] };
    }
  );

  server.tool(
    'ldash_edit_comment',
    'Edit an existing comment on an item — the new body fully replaces the old text. Use this to fix or update a comment you posted earlier (correct a mistake, add detail) instead of posting a duplicate follow-up. Identify the comment by its id: ldash_get_item lists each comment with its id.',
    {
      comment_id: z.string().describe('The id of the comment to edit.'),
      body: z.string().min(1).describe('The new comment text, replacing the existing text entirely. Markdown is accepted. Must not be empty.'),
    },
    async (input) => {
      const existing = services.comments.get(input.comment_id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: 'Error: comment not found' }], isError: true };
      }

      const item = services.items.get(existing.item_id);
      if (!item) {
        return { content: [{ type: 'text' as const, text: 'Error: item not found' }], isError: true };
      }

      const comment = services.comments.update(input.comment_id, { body: input.body });

      services.activity.append({
        item_id: existing.item_id,
        project_id: item.project_id,
        actor_type: 'claude',
        actor_id: 'claude-code',
        event_type: 'comment.updated',
        payload: { comment_id: comment.id, author: comment.author },
      });

      bus.emit({
        type: 'comment.updated',
        projectId: item.project_id,
        entityId: comment.id,
        data: { comment },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(comment, null, 2) }] };
    }
  );
}
