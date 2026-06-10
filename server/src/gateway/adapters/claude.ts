import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { ChatAdapter, ChatMessage, GatewayChunk, CallOptions, ToolDefinition } from '../types.js';

export interface ClaudeAdapterOptions {
  authMode: 'subscription' | 'api-key';
  apiKey?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// jsonSchemaToZod
// Converts a flat JSON Schema object (string/number/boolean/enum properties,
// required[]) to a Zod raw shape suitable for the SDK tool() helper.
// Covers exactly the subset used by planning ToolDefinitions.
// Throws for anything outside that subset (nested objects, arrays, etc.).
// ---------------------------------------------------------------------------

type FlatJsonSchemaProperty = {
  type?: string;
  enum?: unknown[];
  description?: string;
};

type FlatJsonSchema = {
  type?: string;
  properties?: Record<string, FlatJsonSchemaProperty>;
  required?: string[];
};

export function jsonSchemaToZod(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const flat = schema as FlatJsonSchema;

  if (flat.type && flat.type !== 'object') {
    throw new Error(`jsonSchemaToZod: top-level schema type must be "object", got "${flat.type}"`);
  }

  const properties = flat.properties ?? {};
  const required = new Set(flat.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema: z.ZodTypeAny;

    if (prop.enum && prop.enum.length > 0) {
      // Enum: all values must be strings for z.enum
      const values = prop.enum as unknown[];
      if (!values.every((v) => typeof v === 'string')) {
        throw new Error(`jsonSchemaToZod: enum values for property "${key}" must all be strings`);
      }
      const [first, ...rest] = values as [string, ...string[]];
      fieldSchema = z.enum([first, ...rest]);
    } else {
      const propType = prop.type ?? 'string';
      if (propType === 'string') {
        fieldSchema = z.string();
      } else if (propType === 'number' || propType === 'integer') {
        fieldSchema = z.number();
      } else if (propType === 'boolean') {
        fieldSchema = z.boolean();
      } else if (propType === 'object') {
        throw new Error(`jsonSchemaToZod: nested object property "${key}" is not supported`);
      } else if (propType === 'array') {
        throw new Error(`jsonSchemaToZod: array property "${key}" is not supported`);
      } else {
        throw new Error(`jsonSchemaToZod: unsupported property type "${propType}" for key "${key}"`);
      }
    }

    if (!required.has(key)) {
      fieldSchema = fieldSchema.optional();
    }

    shape[key] = fieldSchema;
  }

  return shape;
}

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter implements ChatAdapter {
  private options: ClaudeAdapterOptions;
  private apiKeyCleared = false;

  readonly executesToolsInternally = true;

  constructor(options: ClaudeAdapterOptions) {
    this.options = options;

    if (options.authMode === 'subscription') {
      if (!this.apiKeyCleared) {
        delete process.env.ANTHROPIC_API_KEY;
        this.apiKeyCleared = true;
      }
    } else if (options.authMode === 'api-key') {
      if (!options.apiKey || options.apiKey.trim() === '') {
        throw new Error('ClaudeAdapter: apiKey is required when authMode is api-key');
      }
    }
  }

  async *streamChat(
    messages: ChatMessage[],
    opts?: CallOptions
  ): AsyncGenerator<GatewayChunk> {
    const model = opts?.model ?? this.options.model ?? 'claude-sonnet-4-6';

    let systemMessage: string | undefined;
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const systemMessages = messages.filter((m) => m.role === 'system');
    if (systemMessages.length > 0) {
      systemMessage = systemMessages.map((m) => m.content).join('\n\n');
    }

    // Build prompt string from user/assistant turns
    let prompt = '';
    for (const msg of conversationMessages) {
      if (msg.role === 'user') {
        prompt += `Human: ${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        prompt += `Assistant: ${msg.content}\n\n`;
      }
    }
    // Trim trailing whitespace — the SDK completes from here
    prompt = prompt.trimEnd();

    try {
      const queryOpts: Record<string, unknown> = {
        allowedTools: [],
        model,
        includePartialMessages: true,
      };
      if (systemMessage) {
        queryOpts.systemPrompt = systemMessage;
      }

      const result = query({ prompt, options: queryOpts as Parameters<typeof query>[0]['options'] });

      // Track whether we saw any partial deltas for the current assistant message UUID.
      // When deltas arrived we skip the whole-message emission to avoid doubling text.
      const deltaSeenForUuid = new Set<string>();

      for await (const message of result) {
        if (message.type === 'stream_event') {
          // SDKPartialAssistantMessage — extract text_delta chunks as they arrive
          const evt = (message as { type: 'stream_event'; event: { type: string; delta?: { type: string; text?: string } }; uuid: string }).event;
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            deltaSeenForUuid.add((message as { uuid: string }).uuid);
            yield { type: 'text', text: evt.delta.text };
          }
        } else if (message.type === 'assistant') {
          // Only emit whole-message text if no deltas arrived for this message (fallback path)
          const msgUuid = (message as { uuid?: string }).uuid ?? '';
          if (!deltaSeenForUuid.has(msgUuid)) {
            const betaMessage = message.message;
            if (betaMessage && betaMessage.content) {
              for (const block of betaMessage.content) {
                if (block.type === 'text' && block.text) {
                  yield { type: 'text', text: block.text };
                }
              }
            }
          }
          deltaSeenForUuid.delete(msgUuid);
          if (message.error) {
            yield { type: 'error', message: String(message.error) };
            return;
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success') {
            yield { type: 'done' };
          } else {
            yield { type: 'error', message: message.errors?.join('; ') ?? 'Query failed' };
          }
          return;
        }
      }

      // If we fall through without a result message, emit done
      yield { type: 'done' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
    }
  }

  async *callWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: CallOptions
  ): AsyncGenerator<GatewayChunk> {
    if (!opts?.executeTool) {
      yield { type: 'error', message: 'ClaudeAdapter.callWithTools requires opts.executeTool to be provided' };
      return;
    }

    const executeTool = opts.executeTool;
    const model = opts?.model ?? this.options.model ?? 'claude-sonnet-4-6';

    // ---------------------------------------------------------------------------
    // Async queue: tool handlers fire inside the SDK loop while we iterate
    // the generator externally, so we buffer chunks via an async queue.
    // ---------------------------------------------------------------------------
    type QueueItem = GatewayChunk | { type: '__sentinel_error__'; err: unknown };
    const queue: QueueItem[] = [];
    let resolve: (() => void) | null = null;
    let sdkDone = false;

    function enqueue(item: QueueItem) {
      queue.push(item);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    }

    async function waitForItem(): Promise<void> {
      if (queue.length > 0) return;
      await new Promise<void>((res) => {
        resolve = res;
      });
    }

    // Build the in-process MCP server with one tool per ToolDefinition
    const mcpToolDefs = tools.map((toolDef) => {
      let zodShape: Record<string, z.ZodTypeAny>;
      try {
        zodShape = jsonSchemaToZod(toolDef.parameters);
      } catch (e) {
        zodShape = {};
      }

      return tool(
        toolDef.name,
        toolDef.description,
        zodShape,
        async (args: Record<string, unknown>) => {
          const argsStr = JSON.stringify(args);
          // Generate a stable call-id from tool name + timestamp
          const callId = `${toolDef.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

          enqueue({ type: 'tool_call', id: callId, name: toolDef.name, args: argsStr });

          let resultStr: string;
          try {
            resultStr = await executeTool(toolDef.name, argsStr);
          } catch (err) {
            resultStr = 'Error: ' + (err instanceof Error ? err.message : String(err));
          }

          return {
            content: [{ type: 'text' as const, text: resultStr }],
          };
        },
        { alwaysLoad: true }
      );
    });

    const serverName = 'board-tools';
    const mcpServer = createSdkMcpServer({
      name: serverName,
      version: '1.0.0',
      tools: mcpToolDefs,
      alwaysLoad: true,
    });

    // Restrict allowedTools to only the injected board tools
    const allowedTools = tools.map((t) => `mcp__${serverName}__${t.name}`);

    // Extract system prompt
    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemMessage = systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join('\n\n')
      : undefined;

    // Build prompt from the conversation history
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    let prompt = '';
    for (const msg of conversationMessages) {
      if (msg.role === 'user') {
        prompt += `Human: ${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        prompt += `Assistant: ${msg.content}\n\n`;
      }
      // tool role messages aren't sent as prompt text — the SDK handles tool round-trips internally
    }
    prompt = prompt.trimEnd();

    const queryOpts: Record<string, unknown> = {
      model,
      allowedTools,
      mcpServers: { [serverName]: mcpServer },
      tools: [],
      includePartialMessages: true,
    };
    if (systemMessage) {
      queryOpts.systemPrompt = systemMessage;
    }

    // Run the SDK query in a separate async task so tool handler callbacks
    // can enqueue chunks while we drain the queue concurrently.
    const sdkTask = (async () => {
      try {
        const result = query({
          prompt,
          options: queryOpts as Parameters<typeof query>[0]['options'],
        });

        // Track whether we saw any partial deltas for the current assistant message UUID.
        const deltaSeenForUuid = new Set<string>();

        for await (const message of result) {
          if (message.type === 'stream_event') {
            const evt = (message as { type: 'stream_event'; event: { type: string; delta?: { type: string; text?: string } }; uuid: string }).event;
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              deltaSeenForUuid.add((message as { uuid: string }).uuid);
              enqueue({ type: 'text', text: evt.delta.text });
            }
          } else if (message.type === 'assistant') {
            const msgUuid = (message as { uuid?: string }).uuid ?? '';
            if (!deltaSeenForUuid.has(msgUuid)) {
              const betaMessage = message.message;
              if (betaMessage && betaMessage.content) {
                for (const block of betaMessage.content) {
                  if (block.type === 'text' && block.text) {
                    enqueue({ type: 'text', text: block.text });
                  }
                }
              }
            }
            deltaSeenForUuid.delete(msgUuid);
            if (message.error) {
              enqueue({ type: 'error', message: String(message.error) });
              return;
            }
          } else if (message.type === 'result') {
            if (message.subtype === 'success') {
              enqueue({ type: 'done' });
            } else {
              enqueue({ type: 'error', message: (message as { errors?: string[] }).errors?.join('; ') ?? 'Query failed' });
            }
            return;
          }
        }
        enqueue({ type: 'done' });
      } catch (err: unknown) {
        enqueue({ type: '__sentinel_error__', err });
      } finally {
        sdkDone = true;
        if (resolve) {
          const r = resolve;
          resolve = null;
          r();
        }
      }
    })();

    // Drain the queue until we see done/error or SDK finishes
    try {
      while (true) {
        await waitForItem();

        while (queue.length > 0) {
          const item = queue.shift()!;

          if (item.type === '__sentinel_error__') {
            const msg = item.err instanceof Error ? item.err.message : String(item.err);
            yield { type: 'error', message: msg };
            return;
          }

          yield item as GatewayChunk;

          if (item.type === 'done' || item.type === 'error') {
            return;
          }
        }

        if (sdkDone && queue.length === 0) break;
      }
    } finally {
      // Ensure the SDK task is awaited to avoid unhandled rejections
      await sdkTask.catch(() => {});
    }
  }
}
