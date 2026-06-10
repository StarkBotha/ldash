import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '../../src/gateway/loop.js';
import type { ChatAdapter, GatewayChunk, ToolDefinition } from '../../src/gateway/types.js';

// ---------------------------------------------------------------------------
// Internal-execution path: adapter with executesToolsInternally = true
// ---------------------------------------------------------------------------

function makeInternalAdapter(chunks: GatewayChunk[]): ChatAdapter & { executesToolsInternally: true } {
  return {
    executesToolsInternally: true as const,
    streamChat: async function* () {},
    callWithTools: async function* () {
      yield* chunks;
    },
  };
}

const noTools: ToolDefinition[] = [];

describe('runToolLoop – executesToolsInternally path', () => {
  it('text-only response emits text to sink and returns history', async () => {
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
  });

  it('tool_call chunk: toolCallSink is called, toolHandler is called, history gets tool messages', async () => {
    const toolCallId = 'tc-001';
    const toolArgs = JSON.stringify({ title: 'My task' });

    const adapter = makeInternalAdapter([
      { type: 'tool_call', id: toolCallId, name: 'create_item', args: toolArgs },
      { type: 'text', text: 'Done!' },
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

    // toolHandler called with parsed args
    expect(toolHandler).toHaveBeenCalledWith('create_item', { title: 'My task' });

    // history: initial user message + assistant tool_call message + tool result message
    const assistantMsg = history.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.tool_calls?.[0]).toMatchObject({
      id: toolCallId,
      name: 'create_item',
      arguments: toolArgs,
    });

    const toolResultMsg = history.find((m) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg?.content).toBe('item-created-id-123');
    expect(toolResultMsg?.tool_call_id).toBe(toolCallId);

    // text also delivered
    expect(textSink).toHaveBeenCalledWith('Done!');
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

  it('multiple tool_calls all get appended to history', async () => {
    const adapter = makeInternalAdapter([
      { type: 'tool_call', id: 'a', name: 'tool_a', args: '{"x":1}' },
      { type: 'tool_call', id: 'b', name: 'tool_b', args: '{"y":2}' },
      { type: 'done' },
    ]);

    const toolHandler = vi.fn().mockResolvedValue('ok');

    const history = await runToolLoop(
      adapter,
      [{ role: 'user', content: 'multi' }],
      noTools,
      toolHandler,
      vi.fn(),
      vi.fn()
    );

    const toolMsgs = history.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);

    const assistantMsgs = history.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
  });

  it('executeTool wrapper handles toolHandler exceptions without throwing', async () => {
    // The adapter receives executeTool in its opts — we verify that even if toolHandler
    // throws, the loop itself does not throw (the error is caught inside executeTool).
    // To test executeTool isolation, we need an adapter that actually calls opts.executeTool.
    // We simulate this with a custom adapter that invokes executeTool directly.
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
          yield { type: 'text', text: result };
        }
        yield { type: 'done' };
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
});
