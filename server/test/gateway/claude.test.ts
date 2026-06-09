// NOTE: Tests in this file use a mocked SDK. No real Anthropic API calls are made.
// Real subscription authentication is manually verified by running the server locally
// with ANTHROPIC_API_KEY unset and an active Claude Code subscription.
// Do not add tests that make real network calls — they will fail in CI.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../../src/gateway/adapters/claude.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

function makeAsyncIterable(items: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < items.length) {
            return { value: items[index++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore ANTHROPIC_API_KEY clean state between tests
  delete process.env.ANTHROPIC_API_KEY;
});

describe('ClaudeAdapter', () => {
  it('streamChat yields text chunks from SDK response', async () => {
    // SDK emits SDKAssistantMessage then SDKResultSuccess
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'Hello',
          is_error: false,
        },
      ])
    );

    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    const chunks: unknown[] = [];
    for await (const chunk of adapter.streamChat([{ role: 'user', content: 'Hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({ type: 'text', text: 'Hello' });
    expect(chunks).toContainEqual({ type: 'done' });
  });

  it('streamChat calls query with allowedTools: []', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        { type: 'result', subtype: 'success', result: '', is_error: false },
      ])
    );

    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    for await (const _chunk of adapter.streamChat([{ role: 'user', content: 'Hi' }])) {
      // consume
    }

    expect(mockQuery).toHaveBeenCalledOnce();
    const callArg = mockQuery.mock.calls[0][0] as { options?: { allowedTools?: unknown[] } };
    expect(callArg.options?.allowedTools).toEqual([]);
  });

  it('streamChat does not set ANTHROPIC_API_KEY when authMode is subscription', () => {
    process.env.ANTHROPIC_API_KEY = 'should-be-deleted';

    // Constructor should delete the env var
    new ClaudeAdapter({ authMode: 'subscription' });

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('callWithTools throws not-implemented error', async () => {
    const adapter = new ClaudeAdapter({ authMode: 'subscription' });

    await expect(async () => {
      for await (const _chunk of adapter.callWithTools([], [])) {
        // consume
      }
    }).rejects.toThrow(/not implemented/i);
  });

  it('constructor throws if authMode is api-key and apiKey is missing', () => {
    expect(() => new ClaudeAdapter({ authMode: 'api-key' })).toThrow(
      'ClaudeAdapter: apiKey is required when authMode is api-key'
    );
  });
});
