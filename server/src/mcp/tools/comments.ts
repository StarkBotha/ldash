import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Services } from '../../types.js';

export function registerCommentTools(server: McpServer, services: Services): void {
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

      return { content: [{ type: 'text' as const, text: JSON.stringify(comment, null, 2) }] };
    }
  );
}
