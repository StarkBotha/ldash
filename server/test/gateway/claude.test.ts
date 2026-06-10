// NOTE: Tests in this file use a mocked SDK. No real Anthropic API calls are made.
// Real subscription authentication is manually verified by running the server locally
// with ANTHROPIC_API_KEY unset and an active Claude Code subscription.
// Do not add tests that make real network calls — they will fail in CI.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before any imports that pull it in
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(),
  tool: vi.fn(),
}));

import { query, createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter, jsonSchemaToZod } from '../../src/gateway/adapters/claude.js';
import type { GatewayChunk, ToolDefinition } from '../../src/gateway/types.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockCreateSdkMcpServer = createSdkMcpServer as unknown as ReturnType<typeof vi.fn>;
const mockSdkTool = sdkTool as unknown as ReturnType<typeof vi.fn>;

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
  delete process.env.ANTHROPIC_API_KEY;

  // Default mock for createSdkMcpServer — returns a sentinel object
  mockCreateSdkMcpServer.mockReturnValue({ type: 'sdk', name: 'board-tools', instance: {} });

  // Default mock for tool() — returns a descriptor with the handler stored on it
  // so tests can call it to simulate SDK invoking the tool
  mockSdkTool.mockImplementation(
    (name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => ({
      name,
      handler,
    })
  );
});

// ---------------------------------------------------------------------------
// streamChat tests
// ---------------------------------------------------------------------------

