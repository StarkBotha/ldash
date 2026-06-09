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
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _opts?: CallOptions
  ): AsyncGenerator<GatewayChunk> {
    throw new Error('callWithTools not implemented for claude-subscription in Phase 4 — see Phase 5 spec');
  }
}
