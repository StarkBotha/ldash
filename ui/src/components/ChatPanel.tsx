import { useState, useRef, useEffect } from 'react';
import { useChat } from '../hooks/useChat';
import type { ToolCallIndicator } from '../hooks/usePlanningChat';
import type { Message } from '../types';

interface ChatPanelProps {
  projectId: string;
  itemId: string;
  providerLabel: string;
  // When true this is the whole-knowledgebase chat (itemId is ignored).
  kb?: boolean;
  placeholder?: string;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 8,
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          padding: '8px 12px',
          borderRadius: 12,
          background: isUser ? '#3b82f6' : '#f3f4f6',
          color: isUser ? '#fff' : '#1f2937',
          fontSize: 15,
        }}
      >
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{message.content}</div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4, textAlign: isUser ? 'right' : 'left' }}>
          {formatRelativeTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}

function ToolChipRow({ chips }: { chips: ToolCallIndicator[] }) {
  if (chips.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
      {chips.map((indicator, i) => (
        <div
          key={i}
          style={{ fontSize: 13, color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          {indicator.status === 'pending' && <span>⟳</span>}
          {indicator.status === 'done' && <span style={{ color: '#22c55e' }}>✓</span>}
          {indicator.status === 'error' && <span style={{ color: '#ef4444' }}>✗</span>}
          <span>{indicator.label}</span>
        </div>
      ))}
    </div>
  );
}

// Build chips for persisted assistant messages that carry tool_calls.
// tool_call_id is not persisted on tool-role messages, so results are
// correlated by order: the tool messages immediately following an assistant
// message are its results, one per call. Success uses the same encoding the
// server uses for the live tool_result event: content starting with 'Error:'.
function buildHistoryChips(messages: Message[]): Map<string, ToolCallIndicator[]> {
  const map = new Map<string, ToolCallIndicator[]>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue;
    const results: Message[] = [];
    for (
      let j = i + 1;
      j < messages.length && messages[j].role === 'tool' && results.length < msg.tool_calls.length;
      j++
    ) {
      results.push(messages[j]);
    }
    map.set(
      msg.id,
      msg.tool_calls.map((tc, k) => {
        const result = results[k];
        const status: ToolCallIndicator['status'] =
          result && result.content.startsWith('Error:') ? 'error' : 'done';
        return { toolName: tc.name, label: tc.name, status };
      })
    );
  }
  return map;
}

export function ChatPanel({ projectId, itemId, providerLabel, kb = false, placeholder }: ChatPanelProps) {
  const { conversation, messages, streamingText, toolCallIndicators, isStreaming, error, stallNotice, sendMessage, dismissError, dismissStallNotice } = useChat(projectId, itemId, kb);
  const historyChips = buildHistoryChips(messages);
  const [inputValue, setInputValue] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
  }

  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const justStarted = isStreaming && !wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (justStarted || isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, streamingText, toolCallIndicators.length, isStreaming]);

  async function handleSubmit() {
    const text = inputValue.trim();
    if (!text || isStreaming) return;
    setInputValue('');
    await sendMessage(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  if (!conversation) {
    return (
      <div style={{ padding: 20, color: '#6b7280', fontSize: 15 }}>Loading...</div>
    );
  }

  const badgeColor = providerLabel ? '#3b82f6' : '#f59e0b';
  const badgeText = providerLabel || 'No provider configured';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Provider badge */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb' }}>
        <span
          style={{
            display: 'inline-block',
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            background: badgeColor,
            borderRadius: 4,
            padding: '2px 8px',
          }}
        >
          {badgeText}
        </span>
      </div>

      {/* Message list */}
      <div ref={scrollContainerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {messages.map((msg) => {
          if (msg.role === 'tool') return null;
          const chips = historyChips.get(msg.id);
          const hasText = msg.content && msg.content.trim() !== '';
          if (msg.role === 'assistant' && !hasText && !chips) return null;
          return (
            <div key={msg.id}>
              {(msg.role === 'user' || hasText) && <MessageBubble message={msg} />}
              {chips && <ToolChipRow chips={chips} />}
            </div>
          );
        })}

        {isStreaming && streamingText && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
            <div
              style={{
                maxWidth: '80%',
                padding: '8px 12px',
                borderRadius: 12,
                background: '#f3f4f6',
                color: '#1f2937',
                fontSize: 15,
              }}
            >
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{streamingText}</span>
              <span
                style={{
                  display: 'inline-block',
                  animation: 'blink 1s step-end infinite',
                  marginLeft: 2,
                }}
              >
                |
              </span>
            </div>
          </div>
        )}

        {isStreaming && !streamingText && (
          <div style={{ color: '#9ca3af', fontSize: 14, padding: '4px 12px' }}>Thinking...</div>
        )}

        {/* Live tool call indicators (cleared once server history is re-synced) */}
        <ToolChipRow chips={toolCallIndicators} />

        <div ref={bottomRef} />
      </div>

      {/* Stall notice — neutral, non-scary */}
      {stallNotice && (
        <div
          style={{
            padding: '8px 12px',
            background: '#f0f9ff',
            borderTop: '1px solid #bae6fd',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ color: '#0369a1', fontSize: 14 }}>{stallNotice}</span>
          <button
            onClick={dismissStallNotice}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#0369a1',
              fontWeight: 600,
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: '8px 12px',
            background: '#fef2f2',
            borderTop: '1px solid #fecaca',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ color: '#991b1b', fontSize: 14 }}>{error}</span>
          <button
            onClick={dismissError}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#991b1b',
              fontWeight: 600,
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Input area */}
      <div style={{ padding: '8px 12px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8 }}>
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          rows={2}
          placeholder={placeholder ?? 'Ask about this item... (Enter to send, Shift+Enter for newline)'}
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: 14,
            borderRadius: 6,
            border: '1px solid #d1d5db',
            resize: 'none',
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={isStreaming || !inputValue.trim()}
          style={{
            padding: '6px 16px',
            background: isStreaming ? '#9ca3af' : '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: isStreaming ? 'not-allowed' : 'pointer',
            fontSize: 14,
            alignSelf: 'flex-end',
          }}
        >
          Send
        </button>
      </div>

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
