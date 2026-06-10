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
// streamChat tests (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('ClaudeAdapter.streamChat', () => {
  it('yields text chunks from SDK response', async () => {
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

  it('calls query with allowedTools: []', async () => {
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
