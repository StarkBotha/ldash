import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import type { Services } from '../types.js';
import type { SettingsService } from '../services/settings.js';
import type { EventBus } from '../events/bus.js';
import { getPlanningToolDefinitions, createPlanningToolHandler } from '../planning/tools.js';
import { buildPlanningSystemPrompt } from '../planning/prompt.js';
import { runToolLoop } from '../gateway/loop.js';
import type { PendingToolCall } from '../gateway/loop.js';
import { getAdapter } from '../gateway/index.js';
import type { ChatMessage } from '../gateway/types.js';

export type PlanningStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolName: string; label: string }
  | { type: 'tool_result'; toolName: string; success: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string };

function buildToolCallLabel(toolName: string, argumentsJson: string): string {
  if (toolName === 'create_item') {
    try {
      const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
      const type = parsed['type'] ?? 'item';
      const title = parsed['title'] ?? '';
      return `Creating ${type}: "${title}"`;
    } catch {
      return 'Creating item';
    }
  }
  if (toolName === 'update_item') {
    try {
      const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
      return `Updating item ${parsed['item_id'] ?? ''}`;
    } catch {
      return 'Updating item';
    }
  }
  if (toolName === 'list_items') {
    return 'Listing items';
  }
  return 'Calling ' + toolName;
}

export function createPlanningRouter(
  services: Services,
  settingsService: SettingsService,
  bus: EventBus
): Hono {
  const app = new Hono();

  // POST /api/projects/:projectId/planning/messages — send a message, stream response
  app.post('/api/projects/:projectId/planning/messages', async (c) => {
    const projectId = c.req.param('projectId');

    const project = services.projects.get(projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
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
      adapter = getAdapter(settingsService);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }

    // Get or create planning conversation
    const conversation = services.conversations.getOrCreatePlanningConversation(projectId);

    // Persist user message
    services.conversations.appendMessage(conversation.id, { role: 'user', content });

    // Fetch full history and map to ChatMessage[]
    const storedMessages = services.conversations.getMessages(conversation.id);
    const messages: ChatMessage[] = storedMessages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls ?? undefined,
    }));

    // Prepend system prompt
    const systemPrompt = buildPlanningSystemPrompt(services, projectId);
    messages.unshift({ role: 'system', content: systemPrompt });

    const tools = getPlanningToolDefinitions();
    const toolHandler = createPlanningToolHandler(services, projectId, bus);

    // Track messages already persisted (count before loop)
    const persistedCount = storedMessages.length;

    return streamText(c, async (stream) => {
      async function writePlanningEvent(event: PlanningStreamEvent): Promise<void> {
        await stream.write(JSON.stringify(event) + '\n');
      }

      try {
        const finalHistory = await runToolLoop(
          adapter,
          messages,
          tools,
          async (name, args) => {
            // Wrap tool handler to emit tool_result event
            const result = await toolHandler(name, args);
            const success = !result.startsWith('Error:');
            await writePlanningEvent({ type: 'tool_result', toolName: name, success });
            return result;
          },
          async (chunk) => {
            await writePlanningEvent({ type: 'text', content: chunk });
          },
          async (call: PendingToolCall) => {
            const label = buildToolCallLabel(call.name, call.args);
            await writePlanningEvent({ type: 'tool_call', toolName: call.name, label });
          }
        );

        // Persist new messages from the returned history
        // Messages after the system prompt (index 0) and the original user messages (persistedCount)
        // finalHistory = [system, ...storedMessages (persistedCount), ...newMessages]
        // new messages start at index persistedCount + 1 (skip system)
        const newMessages = finalHistory.slice(persistedCount + 1); // +1 for system message
        for (const msg of newMessages) {
          if (msg.role === 'assistant' || msg.role === 'tool') {
            services.conversations.appendMessage(conversation.id, {
              role: msg.role,
              content: msg.content,
              tool_calls: msg.tool_calls ?? null,
            });
          }
        }

        await writePlanningEvent({ type: 'done' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await writePlanningEvent({ type: 'error', message: msg });
      }
    });
  });

  // GET /api/projects/:projectId/planning/messages — get conversation history
  app.get('/api/projects/:projectId/planning/messages', async (c) => {
    const projectId = c.req.param('projectId');

    const project = services.projects.get(projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const conversation = services.conversations.getOrCreatePlanningConversation(projectId);
    const messages = services.conversations.getMessages(conversation.id);

    const chatMessages: ChatMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls ?? undefined,
    }));

    return c.json({ conversationId: conversation.id, messages: chatMessages });
  });

  // DELETE /api/projects/:projectId/planning/messages — clear conversation
  app.delete('/api/projects/:projectId/planning/messages', async (c) => {
    const projectId = c.req.param('projectId');

    const project = services.projects.get(projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const conversation = services.conversations.getOrCreatePlanningConversation(projectId);
    services.conversations.clearMessages(conversation.id);

    return new Response(null, { status: 204 });
  });

  return app;
}
