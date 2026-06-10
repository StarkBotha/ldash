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

  const displayError = error ?? localError;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingContent]);

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fafafa' }}>
      {/* Header */}
      <div style={{ padding: '8px 16px', borderBottom: '1px solid #ddd', background: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
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
                background: msg.role === 'user' ? '#0070f3' : '#fff',
                color: msg.role === 'user' ? '#fff' : '#333',
                border: msg.role === 'user' ? 'none' : '1px solid #ddd',
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
              background: '#fff',
              border: '1px solid #ddd',
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
                style={{ fontSize: 13, color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                {indicator.status === 'pending' && <span>⟳</span>}
                {indicator.status === 'done' && <span style={{ color: '#22c55e' }}>✓</span>}
                {indicator.status === 'error' && <span style={{ color: '#ef4444' }}>✗</span>}
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
            background: '#f0f9ff',
            border: '1px solid #bae6fd',
            color: '#0369a1',
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
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#0369a1', fontWeight: 'bold' }}
          >
            ×
          </button>
        </div>
      )}

      {/* Error banner */}
      {displayError && (
        <div
          style={{
            background: '#fee2e2',
            border: '1px solid #fca5a5',
            color: '#dc2626',
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
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontWeight: 'bold' }}
          >
            ×
          </button>
        </div>
      )}

      {/* Input area */}
      <div style={{ padding: 12, borderTop: '1px solid #ddd', background: '#fff', display: 'flex', gap: 8 }}>
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
            border: '1px solid #ddd',
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
            background: isStreaming || !inputValue.trim() ? '#d1d5db' : '#0070f3',
            color: '#fff',
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
