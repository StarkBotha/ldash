export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export type GatewayChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface CallOptions {
  model?: string;
  maxTokens?: number;
}

export interface ChatAdapter {
  streamChat(
    messages: ChatMessage[],
    opts?: CallOptions
  ): AsyncIterable<GatewayChunk>;

  callWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: CallOptions
  ): AsyncIterable<GatewayChunk>;
}
