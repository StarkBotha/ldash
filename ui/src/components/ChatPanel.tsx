import { useState, useRef, useEffect } from 'react';
import { useChat } from '../hooks/useChat';
import type { Message } from '../types';

interface ChatPanelProps {
  projectId: string;
  itemId: string;
  providerLabel: string;
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
          fontSize: 14,
        }}
      >
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{message.content}</div>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4, textAlign: isUser ? 'right' : 'left' }}>
          {formatRelativeTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}

export function ChatPanel({ projectId, itemId, providerLabel }: ChatPanelProps) {
  const { conversation, messages, streamingText, isStreaming, error, sendMessage, dismissError } = useChat(projectId, itemId);
  const [inputValue, setInputValue] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

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
      <div style={{ padding: 20, color: '#6b7280', fontSize: 14 }}>Loading...</div>
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
            fontSize: 11,
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
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isStreaming && streamingText && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
            <div
              style={{
                maxWidth: '80%',
                padding: '8px 12px',
                borderRadius: 12,
                background: '#f3f4f6',
                color: '#1f2937',
                fontSize: 14,
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
          <div style={{ color: '#9ca3af', fontSize: 13, padding: '4px 12px' }}>Thinking...</div>
        )}

        <div ref={bottomRef} />
      </div>

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
          <span style={{ color: '#991b1b', fontSize: 13 }}>{error}</span>
          <button
            onClick={dismissError}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#991b1b',
              fontWeight: 600,
              fontSize: 13,
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
          placeholder="Ask about this item... (Enter to send, Shift+Enter for newline)"
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: 13,
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
            fontSize: 13,
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
