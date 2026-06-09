import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ChatAdapter, ChatMessage, GatewayChunk, CallOptions, ToolDefinition } from '../types.js';

export interface ClaudeAdapterOptions {
  authMode: 'subscription' | 'api-key';
  apiKey?: string;
  model?: string;
}

export class ClaudeAdapter implements ChatAdapter {
  private options: ClaudeAdapterOptions;
  private apiKeyCleared = false;

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
      };
      if (systemMessage) {
        queryOpts.systemPrompt = systemMessage;
      }

      const result = query({ prompt, options: queryOpts as Parameters<typeof query>[0]['options'] });

      for await (const message of result) {
        if (message.type === 'assistant') {
          // Extract text from BetaMessage content blocks
          const betaMessage = message.message;
          if (betaMessage && betaMessage.content) {
            for (const block of betaMessage.content) {
              if (block.type === 'text' && block.text) {
                yield { type: 'text', text: block.text };
              }
            }
          }
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
    const model = opts?.model ?? this.options.model ?? 'claude-sonnet-4-6';
    const maxTokens = opts?.maxTokens ?? 8096;

    // Determine auth headers
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };

    if (this.options.authMode === 'subscription') {
      const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) {
        yield { type: 'error', message: 'CLAUDE_CODE_OAUTH_TOKEN environment variable not set' };
        return;
      }
      headers['Authorization'] = `Bearer ${token}`;
      headers['anthropic-beta'] = 'oauth-2023-05-03';
    } else {
      headers['x-api-key'] = this.options.apiKey ?? '';
    }

    // Separate system messages
    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemContent = systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join('\n\n')
      : undefined;

    // Map tools to Anthropic native format
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    // Map messages to Anthropic format
    type AnthropicMessage = {
      role: 'user' | 'assistant';
      content: string | AnthropicContentBlock[];
    };

    type AnthropicContentBlock =
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      | { type: 'tool_result'; tool_use_id: string; content: string };

    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id ?? '',
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        anthropicMessages.push({
          role: 'assistant',
          content: msg.tool_calls.map((call) => {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(call.arguments) as Record<string, unknown>;
            } catch {
              input = {};
            }
            return {
              type: 'tool_use' as const,
              id: call.id,
              name: call.name,
              input,
            };
          }),
        });
      } else {
        anthropicMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    const requestBody: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      stream: true,
      tools: anthropicTools,
      tool_choice: { type: 'auto' },
      messages: anthropicMessages,
    };

    if (systemContent) {
      requestBody['system'] = systemContent;
    }

    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
      return;
    }

    if (!response.ok) {
      let errMsg = `Anthropic API error: HTTP ${response.status}`;
      try {
        const errBody = await response.json() as { error?: { message?: string } };
        if (errBody?.error?.message) errMsg = errBody.error.message;
      } catch {
        // ignore parse error
      }
      yield { type: 'error', message: errMsg };
      return;
    }

    if (!response.body) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track current tool call being accumulated
    type ToolCallAccumulator = { id: string; name: string; argumentBuffer: string };
    let currentToolCall: ToolCallAccumulator | null = null;
    let currentBlockType: 'text' | 'tool_use' | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '' || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('event: ')) {
            // event type line — we handle via 'data:' lines
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice('data: '.length);

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            continue;
          }

          const eventType = parsed['type'] as string | undefined;

          if (eventType === 'content_block_start') {
            const block = parsed['content_block'] as Record<string, unknown> | undefined;
            if (block?.type === 'text') {
              currentBlockType = 'text';
              currentToolCall = null;
            } else if (block?.type === 'tool_use') {
              currentBlockType = 'tool_use';
              currentToolCall = {
                id: (block['id'] as string) ?? '',
                name: (block['name'] as string) ?? '',
                argumentBuffer: '',
              };
            }
          } else if (eventType === 'content_block_delta') {
            const delta = parsed['delta'] as Record<string, unknown> | undefined;
            if (!delta) continue;

            if (delta['type'] === 'text_delta') {
              yield { type: 'text', text: (delta['text'] as string) ?? '' };
            } else if (delta['type'] === 'input_json_delta' && currentToolCall) {
              currentToolCall.argumentBuffer += (delta['partial_json'] as string) ?? '';
            }
          } else if (eventType === 'content_block_stop') {
            if (currentBlockType === 'tool_use' && currentToolCall) {
              yield {
                type: 'tool_call',
                id: currentToolCall.id,
                name: currentToolCall.name,
                args: currentToolCall.argumentBuffer,
              };
              currentToolCall = null;
            }
            currentBlockType = null;
          } else if (eventType === 'message_stop') {
            yield { type: 'done' };
            return;
          } else if (eventType === 'error') {
            const errObj = parsed['error'] as Record<string, unknown> | undefined;
            const msg = (errObj?.['message'] as string) ?? 'Unknown error from Anthropic stream';
            yield { type: 'error', message: msg };
            return;
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
      return;
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done' };
  }
}
