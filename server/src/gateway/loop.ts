import type { ChatAdapter, ChatMessage, ToolDefinition } from './types.js';

export interface PendingToolCall {
  id: string;
  name: string;
  args: string; // raw JSON string from the chunk
}

export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

export type TextSink = (chunk: string) => void;

export type ToolCallSink = (call: PendingToolCall) => void;

export async function runToolLoop(
  adapter: ChatAdapter,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  toolHandler: ToolHandler,
  textSink: TextSink,
  toolCallSink: ToolCallSink,
  options?: { maxTurns?: number }
): Promise<ChatMessage[]> {
  const history: ChatMessage[] = [...messages];

  // ---------------------------------------------------------------------------
  // Internal-execution path (e.g. ClaudeAdapter via Agent SDK)
  // The adapter handles all tool round-trips internally. We provide executeTool
  // and forward chunks to the sinks; no multi-round management needed.
  // ---------------------------------------------------------------------------
  if (adapter.executesToolsInternally) {
    let textBuffer = '';
    // Track the last enqueued tool_call id so the result can correlate with it
    let lastToolCallId: string | null = null;

    // executeTool wraps the toolHandler, appends tool messages to history,
    // and is called ONLY by the adapter's MCP handler (not by the chunk consumer).
    const executeTool = async (name: string, argsStr: string): Promise<string> => {
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(argsStr) as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }

      let resultStr: string;
      try {
        resultStr = await toolHandler(name, parsedArgs);
      } catch (err: unknown) {
        resultStr = 'Error: ' + (err instanceof Error ? err.message : String(err));
      }

      // Append the tool result message; correlate with the last pushed tool_call id
      const toolCallId = lastToolCallId ?? `${name}-result`;
      history.push({
        role: 'tool',
        content: resultStr,
        tool_call_id: toolCallId,
      });

      return resultStr;
    };

    for await (const chunk of adapter.callWithTools(history, tools, { executeTool })) {
      if (chunk.type === 'text') {
        textBuffer += chunk.text;
        textSink(chunk.text);
      } else if (chunk.type === 'tool_call') {
        // Flush any accumulated text before the tool_call as a standalone assistant message
        if (textBuffer.trim()) {
          history.push({ role: 'assistant', content: textBuffer });
          textBuffer = '';
        }

        const pending: PendingToolCall = { id: chunk.id, name: chunk.name, args: chunk.args };
        toolCallSink(pending);

        // Append the assistant tool_call message to history
        lastToolCallId = chunk.id;
        history.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: chunk.id, name: chunk.name, arguments: chunk.args }],
        });

        // NOTE: The tool RESULT is appended inside executeTool (called by the adapter's
        // MCP handler). We do NOT call toolHandler here — that would be double execution.
      } else if (chunk.type === 'error') {
        throw new Error(chunk.message);
      } else if (chunk.type === 'done') {
        // Flush any remaining text as a final assistant message
        if (textBuffer.trim()) {
          history.push({ role: 'assistant', content: textBuffer });
          textBuffer = '';
        }
        break;
      }
    }

    // Final flush in case the generator ended without a done chunk
    if (textBuffer.trim()) {
      history.push({ role: 'assistant', content: textBuffer });
    }

    return history;
  }

  // ---------------------------------------------------------------------------
  // Multi-round path (e.g. OpenAIAdapter) — unchanged
  // ---------------------------------------------------------------------------
  const maxTurns = options?.maxTurns ?? 10;

  for (let turn = 0; turn < maxTurns; turn++) {
    const pendingCalls: PendingToolCall[] = [];
    let turnText = '';

    // Iterate over chunks from this turn
    for await (const chunk of adapter.callWithTools(history, tools)) {
      if (chunk.type === 'text') {
        turnText += chunk.text;
        textSink(chunk.text);
      } else if (chunk.type === 'tool_call') {
        const pending: PendingToolCall = { id: chunk.id, name: chunk.name, args: chunk.args };
        pendingCalls.push(pending);
        toolCallSink(pending);
      } else if (chunk.type === 'error') {
        throw new Error(chunk.message);
      } else if (chunk.type === 'done') {
        break;
      }
    }

    // If no tool calls, LLM has finished naturally
    if (pendingCalls.length === 0) {
      // Persist any text from this final turn as an assistant message
      if (turnText) {
        history.push({ role: 'assistant', content: turnText });
      }
      break;
    }

    // Build assistant message with pending tool calls; carry turn text as content
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: turnText,
      tool_calls: pendingCalls.map((pc) => ({
        id: pc.id,
        name: pc.name,
        arguments: pc.args,
      })),
    };
    history.push(assistantMessage);

    // Execute each tool call and append results
    for (const call of pendingCalls) {
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(call.args) as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }

      let resultString: string;
      try {
        resultString = await toolHandler(call.name, parsedArgs);
      } catch (err: unknown) {
        resultString = 'Error: ' + (err instanceof Error ? err.message : String(err));
      }

      history.push({
        role: 'tool',
        content: resultString,
        tool_call_id: call.id,
      });
    }
  }

  // Safety valve: if we exhausted maxTurns without the LLM finishing naturally
  // Check if the last message is still a tool result (meaning we hit the limit)
  const lastMsg = history[history.length - 1];
  if (lastMsg && lastMsg.role === 'tool') {
    history.push({
      role: 'assistant',
      content: '[Planning loop reached maximum turns]',
    });
  }

  return history;
}
