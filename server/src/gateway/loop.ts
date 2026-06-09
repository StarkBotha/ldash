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
  const maxTurns = options?.maxTurns ?? 10;
  const history: ChatMessage[] = [...messages];

  for (let turn = 0; turn < maxTurns; turn++) {
    const pendingCalls: PendingToolCall[] = [];

    // Iterate over chunks from this turn
    for await (const chunk of adapter.callWithTools(history, tools)) {
      if (chunk.type === 'text') {
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

    // If no tool calls, LLM has finished
    if (pendingCalls.length === 0) {
      break;
    }

    // Build assistant message with pending tool calls
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: '',
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
