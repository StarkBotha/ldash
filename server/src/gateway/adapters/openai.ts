import type { ChatAdapter, ChatMessage, GatewayChunk, CallOptions, ToolDefinition } from '../types.js';

export interface OpenAIAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAIAdapter implements ChatAdapter {
  private options: OpenAIAdapterOptions;

  constructor(options: OpenAIAdapterOptions) {
    if (!options.baseUrl || options.baseUrl.trim() === '') {
      throw new Error('OpenAIAdapter: baseUrl is required');
    }
    if (!options.model || options.model.trim() === '') {
      throw new Error('OpenAIAdapter: model is required');
    }
    this.options = options;
  }

  private async *readSSELines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          yield line.replace(/\r$/, '');
        }
      }
      // Flush remaining buffer
      if (buffer.length > 0) {
        yield buffer.replace(/\r$/, '');
      }
    } finally {
      reader.releaseLock();
    }
  }

  async *streamChat(
    messages: ChatMessage[],
    opts?: CallOptions
  ): AsyncGenerator<GatewayChunk> {
    const model = opts?.model ?? this.options.model;
    const maxTokens = opts?.maxTokens ?? 4096;

    // Map messages to OpenAI format; strip tool messages and tool_calls from assistants
    const openaiMessages = messages
      .filter((m) => m.role !== 'tool')
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

    const body = {
      model,
      messages: openaiMessages,
      stream: true,
      max_tokens: maxTokens,
    };

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', message: `OpenAI API error: HTTP ${response.status}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    let gotDone = false;
    try {
      for await (const line of this.readSSELines(response.body)) {
        if (line === '' || line.startsWith(':')) continue;
        if (!line.startsWith('data: ')) continue;
        const data = line.slice('data: '.length);
        if (data === '[DONE]') {
          yield { type: 'done' };
          gotDone = true;
          break;
        }
        let parsed: { choices?: Array<{ delta?: { content?: string } }> };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const content = parsed.choices?.[0]?.delta?.content;
        if (content && content.length > 0) {
          yield { type: 'text', text: content };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
      return;
    }

    if (!gotDone) {
      yield { type: 'done' };
    }
  }

  async *callWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: CallOptions
  ): AsyncGenerator<GatewayChunk> {
    const model = opts?.model ?? this.options.model;
    const maxTokens = opts?.maxTokens ?? 4096;

    // Map messages to OpenAI format including tool messages
    const openaiMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: m.tool_call_id,
          content: m.content,
        };
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: 'assistant' as const,
          content: m.content,
          tool_calls: m.tool_calls.map((tc) => ({
            type: 'function' as const,
            id: tc.id,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      };
    });

    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const body = {
      model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice: 'auto' as const,
      stream: true,
      max_tokens: maxTokens,
    };

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', message: `OpenAI API error: HTTP ${response.status}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    const toolCallBuffer = new Map<number, { id: string; name: string; argumentsBuffer: string }>();

    try {
      for await (const line of this.readSSELines(response.body)) {
        if (line === '' || line.startsWith(':')) continue;
        if (!line.startsWith('data: ')) continue;
        const data = line.slice('data: '.length);
        if (data === '[DONE]') {
          // Flush buffer if non-empty (some providers send [DONE] without finish_reason)
          if (toolCallBuffer.size > 0) {
            for (const entry of toolCallBuffer.values()) {
              yield { type: 'tool_call', id: entry.id, name: entry.name, args: entry.argumentsBuffer };
            }
            toolCallBuffer.clear();
          }
          yield { type: 'done' };
          return;
        }

        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }>;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta) {
          if (delta.content && delta.content.length > 0) {
            yield { type: 'text', text: delta.content };
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallBuffer.has(idx)) {
                toolCallBuffer.set(idx, { id: '', name: '', argumentsBuffer: '' });
              }
              const entry = toolCallBuffer.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.argumentsBuffer += tc.function.arguments;
            }
          }
        }

        if (choice.finish_reason === 'tool_calls') {
          for (const entry of toolCallBuffer.values()) {
            yield { type: 'tool_call', id: entry.id, name: entry.name, args: entry.argumentsBuffer };
          }
          toolCallBuffer.clear();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
      return;
    }

    yield { type: 'done' };
  }
}