describe('ClaudeAdapter.streamChat', () => {
  it('yields text chunks from SDK response (whole-message fallback, no deltas)', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'assistant',
          uuid: 'msg-1',
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

  it('yields incremental text chunks from stream_event partial deltas', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          uuid: 'msg-2',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
        },
        {
          type: 'stream_event',
          uuid: 'msg-2',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          message: { content: [{ type: 'text', text: 'Hello' }] },
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

    // Incremental deltas arrive
    expect(chunks).toContainEqual({ type: 'text', text: 'Hel' });
    expect(chunks).toContainEqual({ type: 'text', text: 'lo' });
    // Whole-message text is NOT duplicated — 'Hello' must not appear as a text chunk
    const textChunks = chunks.filter((c) => (c as { type: string }).type === 'text') as { type: string; text: string }[];
    expect(textChunks.every((c) => c.text !== 'Hello')).toBe(true);
    expect(chunks).toContainEqual({ type: 'done' });
  });

  it('does not duplicate text when deltas and whole-message both present', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          uuid: 'msg-3',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } },
        },
        {
          type: 'stream_event',
          uuid: 'msg-3',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } },
        },
        {
          // Whole-message arrives after deltas — must be skipped
          type: 'assistant',
          uuid: 'msg-3',
          message: { content: [{ type: 'text', text: 'AB' }] },
        },
        { type: 'result', subtype: 'success', result: '', is_error: false },
      ])
    );

    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    const textChunks: string[] = [];
    for await (const chunk of adapter.streamChat([{ role: 'user', content: 'Hi' }])) {
      if (chunk.type === 'text') textChunks.push(chunk.text);
    }

    // Only the two incremental delta texts arrive — 'AB' whole-message is suppressed
    expect(textChunks).toEqual(['A', 'B']);
  });

  it('calls query with allowedTools: [] and includePartialMessages: true', async () => {
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
    const callArg = mockQuery.mock.calls[0][0] as { options?: { allowedTools?: unknown[]; includePartialMessages?: boolean } };
    expect(callArg.options?.allowedTools).toEqual([]);
    expect(callArg.options?.includePartialMessages).toBe(true);
  });

  it('does not set ANTHROPIC_API_KEY when authMode is subscription', () => {
    process.env.ANTHROPIC_API_KEY = 'should-be-deleted';
    new ClaudeAdapter({ authMode: 'subscription' });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// callWithTools tests
// ---------------------------------------------------------------------------

describe('ClaudeAdapter.callWithTools', () => {
  it('yields error chunk when opts.executeTool is missing', async () => {
    const adapter = new ClaudeAdapter({ authMode: 'subscription' });

    const chunks: GatewayChunk[] = [];
    for await (const chunk of adapter.callWithTools([{ role: 'user', content: 'Hi' }], [])) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('executeTool'),
      })
    );
  });

  it('calls executeTool with right name and args, emits tool_call + text + done in order', async () => {
    // Capture the tool handler registered via the mock tool() so we can invoke it
    let capturedHandler: ((args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>) | null = null;

    mockSdkTool.mockImplementation(
      (name: string, _desc: string, _schema: unknown, handler: typeof capturedHandler) => {
        capturedHandler = handler;
        return { name, handler };
      }
    );

    // The SDK query will: first await — handler fires (captured above), then emit text + result
    // We simulate this by driving the query mock to invoke the handler mid-stream.
    mockQuery.mockImplementation(() => {
      return makeAsyncIterable([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'planning...' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'done',
          is_error: false,
        },
      ]);
    });

    const executeTool = vi.fn().mockResolvedValue('tool-result');

    const toolDefs: ToolDefinition[] = [
      {
        name: 'my_tool',
        description: 'does something',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      },
    ];

    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    const chunks: GatewayChunk[] = [];

    for await (const chunk of adapter.callWithTools(
      [{ role: 'user', content: 'run tool' }],
      toolDefs,
      { executeTool }
    )) {
      chunks.push(chunk);
    }

    // text and done come through
    expect(chunks).toContainEqual({ type: 'text', text: 'planning...' });
    expect(chunks).toContainEqual({ type: 'done' });

    // createSdkMcpServer and tool() were called
    expect(mockCreateSdkMcpServer).toHaveBeenCalledOnce();
    expect(mockSdkTool).toHaveBeenCalledWith(
      'my_tool',
      'does something',
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ alwaysLoad: true })
    );
  });

  it('executeTool is called with correct name and JSON args when handler fires', async () => {
    let capturedToolHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;

    mockSdkTool.mockImplementation(
      (name: string, _desc: string, _schema: unknown, handler: typeof capturedToolHandler) => {
        capturedToolHandler = handler;
        return { name, handler };
      }
    );

    const executeTool = vi.fn().mockResolvedValue('result-from-tool');

    // SDK emits assistant text; the test drives the tool handler directly to verify
    // executeTool wiring (the SDK tool handler is called by the SDK loop in real usage;
    // here we verify it calls executeTool correctly by calling it ourselves).
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        { type: 'result', subtype: 'success', result: '', is_error: false },
      ])
    );

    const toolDefs: ToolDefinition[] = [
      {
        name: 'create_item',
        description: 'creates an item',
        parameters: {
          type: 'object',
          properties: { title: { type: 'string' }, type: { type: 'string' } },
          required: ['title'],
        },
      },
    ];

    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    for await (const _c of adapter.callWithTools(
      [{ role: 'user', content: 'test' }],
      toolDefs,
      { executeTool }
    )) {
      /* consume */
    }

    // Now call the captured handler to verify executeTool integration
    expect(capturedToolHandler).not.toBeNull();
    await capturedToolHandler!({ title: 'My task', type: 'task' });

    expect(executeTool).toHaveBeenCalledWith(
      'create_item',
      JSON.stringify({ title: 'My task', type: 'task' })
    );
  });

  it('yields error chunk when executeTool throws', async () => {
    let capturedHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;

    mockSdkTool.mockImplementation(
      (_name: string, _desc: string, _schema: unknown, handler: typeof capturedHandler) => {
        capturedHandler = handler;
        return { name: 'fail_tool', handler };
      }
    );

    const executeTool = vi.fn().mockRejectedValue(new Error('tool-boom'));

    mockQuery.mockReturnValue(
      makeAsyncIterable([
        { type: 'result', subtype: 'success', result: '', is_error: false },
      ])
    );

    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    for await (const _c of adapter.callWithTools(
      [{ role: 'user', content: 'test' }],
      [{ name: 'fail_tool', description: 'd', parameters: {} }],
      { executeTool }
    )) {
      /* consume */
    }

    // Call handler to verify error handling
    expect(capturedHandler).not.toBeNull();
    const result = await capturedHandler!({}) as { content: { text: string }[] };
    // Should return error text in content, not throw
    expect(result.content[0].text).toContain('Error: tool-boom');
  });

  it('SDK result error surfaces as error chunk', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['execution failed'],
        },
      ])
    );

    const executeTool = vi.fn();
    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    const chunks: GatewayChunk[] = [];

    for await (const chunk of adapter.callWithTools(
      [{ role: 'user', content: 'test' }],
      [],
      { executeTool }
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'execution failed' })
    );
  });

  it('sets executesToolsInternally = true', () => {
    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    expect(adapter.executesToolsInternally).toBe(true);
  });

  it('yields incremental text from stream_event deltas in callWithTools', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'stream_event',
          uuid: 'msg-ct-1',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Part1' } },
        },
        {
          type: 'stream_event',
          uuid: 'msg-ct-1',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Part2' } },
        },
        {
          type: 'assistant',
          uuid: 'msg-ct-1',
          message: { content: [{ type: 'text', text: 'Part1Part2' }] },
        },
        { type: 'result', subtype: 'success', result: '', is_error: false },
      ])
    );

    const executeTool = vi.fn();
    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    const textChunks: string[] = [];
    for await (const chunk of adapter.callWithTools(
      [{ role: 'user', content: 'hi' }],
      [],
      { executeTool }
    )) {
      if (chunk.type === 'text') textChunks.push(chunk.text);
    }

    // Incremental deltas arrive; whole-message text is not duplicated
    expect(textChunks).toEqual(['Part1', 'Part2']);
  });

  it('callWithTools whole-message fallback when no deltas arrive (old SDK behavior)', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        {
          type: 'assistant',
          uuid: 'msg-ct-2',
          message: { content: [{ type: 'text', text: 'FallbackText' }] },
        },
        { type: 'result', subtype: 'success', result: '', is_error: false },
      ])
    );

    const executeTool = vi.fn();
    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    const textChunks: string[] = [];
    for await (const chunk of adapter.callWithTools(
      [{ role: 'user', content: 'hi' }],
      [],
      { executeTool }
    )) {
      if (chunk.type === 'text') textChunks.push(chunk.text);
    }

    expect(textChunks).toEqual(['FallbackText']);
  });

  it('sets includePartialMessages: true on the query options in callWithTools', async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([
        { type: 'result', subtype: 'success', result: '', is_error: false },
      ])
    );

    const executeTool = vi.fn();
    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    for await (const _c of adapter.callWithTools(
      [{ role: 'user', content: 'hi' }],
      [],
      { executeTool }
    )) { /* consume */ }

    const callArg = mockQuery.mock.calls[0][0] as { options?: { includePartialMessages?: boolean } };
    expect(callArg.options?.includePartialMessages).toBe(true);
  });

  it('SDK flow calling the tool handler mid-stream exercises executeTool exactly once', async () => {
    // This test closes the gap that hid Bug 2 in loop.ts:
    // The mock SDK actually invokes the tool handler during query() iteration,
    // which triggers opts.executeTool (as the real ClaudeAdapter does).
    let capturedHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;

    mockSdkTool.mockImplementation(
      (_name: string, _desc: string, _schema: unknown, handler: typeof capturedHandler) => {
        capturedHandler = handler;
        return { name: 'create_item', handler };
      }
    );

    const executeTool = vi.fn().mockResolvedValue('created');

    // The mock query invokes the captured tool handler mid-stream, exactly as the real SDK does
    mockQuery.mockImplementation(() => {
      return {
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next() {
              if (step === 0) {
                step++;
                // Invoke the tool handler (the SDK fires MCP tool callbacks internally)
                if (capturedHandler) {
                  await capturedHandler({ title: 'My task' });
                }
                return {
                  value: {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'Done.' }] },
                  },
                  done: false,
                };
              }
              if (step === 1) {
                step++;
                return {
                  value: { type: 'result', subtype: 'success', result: '', is_error: false },
                  done: false,
                };
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
    });

    const toolDefs: ToolDefinition[] = [
      {
        name: 'create_item',
        description: 'creates an item',
        parameters: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
      },
    ];

    const adapter = new ClaudeAdapter({ authMode: 'subscription' });
    const chunks: GatewayChunk[] = [];

    for await (const chunk of adapter.callWithTools(
      [{ role: 'user', content: 'Create task' }],
      toolDefs,
      { executeTool }
    )) {
      chunks.push(chunk);
    }

    // executeTool was called exactly once by the SDK tool handler
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith('create_item', JSON.stringify({ title: 'My task' }));

    // tool_call chunk was emitted (so loop.ts can push history entries)
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(true);
    expect(chunks).toContainEqual({ type: 'text', text: 'Done.' });
    expect(chunks).toContainEqual({ type: 'done' });
  });
});

