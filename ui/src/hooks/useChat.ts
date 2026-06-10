import { useState, useEffect, useCallback } from 'react';
import { getOrCreateConversation, getConversation, streamMessage } from '../api/chat';
import type { Conversation, Message } from '../types';

const INACTIVITY_TIMEOUT_MS = 120_000;

export interface UseChatReturn {
  conversation: Conversation | null;
  messages: Message[];
  streamingText: string;
  isStreaming: boolean;
  error: string | null;
  stallNotice: string | null;
  sendMessage: (content: string) => Promise<void>;
  dismissError: () => void;
  dismissStallNotice: () => void;
}

export function useChat(projectId: string, itemId: string): UseChatReturn {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stallNotice, setStallNotice] = useState<string | null>(null);

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
    setStallNotice(null);

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

    const abortController = new AbortController();
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

    function resetWatchdog() {
      if (watchdogTimer !== null) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        abortController.abort();
      }, INACTIVITY_TIMEOUT_MS);
    }

    function clearWatchdog() {
      if (watchdogTimer !== null) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    }

    // Called on any abnormal end: stall, stream-ended-without-done, network error
    async function gracefulFinalize(convId: string) {
      clearWatchdog();
      setStreamingText('');
      setIsStreaming(false);
      try {
        const { messages: serverMessages } = await getConversation(convId);
        setMessages(serverMessages);
        setStallNotice('Connection dropped — showing saved history.');
      } catch {
        setStallNotice('Connection dropped — showing saved history.');
      }
    }

    // Start watchdog once we begin streaming
    resetWatchdog();

    try {
      await streamMessage(
        conversation.id,
        content,
        (event) => {
          // Each received chunk resets the inactivity timer
          resetWatchdog();

          if (event.type === 'text') {
            accumulatedText += event.text;
            setStreamingText(accumulatedText);
          } else if (event.type === 'done') {
            clearWatchdog();
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
            clearWatchdog();
            setError(event.message);
            setIsStreaming(false);
            // Remove the optimistic user message
            setMessages((prev) => prev.filter((m) => m.id !== 'temp-user'));
          }
        },
        abortController.signal
      );

      // streamMessage resolved without a 'done' callback — the reader loop
      // exited normally (reader returned done=true) but onChunk('done') was NOT
      // called from inside the loop (it calls onChunk({ type:'done' }) at the
      // bottom as a fallback). If isStreaming is still true here we treat it as
      // an abnormal end.
      // NOTE: streamMessage already emits a synthetic done at the end of the
      // loop, so this path only fires if that synthetic done did not clear
      // isStreaming (i.e. the callback path above didn't run). Capture the
      // conversation id before the await so it's safe to use in the closure.
    } catch (err: unknown) {
      const isAbort =
        err instanceof DOMException && err.name === 'AbortError';

      if (isAbort) {
        await gracefulFinalize(conversation.id);
      } else {
        clearWatchdog();
        setError(err instanceof Error ? err.message : String(err));
        setIsStreaming(false);
        setMessages((prev) => prev.filter((m) => m.id !== 'temp-user'));
      }
    }
  }, [isStreaming, conversation]);

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  const dismissStallNotice = useCallback(() => {
    setStallNotice(null);
  }, []);

  return {
    conversation,
    messages,
    streamingText,
    isStreaming,
    error,
    stallNotice,
    sendMessage,
    dismissError,
    dismissStallNotice,
  };
}
