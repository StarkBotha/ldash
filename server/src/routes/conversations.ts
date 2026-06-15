import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import type Database from 'better-sqlite3';
import type { Services } from '../types.js';
import type { ConversationService } from '../services/conversations.js';
import type { SettingsService } from '../services/settings.js';
import { getAdapter } from '../gateway/index.js';
import { buildItemChatContext, buildKbChatContext } from '../gateway/context.js';
import type { ChatMessage } from '../gateway/types.js';
import { runToolLoop, type PendingToolCall } from '../gateway/loop.js';
import { getItemChatToolDefinitions, createItemChatToolHandler } from '../chat/tools.js';
import { getKbChatToolDefinitions, createKbChatToolHandler } from '../chat/kbTools.js';
import { eventBus as defaultBus } from '../events/bus.js';
import type { EventBus } from '../events/bus.js';
import { createLogger } from '../logger.js';

const logger = createLogger('chat');
const gatewayLogger = createLogger('gateway');

export function createConversationsRouter(
  services: Services,
  conversations: ConversationService,
  settings: SettingsService,
  bus: EventBus = defaultBus,
  db?: Database.Database
): Hono {
  const app = new Hono();

  // POST /api/conversations — get-or-create conversation
  app.post('/api/conversations', async (c) => {
    let body: { projectId?: string; itemId?: string; kb?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const { projectId, itemId, kb } = body;

    if (!projectId || typeof projectId !== 'string') {
      return c.json({ error: 'projectId is required' }, 400);
    }

    const project = services.projects.get(projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    if (kb === true) {
      const conversation = conversations.getOrCreateKbConversation(projectId);
      logger.info('conversation fetched', { conversationId: conversation.id, type: 'kb', projectId });
      return c.json(conversation);
    }

    if (itemId !== undefined && itemId !== null) {
      const item = services.items.get(itemId);
      if (!item || item.project_id !== projectId) {
        return c.json({ error: 'Item not found in this project' }, 404);
      }
      const conversation = conversations.getOrCreateItemConversation(projectId, itemId);
      logger.info('conversation fetched', { conversationId: conversation.id, type: 'item', itemId });
      return c.json(conversation);
    }

    const conversation = conversations.getOrCreatePlanningConversation(projectId);
    logger.info('conversation fetched', { conversationId: conversation.id, type: 'planning', projectId });
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
    const userMsg = conversations.appendMessage(id, { role: 'user', content });
    logger.info('user message persisted', { conversationId: id, messageId: userMsg.id });

    // Fetch full history
    const allMessages = conversations.getMessages(id);

    // Map to ChatMessage[]
    const chatMessages: ChatMessage[] = allMessages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls ?? undefined,
    }));

    // Prepend system prompt for tool-using conversations (item + kb)
    let systemPrompt: string | undefined;
    const isItemChat = conversation.type === 'item' && conversation.item_id != null;
    const isKbChat = conversation.type === 'kb' && conversation.project_id != null;
    if (isItemChat) {
      try {
        systemPrompt = buildItemChatContext(services, conversation.item_id!);
        const columnNames = services.columns.list().map((col) => col.name).join(', ');
        systemPrompt +=
          '\n\n## Board tools\n' +
          'You have tools to act on the board: move_task (tasks only — story/epic status is derived and cannot be set), add_comment, get_item, create_item, update_item, and list_items. ' +
          'Items can be referenced by id or by ticket key (e.g. "DUN-12"). ' +
          `move_task accepts the column NAME directly — the columns are: ${columnNames}. ` +
          'Use the tools when the user asks to change status, record a note on a ticket, or file follow-up work. Do not move items the user did not ask about.';
        chatMessages.unshift({ role: 'system', content: systemPrompt });
      } catch {
        // If context assembly fails, continue without system prompt
      }
    } else if (isKbChat) {
      try {
        systemPrompt = buildKbChatContext(services, conversation.project_id);
        chatMessages.unshift({ role: 'system', content: systemPrompt });
      } catch {
        // If context assembly fails, continue without system prompt
      }
    }

    // Log adapter selection and system prompt debug
    const gatewaySettings = settings.getGatewaySettings();
    const providerName = gatewaySettings.activeProvider ?? 'unknown';
    const activeProvider = gatewaySettings.providers.find(p => p.name === providerName);
    gatewayLogger.info('stream start', {
      provider: providerName,
      type: activeProvider?.type ?? 'unknown',
      model: activeProvider?.model ?? 'unknown',
      conversationId: id,
    });
    if (systemPrompt) {
      gatewayLogger.debug('system prompt', { preview: systemPrompt.slice(0, 200) });
    }
    const lastUserMsg = chatMessages.filter(m => m.role === 'user').at(-1);
    if (lastUserMsg) {
      gatewayLogger.debug('user message', { preview: lastUserMsg.content.slice(0, 200) });
    }

    // Item and KB conversations get tools and run through the tool loop
    if ((isItemChat || isKbChat) && conversation.project_id) {
      const tools = isKbChat ? getKbChatToolDefinitions() : getItemChatToolDefinitions();
      const toolHandler = isKbChat
        ? createKbChatToolHandler(services, conversation.project_id)
        : createItemChatToolHandler(services, conversation.project_id, bus, db);
      const historyOffset = chatMessages.length;

      return streamText(c, async (stream) => {
        let chunkCount = 0;
        let totalTextLength = 0;
        let toolCallCount = 0;
        const streamStart = Date.now();

        try {
          const finalHistory = await runToolLoop(
            adapter,
            chatMessages,
            tools,
            async (name, args) => {
              logger.debug('chat tool args', { tool: name, args });
              const toolStart = Date.now();
              const result = await toolHandler(name, args);
              const success = !result.startsWith('Error:');
              logger.info('chat tool executed', { tool: name, ok: success, duration_ms: Date.now() - toolStart });
              await stream.write(`data: ${JSON.stringify({ type: 'tool_result', toolName: name, success })}\n\n`);
              return result;
            },
            async (chunk) => {
              chunkCount++;
              totalTextLength += chunk.length;
              await stream.write(`data: ${JSON.stringify({ type: 'text', text: chunk })}\n\n`);
            },
            async (call: PendingToolCall) => {
              toolCallCount++;
              await stream.write(`data: ${JSON.stringify({ type: 'tool_call', toolName: call.name })}\n\n`);
            }
          );

          // Persist new messages produced by the loop (everything after the input history)
          const newMessages = finalHistory.slice(historyOffset);
          for (const msg of newMessages) {
            if (msg.role === 'assistant' || msg.role === 'tool') {
              conversations.appendMessage(id, {
                role: msg.role,
                content: msg.content,
                tool_calls: msg.tool_calls ?? null,
              });
            }
          }

          gatewayLogger.info('stream complete', {
            conversationId: id,
            chunks: chunkCount,
            text_length: totalTextLength,
            tool_call_count: toolCallCount,
            duration_ms: Date.now() - streamStart,
          });

          await stream.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          gatewayLogger.error('stream error chunk', { message: msg, conversationId: id });
          await stream.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
        }
      });
    }

    return streamText(c, async (stream) => {
      let assistantBuffer = '';
      let completed = false;
      let chunkCount = 0;
      const streamStart = Date.now();

      try {
        for await (const chunk of adapter.streamChat(chatMessages)) {
          if (chunk.type === 'text') {
            assistantBuffer += chunk.text;
            chunkCount++;
            await stream.write(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`);
          } else if (chunk.type === 'done') {
            await stream.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            completed = true;
            break;
          } else if (chunk.type === 'error') {
            gatewayLogger.error('stream error chunk', { message: chunk.message, conversationId: id });
            await stream.write(`data: ${JSON.stringify({ type: 'error', message: chunk.message })}\n\n`);
            return;
          } else if (chunk.type === 'tool_call') {
            // Skip silently — streamChat should not emit these
          }
        }
      } catch {
        logger.info('stream aborted', { conversationId: id });
        await stream.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted' })}\n\n`);
        return;
      }

      if (completed) {
        const assistantMsg = conversations.appendMessage(id, { role: 'assistant', content: assistantBuffer });
        logger.info('assistant message persisted', {
          conversationId: id,
          messageId: assistantMsg.id,
          length: assistantBuffer.length,
        });
        gatewayLogger.info('stream complete', {
          conversationId: id,
          chunks: chunkCount,
          text_length: assistantBuffer.length,
          tool_call_count: 0,
          duration_ms: Date.now() - streamStart,
        });
      }
    });
  });

  return app;
}
