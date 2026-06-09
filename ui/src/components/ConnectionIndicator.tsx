import type { ReactElement } from 'react';
import type { SSEStatus } from '../hooks/useSSE';

interface ConnectionIndicatorProps {
  status: SSEStatus;
}

export function ConnectionIndicator({ status }: ConnectionIndicatorProps): ReactElement | null {
  if (status === 'connected') {
    return null;
  }

  const text = status === 'reconnecting' ? 'Reconnecting…' : 'Connection error';

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        background: '#f59e0b',
        color: '#fff',
        padding: '6px 14px',
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 600,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    >
      {text}
    </div>
  );
}
