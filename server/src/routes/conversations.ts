import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import type { Services } from '../types.js';
import type { ConversationService } from '../services/conversations.js';
import type { SettingsService } from '../services/settings.js';
import { getAdapter } from '../gateway/index.js';
import { buildItemChatContext } from '../gateway/context.js';
import type { ChatMessage } from '../gateway/types.js';

export function createConversationsRouter(
  services: Services,
  conversations: ConversationService,
  settings: SettingsService
): Hono {
  const app = new Hono();

  // POST /api/conversations — get-or-create conversation
  app.post('/api/conversations', async (c) => {
    let body: { projectId?: string; itemId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const { projectId, itemId } = body;

    if (!projectId || typeof projectId !== 'string') {
      return c.json({ error: 'projectId is required' }, 400);
    }

    const project = services.projects.get(projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    if (itemId !== undefined && itemId !== null) {
      const item = services.items.get(itemId);
      if (!item || item.project_id !== projectId) {
        return c.json({ error: 'Item not found in this project' }, 404);
      }
      const conversation = conversations.getOrCreateItemConversation(projectId, itemId);
      return c.json(conversation);
    }

    const conversation = conversations.getOrCreatePlanningConversation(projectId);
    return c.json(conversation);
  });

  // GET /api/conversations/:id
  app.get('/api/conversations/:id', (c) => {
    const id = c.req.param('id');
    const conversation = conversations.getConversation(id);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }
    const messages = conversations.getMessages(id);
    return c.json({ conversation, messages });
  });

  // POST /api/conversations/:id/messages — stream response
  app.post('/api/conversations/:id/messages', async (c) => {
    const id = c.req.param('id');
    const conversation = conversations.getConversation(id);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    let body: { content?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const { content } = body;
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return c.json({ error: 'content is required and must be non-empty' }, 400);
    }

    let adapter;
    try {
      adapter = getAdapter(settings);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }

    // Persist user message
    conversations.appendMessage(id, { role: 'user', content });

    // Fetch full history
    const allMessages = conversations.getMessages(id);

    // Map to ChatMessage[]
    const chatMessages: ChatMessage[] = allMessages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls ?? undefined,
    }));

    // Prepend system prompt for item conversations
    if (conversation.type === 'item' && conversation.item_id) {
      try {
        const systemPrompt = buildItemChatContext(services, conversation.item_id);
        chatMessages.unshift({ role: 'system', content: systemPrompt });
      } catch {
        // If context assembly fails, continue without system prompt
      }
    }

    return streamText(c, async (stream) => {
      let assistantBuffer = '';
      let completed = false;

      try {
        for await (const chunk of adapter.streamChat(chatMessages)) {
          if (chunk.type === 'text') {
            assistantBuffer += chunk.text;
            await stream.write(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`);
          } else if (chunk.type === 'done') {
            await stream.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            completed = true;
            break;
          } else if (chunk.type === 'error') {
            await stream.write(`data: ${JSON.stringify({ type: 'error', message: chunk.message })}\n\n`);
            return;
          } else if (chunk.type === 'tool_call') {
            // Skip silently — streamChat should not emit these
          }
        }
      } catch {
        await stream.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted' })}\n\n`);
        return;
      }

      if (completed) {
        conversations.appendMessage(id, { role: 'assistant', content: assistantBuffer });
      }
    });
  });

  return app;
}
