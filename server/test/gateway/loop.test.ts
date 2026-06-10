import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '../../src/gateway/loop.js';
import type { ChatAdapter, GatewayChunk, ToolDefinition } from '../../src/gateway/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// makeInternalAdapter: yields chunks but does NOT call opts.executeTool.
// Used to test chunk-consumer behaviour (text flush, toolCallSink, etc.)
// without triggering tool execution.
function makeInternalAdapter(chunks: GatewayChunk[]): ChatAdapter & { executesToolsInternally: true } {
  return {
    executesToolsInternally: true as const,
    streamChat: async function* () {},
    callWithTools: async function* () {
      yield* chunks;
    },
  };
}

// makeInternalAdapterWithExecution: yields tool_call chunks AND calls
// opts.executeTool (mimicking the real ClaudeAdapter). This is the path
// that exercises the double-execution bug fix.
function makeInternalAdapterWithExecution(
  toolName: string,
  toolArgs: Record<string, unknown>,
  callId: string
): ChatAdapter & { executesToolsInternally: true } {
  return {
    executesToolsInternally: true as const,
    streamChat: async function* () {},
    callWithTools: async function* (_messages, _tools, opts) {
      const argsStr = JSON.stringify(toolArgs);
      // Emit the tool_call chunk (informs the loop to push history entries)
      yield { type: 'tool_call', id: callId, name: toolName, args: argsStr } as GatewayChunk;
      // Execute the tool via opts.executeTool — this is what the real adapter does
      if (opts?.executeTool) {
        await opts.executeTool(toolName, argsStr);
      }
      yield { type: 'done' } as GatewayChunk;
    },
  };
}

const noTools: ToolDefinition[] = [];

// ---------------------------------------------------------------------------
// Internal-execution path: executesToolsInternally = true
// ---------------------------------------------------------------------------

