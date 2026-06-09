import { useState, useEffect, useCallback } from 'react';
import { sendPlanningMessage, fetchPlanningHistory, clearPlanningHistory } from '../api/planning';
import type { ChatMessage, PlanningStreamEvent } from '../types';

export interface ToolCallIndicator {
  toolName: string;
  label: string;
  status: 'pending' | 'done' | 'error';
}

export interface UsePlanningChatReturn {
  messages: ChatMessage[];
  streamingContent: string;
  toolCallIndicators: ToolCallIndicator[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  clearHistory: () => Promise<void>;
}

export function usePlanningChat(projectId: string): UsePlanningChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [toolCallIndicators, setToolCallIndicators] = useState<ToolCallIndicator[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    fetchPlanningHistory(projectId)
      .then(({ messages: msgs }) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (isStreaming) return;

      setIsStreaming(true);
      setStreamingContent('');
      setToolCallIndicators([]);
      setError(null);

      // Optimistic user message
      setMessages((prev) => [...prev, { role: 'user', content }]);

      let accumulatedText = '';

      try {
        const response = await sendPlanningMessage(projectId, content);
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error((errBody as { error: string }).error);
        }

        const body = response.body;
        if (!body) {
          setIsStreaming(false);
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
              let event: PlanningStreamEvent;
              try {
                event = JSON.parse(line) as PlanningStreamEvent;
              } catch {
                continue;
              }

              if (event.type === 'text') {
                accumulatedText += event.content;
                setStreamingContent(accumulatedText);
              } else if (event.type === 'tool_call') {
                setToolCallIndicators((prev) => [
                  ...prev,
                  { toolName: event.toolName, label: event.label, status: 'pending' },
                ]);
              } else if (event.type === 'tool_result') {
                setToolCallIndicators((prev) => {
                  const copy = [...prev];
                  // Find the most recent pending indicator with matching toolName
                  for (let i = copy.length - 1; i >= 0; i--) {
                    if (copy[i].toolName === event.toolName && copy[i].status === 'pending') {
                      copy[i] = { ...copy[i], status: event.success ? 'done' : 'error' };
                      break;
                    }
                  }
                  return copy;
                });
              } else if (event.type === 'done') {
                setMessages((prev) => [
                  ...prev,
                  { role: 'assistant', content: accumulatedText },
                ]);
                setStreamingContent('');
                setIsStreaming(false);
                reader.cancel();
                return;
              } else if (event.type === 'error') {
                setError(event.message);
                setIsStreaming(false);
                reader.cancel();
                return;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Stream ended without a 'done' event
        if (accumulatedText) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: accumulatedText },
          ]);
        }
        setStreamingContent('');
        setIsStreaming(false);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Network error');
        setIsStreaming(false);
        // Remove the optimistic user message
        setMessages((prev) => {
          const copy = [...prev];
          // Remove last user message that was added optimistically
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'user' && copy[i].content === content) {
              copy.splice(i, 1);
              break;
            }
          }
          return copy;
        });
      }
    },
    [isStreaming, projectId]
  );

  const clearHistory = useCallback(async () => {
    await clearPlanningHistory(projectId);
    setMessages([]);
    setStreamingContent('');
    setToolCallIndicators([]);
    setError(null);
  }, [projectId]);

  return {
    messages,
    streamingContent,
    toolCallIndicators,
    isStreaming,
    error,
    sendMessage,
    clearHistory,
  };
}