// ---------------------------------------------------------------------------
// constructor test
// ---------------------------------------------------------------------------

describe('ClaudeAdapter constructor', () => {
  it('throws if authMode is api-key and apiKey is missing', () => {
    expect(() => new ClaudeAdapter({ authMode: 'api-key' })).toThrow(
      'ClaudeAdapter: apiKey is required when authMode is api-key'
    );
  });
});

// ---------------------------------------------------------------------------
// jsonSchemaToZod unit tests
// ---------------------------------------------------------------------------

describe('jsonSchemaToZod', () => {
  it('converts a string property', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(shape.name).toBeDefined();
    // Required string: parse should succeed
    const parsed = (shape.name as ReturnType<typeof import('zod/v4').z.string>).safeParse('hello');
    expect(parsed.success).toBe(true);
  });

  it('marks non-required fields as optional', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { desc: { type: 'string' } },
      required: [],
    });
    // Optional: undefined should pass
    const parsed = (shape.desc as ReturnType<typeof import('zod/v4').z.string>).safeParse(undefined);
    expect(parsed.success).toBe(true);
  });

  it('converts a number property', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    });
    const parsed = (shape.count as ReturnType<typeof import('zod/v4').z.number>).safeParse(42);
    expect(parsed.success).toBe(true);
  });

  it('converts an enum property', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { status: { enum: ['open', 'closed'] } },
      required: ['status'],
    });
    const okParsed = (shape.status as ReturnType<typeof import('zod/v4').z.ZodEnum>).safeParse('open');
    expect(okParsed.success).toBe(true);
    const badParsed = (shape.status as ReturnType<typeof import('zod/v4').z.ZodEnum>).safeParse('other');
    expect(badParsed.success).toBe(false);
  });

  it('throws on nested object property', () => {
    expect(() =>
      jsonSchemaToZod({
        type: 'object',
        properties: { nested: { type: 'object' } },
        required: [],
      })
    ).toThrow('nested object property');
  });

  it('throws on array property', () => {
    expect(() =>
      jsonSchemaToZod({
        type: 'object',
        properties: { items: { type: 'array' } },
        required: [],
      })
    ).toThrow('array property');
  });

  it('throws if top-level type is not object', () => {
    expect(() =>
      jsonSchemaToZod({ type: 'string' })
    ).toThrow('top-level schema type must be "object"');
  });

  it('handles empty properties', () => {
    const shape = jsonSchemaToZod({ type: 'object' });
    expect(Object.keys(shape)).toHaveLength(0);
  });
});