describe('runToolLoop – executesToolsInternally path', () => {
  it('text-only response emits text to sink and returns history with assistant message', async () => {
    const adapter = makeInternalAdapter([
      { type: 'text', text: 'Hello from claude' },
      { type: 'done' },
    ]);

    const textSink = vi.fn();
    const toolCallSink = vi.fn();
    const toolHandler = vi.fn().mockResolvedValue('irrelevant');

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'Hi' }],
      noTools,
      toolHandler,
      textSink,
      toolCallSink
    );

    expect(textSink).toHaveBeenCalledWith('Hello from claude');
    expect(toolCallSink).not.toHaveBeenCalled();
    expect(toolHandler).not.toHaveBeenCalled();
    expect(history[0]).toMatchObject({ role: 'user', content: 'Hi' });

    // Bug 1 fix: text-only reply persists as an assistant message in history
    const assistantMsg = history.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.content).toBe('Hello from claude');
  });

  it('tool_call chunk: toolCallSink is called and history gets assistant tool_call message', async () => {
    // This adapter yields a tool_call chunk but does NOT call opts.executeTool,
    // so the tool result entry is NOT appended (no execution happened).
    const toolCallId = 'tc-001';
    const toolArgs = JSON.stringify({ title: 'My task' });

    const adapter = makeInternalAdapter([
      { type: 'tool_call', id: toolCallId, name: 'create_item', args: toolArgs },
      { type: 'done' },
    ]);

    const toolCallSink = vi.fn();
    const textSink = vi.fn();
    const toolHandler = vi.fn().mockResolvedValue('item-created-id-123');

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'Create a task' }],
      noTools,
      toolHandler,
      textSink,
      toolCallSink
    );

    // toolCallSink receives the pending call
    expect(toolCallSink).toHaveBeenCalledWith(
      expect.objectContaining({ id: toolCallId, name: 'create_item', args: toolArgs })
    );

    // Bug 2 fix: toolHandler is NOT called by the chunk consumer (only by executeTool)
    expect(toolHandler).not.toHaveBeenCalled();

    // history: initial user message + assistant tool_call message
    const assistantMsg = history.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.tool_calls?.[0]).toMatchObject({
      id: toolCallId,
      name: 'create_item',
      arguments: toolArgs,
    });
  });

  it('Bug 2: adapter that calls opts.executeTool runs toolHandler exactly once per tool call', async () => {
    // This mimics the real ClaudeAdapter: emits tool_call chunk AND calls opts.executeTool.
    // With the old loop code, toolHandler ran twice (once via executeTool, once via the
    // chunk consumer). The fix removes the second execution from the chunk consumer.
    const adapter = makeInternalAdapterWithExecution('create_item', { title: 'Test' }, 'call-1');

    const toolHandler = vi.fn().mockResolvedValue('created-ok');

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'Create a task' }],
      noTools,
      toolHandler,
      vi.fn(),
      vi.fn()
    );

    // Exactly ONE execution per tool call — no double-execution
    expect(toolHandler).toHaveBeenCalledTimes(1);
    expect(toolHandler).toHaveBeenCalledWith('create_item', { title: 'Test' });

    // History has: user, assistant tool_call, tool result
    const assistantMsg = history.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMsg).toBeDefined();

    const toolResultMsg = history.find((m) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg?.content).toBe('created-ok');
    expect(toolResultMsg?.tool_call_id).toBe('call-1');
  });

  it('Bug 2: multiple tool calls via opts.executeTool each run exactly once', async () => {
    // Adapter that fires two tool calls, each calling opts.executeTool once
    const adapter: ChatAdapter & { executesToolsInternally: true } = {
      executesToolsInternally: true,
      streamChat: async function* () {},
      callWithTools: async function* (_messages, _tools, opts) {
        yield { type: 'tool_call', id: 'a', name: 'tool_a', args: '{"x":1}' } as GatewayChunk;
        if (opts?.executeTool) await opts.executeTool('tool_a', '{"x":1}');
        yield { type: 'tool_call', id: 'b', name: 'tool_b', args: '{"y":2}' } as GatewayChunk;
        if (opts?.executeTool) await opts.executeTool('tool_b', '{"y":2}');
        yield { type: 'done' } as GatewayChunk;
      },
    };

    const toolHandler = vi.fn().mockResolvedValue('ok');

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'multi' }],
      noTools,
      toolHandler,
      vi.fn(),
      vi.fn()
    );

    // Each tool handler called exactly once
    expect(toolHandler).toHaveBeenCalledTimes(2);

    const toolMsgs = history.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);

    const assistantMsgs = history.filter((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMsgs).toHaveLength(2);
  });

  it('text before tool_call is flushed as a separate assistant message', async () => {
    const adapter = makeInternalAdapter([
      { type: 'text', text: 'Let me do that.' },
      { type: 'tool_call', id: 'tc-1', name: 'create_item', args: '{}' },
      { type: 'done' },
    ]);

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'go' }],
      noTools,
      vi.fn().mockResolvedValue('ok'),
      vi.fn(),
      vi.fn()
    );

    // The text before the tool_call becomes a standalone assistant message
    const textMsg = history.find((m) => m.role === 'assistant' && !m.tool_calls);
    expect(textMsg).toBeDefined();
    expect(textMsg?.content).toBe('Let me do that.');

    // The tool_call is a separate assistant message
    const toolCallMsg = history.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(toolCallMsg).toBeDefined();
  });

  it('error chunk throws from runToolLoop', async () => {
    const adapter = makeInternalAdapter([
      { type: 'error', message: 'internal sdk failure' },
    ]);

    await expect(
      runToolLoop(
        adapter,
        [{ role: 'user', content: 'test' }],
        noTools,
        vi.fn(),
        vi.fn(),
        vi.fn()
      )
    ).rejects.toThrow('internal sdk failure');
  });

  it('executeTool wrapper handles toolHandler exceptions without throwing', async () => {
    // Adapter calls opts.executeTool directly; toolHandler throws.
    // The error must be caught inside executeTool and not propagate.
    const adapter: ChatAdapter & { executesToolsInternally: true } = {
      executesToolsInternally: true,
      streamChat: async function* () {},
      callWithTools: async function* (
        _messages,
        _tools,
        opts
      ) {
        if (opts?.executeTool) {
          const result = await opts.executeTool('boom_tool', '{}');
          // The error is swallowed by executeTool wrapper — result is an error string
          yield { type: 'text', text: result } as GatewayChunk;
        }
        yield { type: 'done' } as GatewayChunk;
      },
    };

    const throwingHandler = vi.fn().mockRejectedValue(new Error('handler-boom'));
    const textSink = vi.fn();

    // Should not throw
    await runToolLoop(
      adapter,
      [{ role: 'user', content: 'test' }],
      noTools,
      throwingHandler,
      textSink,
      vi.fn()
    );

    // The text sink received the error string from executeTool
    expect(textSink).toHaveBeenCalledWith(expect.stringContaining('Error: handler-boom'));
  });

  it('history contains assistant text message and correct tool_call ordering when adapter calls executeTool', async () => {
    // Full round trip: text → tool_call (with executeTool) → text → done
    const adapter: ChatAdapter & { executesToolsInternally: true } = {
      executesToolsInternally: true,
      streamChat: async function* () {},
      callWithTools: async function* (_messages, _tools, opts) {
        yield { type: 'text', text: 'Planning...' } as GatewayChunk;
        yield { type: 'tool_call', id: 'cid-1', name: 'create_item', args: '{"title":"T"}' } as GatewayChunk;
        if (opts?.executeTool) await opts.executeTool('create_item', '{"title":"T"}');
        yield { type: 'text', text: 'Done!' } as GatewayChunk;
        yield { type: 'done' } as GatewayChunk;
      },
    };

    const toolHandler = vi.fn().mockResolvedValue('item-123');

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'Create task' }],
      noTools,
      toolHandler,
      vi.fn(),
      vi.fn()
    );

    // Exactly one execution
    expect(toolHandler).toHaveBeenCalledTimes(1);

    // History order: user, assistant(text before tool), assistant(tool_call), tool(result), assistant(text after)
    const roles = history.map((m) => m.role);
    expect(roles[0]).toBe('user');

    const textBefore = history.find((m) => m.role === 'assistant' && !m.tool_calls && m.content === 'Planning...');
    expect(textBefore).toBeDefined();

    const toolCallMsg = history.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(toolCallMsg?.tool_calls?.[0]).toMatchObject({ id: 'cid-1', name: 'create_item' });

    const toolResult = history.find((m) => m.role === 'tool');
    expect(toolResult?.content).toBe('item-123');
    expect(toolResult?.tool_call_id).toBe('cid-1');

    const textAfter = history.find((m) => m.role === 'assistant' && !m.tool_calls && m.content === 'Done!');
    expect(textAfter).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-round path (executesToolsInternally = false / undefined)
