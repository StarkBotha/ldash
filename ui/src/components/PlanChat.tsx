import { useState, useRef, useEffect } from 'react';
import { usePlanningChat } from '../hooks/usePlanningChat';

interface PlanChatProps {
  projectId: string;
}

export function PlanChat({ projectId }: PlanChatProps) {
  const { messages, streamingContent, toolCallIndicators, isStreaming, error, stallNotice, sendMessage, clearHistory, dismissStallNotice } =
    usePlanningChat(projectId);
  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const isNearBottomRef = useRef(true);

  const displayError = error ?? localError;

  // Track whether the user is near the bottom so we don't fight manual scroll-up.
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
  }

  // Snap back to bottom when a new message starts (isStreaming flips true) so the
  // user always sees the beginning of a new response, regardless of near-bottom state.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const justStarted = isStreaming && !wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (justStarted && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      isNearBottomRef.current = true;
      return;
    }
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streamingContent, toolCallIndicators.length, isStreaming]);

  async function handleSubmit() {
    const text = inputValue.trim();
    if (!text || isStreaming) return;
    setInputValue('');
    await sendMessage(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  async function handleClear() {
    if (window.confirm('Clear the planning conversation?')) {
      await clearHistory();
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface-2)' }}>
      {/* Header */}
      <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 15 }}>Planning Chat</strong>
        <button
          onClick={() => void handleClear()}
          style={{ marginLeft: 'auto', fontSize: 13, padding: '2px 8px' }}
        >
          Clear history
        </button>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {messages
          .filter(
            (msg) =>
              msg.role === 'user' ||
              (msg.role === 'assistant' && msg.content && msg.content.trim() !== '')
          )
          .map((msg, i) => (
            <div
              key={i}
              style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                background: msg.role === 'user' ? 'var(--accent)' : 'var(--surface)',
                color: msg.role === 'user' ? 'var(--on-accent)' : 'var(--text)',
                border: msg.role === 'user' ? 'none' : '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 12px',
                fontSize: 15,
                whiteSpace: 'pre-wrap',
              }}
            >
              {msg.content}
            </div>
          ))}

        {/* Streaming bubble */}
        {isStreaming && (
          <div
            style={{
              alignSelf: 'flex-start',
              maxWidth: '80%',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 15,
              whiteSpace: 'pre-wrap',
            }}
          >
            {streamingContent}
            <span style={{ display: 'inline-block', width: 8, animation: 'blink 1s step-end infinite' }}>|</span>
          </div>
        )}

        {/* Tool call indicators */}
        {toolCallIndicators.length > 0 && (
          <div style={{ alignSelf: 'flex-start', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {toolCallIndicators.map((indicator, i) => (
              <div
                key={i}
                style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                {indicator.status === 'pending' && <span>⟳</span>}
                {indicator.status === 'done' && <span style={{ color: 'var(--success)' }}>✓</span>}
                {indicator.status === 'error' && <span style={{ color: 'var(--danger)' }}>✗</span>}
                <span>{indicator.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stall notice — neutral, non-scary */}
      {stallNotice && (
        <div
          style={{
            background: 'var(--info-bg)',
            border: '1px solid var(--info-border)',
            color: 'var(--info-text)',
            padding: '8px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 14,
          }}
        >
          <span style={{ flex: 1 }}>{stallNotice}</span>
          <button
            onClick={dismissStallNotice}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--info-text)', fontWeight: 'bold' }}
          >
            ×
          </button>
        </div>
      )}

      {/* Error banner */}
      {displayError && (
        <div
          style={{
            background: 'var(--danger-bg)',
            border: '1px solid var(--danger-border)',
            color: 'var(--danger-text)',
            padding: '8px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 14,
          }}
        >
          <span style={{ flex: 1 }}>{displayError}</span>
          <button
            onClick={() => setLocalError(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger-text)', fontWeight: 'bold' }}
          >
            ×
          </button>
        </div>
      )}

      {/* Input area */}
      <div style={{ padding: 12, borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', gap: 8 }}>
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          placeholder="Describe what you want to build..."
          style={{
            flex: 1,
            resize: 'none',
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            fontSize: 15,
            minHeight: 60,
            fontFamily: 'inherit',
          }}
          rows={2}
        />
        <button
          onClick={() => void handleSubmit()}
          disabled={isStreaming || !inputValue.trim()}
          style={{
            padding: '8px 16px',
            background: isStreaming || !inputValue.trim() ? 'var(--border)' : 'var(--accent)',
            color: 'var(--on-accent)',
            border: 'none',
            borderRadius: 6,
            cursor: isStreaming || !inputValue.trim() ? 'not-allowed' : 'pointer',
            fontSize: 15,
            alignSelf: 'flex-end',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
