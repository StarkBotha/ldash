import { useState, useEffect, useCallback } from 'react';
import { getOrCreateConversation, getConversation, streamMessage } from '../api/chat';
import type { Conversation, Message } from '../types';

export interface UseChatReturn {
  conversation: Conversation | null;
  messages: Message[];
  streamingText: string;
  isStreaming: boolean;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  dismissError: () => void;
}

export function useChat(projectId: string, itemId: string): UseChatReturn {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !itemId) return;

    let cancelled = false;

    async function init() {
      try {
        const convo = await getOrCreateConversation(projectId, itemId);
        if (cancelled) return;
        const { messages: msgs } = await getConversation(convo.id);
        if (cancelled) return;
        setConversation(convo);
        setMessages(msgs);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    init();

    return () => {
      cancelled = true;
    };
  }, [projectId, itemId]);

  const sendMessage = useCallback(async (content: string) => {
    if (isStreaming || !conversation) return;

    setIsStreaming(true);
    setStreamingText('');
    setError(null);

    const tempUserMessage: Message = {
      id: 'temp-user',
      conversation_id: conversation.id,
      role: 'user',
      content,
      tool_calls: null,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, tempUserMessage]);

    let accumulatedText = '';

    try {
      await streamMessage(conversation.id, content, (event) => {
        if (event.type === 'text') {
          accumulatedText += event.text;
          setStreamingText(accumulatedText);
        } else if (event.type === 'done') {
          const tempAssistantMessage: Message = {
            id: 'temp-assistant',
            conversation_id: conversation.id,
            role: 'assistant',
            content: accumulatedText,
            tool_calls: null,
            created_at: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, tempAssistantMessage]);
          setStreamingText('');
          setIsStreaming(false);

          // Refresh from server to get real IDs
          getConversation(conversation.id)
            .then(({ messages: serverMessages }) => {
              setMessages(serverMessages);
            })
            .catch(() => {
              // Keep temp messages if refresh fails
            });
        } else if (event.type === 'error') {
          setError(event.message);
          setIsStreaming(false);
          // Remove the optimistic user message
          setMessages((prev) => prev.filter((m) => m.id !== 'temp-user'));
        }
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setIsStreaming(false);
      setMessages((prev) => prev.filter((m) => m.id !== 'temp-user'));
    }
  }, [isStreaming, conversation]);

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  return {
    conversation,
    messages,
    streamingText,
    isStreaming,
    error,
    sendMessage,
    dismissError,
  };
}