// ---------------------------------------------------------------------------

describe('runToolLoop – multi-round path', () => {
  it('text-only reply produces assistant message in history', async () => {
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        yield { type: 'text', text: 'Hello' } as GatewayChunk;
        yield { type: 'done' } as GatewayChunk;
      },
    };

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'Hi' }],
      noTools,
      vi.fn(),
      vi.fn(),
      vi.fn()
    );

    const assistantMsg = history.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.content).toBe('Hello');
  });

  it('turn text is set as content of assistant tool_calls message', async () => {
    let callCount = 0;
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'text', text: 'Working on it.' } as GatewayChunk;
          yield { type: 'tool_call', id: 'tc-1', name: 'my_tool', args: '{}' } as GatewayChunk;
          yield { type: 'done' } as GatewayChunk;
        } else {
          yield { type: 'text', text: 'All done.' } as GatewayChunk;
          yield { type: 'done' } as GatewayChunk;
        }
      },
    };

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'go' }],
      noTools,
      vi.fn().mockResolvedValue('result'),
      vi.fn(),
      vi.fn()
    );

    // The assistant tool_calls message should have the turn text as content
    const toolCallMsg = history.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(toolCallMsg).toBeDefined();
    expect(toolCallMsg?.content).toBe('Working on it.');

    // Final assistant reply persisted
    const finalMsg = history.find((m) => m.role === 'assistant' && !m.tool_calls);
    expect(finalMsg?.content).toBe('All done.');
  });

  it('maxTurns safety message is appended when limit hit', async () => {
    const adapter: ChatAdapter = {
      streamChat: async function* () {},
      callWithTools: async function* () {
        yield { type: 'tool_call', id: '1', name: 'forever', args: '{}' } as GatewayChunk;
        yield { type: 'done' } as GatewayChunk;
      },
    };

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'go' }],
      noTools,
      vi.fn().mockResolvedValue('ok'),
      vi.fn(),
      vi.fn(),
      { maxTurns: 2 }
    );

    const lastMsg = history[history.length - 1];
    expect(lastMsg.content).toContain('maximum turns');
  });
});
