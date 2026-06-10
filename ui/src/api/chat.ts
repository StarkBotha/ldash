import type { Conversation, Message, ChatStreamEvent } from '../types';

export async function getOrCreateConversation(
  projectId: string,
  itemId?: string
): Promise<Conversation> {
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, itemId }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json() as Promise<Conversation>;
}

export async function getConversation(
  conversationId: string
): Promise<{ conversation: Conversation; messages: Message[] }> {
  const res = await fetch(`/api/conversations/${conversationId}`);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json() as Promise<{ conversation: Conversation; messages: Message[] }>;
}

export async function streamMessage(
  conversationId: string,
  content: string,
  onChunk: (event: ChatStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({ content }),
    signal,
  });

  if (!res.ok) throw new Error('HTTP ' + res.status);

  const body = res.body;
  if (!body) {
    onChunk({ type: 'done' });
    return;
  }

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
        if (line.trim() === '') continue;
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice('data: '.length);
        let event: ChatStreamEvent;
        try {
          event = JSON.parse(jsonStr) as ChatStreamEvent;
        } catch {
          continue;
        }
        onChunk(event);
        if (event.type === 'done') {
          reader.cancel();
          return;
        }
        if (event.type === 'error') {
          reader.cancel();
          throw new Error(event.message);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  onChunk({ type: 'done' });
}
