import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardEvent } from '../types';

export type SSEStatus = 'connected' | 'reconnecting' | 'error';

function invalidateForEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  event: BoardEvent
): void {
  const { type, entityId, data } = event;

  switch (type) {
    case 'item.created':
      queryClient.invalidateQueries({ queryKey: ['items', projectId] });
      break;

    case 'item.updated':
    case 'item.flagged':
    case 'item.unflagged':
    case 'item.blocked':
    case 'item.unblocked':
      queryClient.invalidateQueries({ queryKey: ['items', projectId] });
      queryClient.invalidateQueries({ queryKey: ['item', entityId] });
      break;

    case 'item.moved':
      queryClient.invalidateQueries({ queryKey: ['items', projectId] });
      queryClient.invalidateQueries({ queryKey: ['item', entityId] });
      queryClient.invalidateQueries({ queryKey: ['activity', 'item', entityId] });
      break;

    case 'item.deleted':
      queryClient.invalidateQueries({ queryKey: ['items', projectId] });
      queryClient.invalidateQueries({ queryKey: ['activity', 'project', projectId] });
      break;

    case 'comment.created': {
      const comment = data.comment as { item_id?: string } | undefined;
      const itemId = comment?.item_id ?? entityId;
      queryClient.invalidateQueries({ queryKey: ['comments', itemId] });
      queryClient.invalidateQueries({ queryKey: ['activity', 'item', itemId] });
      break;
    }

    case 'attachment.created':
    case 'attachment.deleted':
      queryClient.invalidateQueries({ queryKey: ['attachments', entityId] });
      break;

    case 'project.created':
    case 'project.updated':
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects', entityId] });
      break;

    case 'project.deleted':
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      break;

    case 'column.created':
    case 'column.updated':
    case 'column.reordered':
      queryClient.invalidateQueries({ queryKey: ['columns'] });
      break;
  }
}

function invalidateAll(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string
): void {
  queryClient.invalidateQueries({ queryKey: ['items', projectId] });
  queryClient.invalidateQueries({ queryKey: ['columns'] });
  queryClient.invalidateQueries({ queryKey: ['activity', 'project', projectId] });
}

export function useSSE(projectId: string | null): { status: SSEStatus } {
  const [status, setStatus] = useState<SSEStatus>('reconnecting');
  const queryClient = useQueryClient();
  const isFirstOpen = useRef(true);

  useEffect(() => {
    if (projectId === null) {
      return;
    }

    isFirstOpen.current = true;
    let es: EventSource | null = null;
    let retryTimer: number | undefined;
    let disposed = false;

    const connect = () => {
      es = new EventSource(`/api/sse?projectId=${encodeURIComponent(projectId)}`);

      es.onopen = () => {
        if (isFirstOpen.current) {
          isFirstOpen.current = false;
        } else {
          // Reconnected after a gap — refetch everything
          invalidateAll(queryClient, projectId);
        }
        setStatus('connected');
      };

      es.addEventListener('board', (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as BoardEvent;
          invalidateForEvent(queryClient, projectId, event);
        } catch {
          // ignore malformed event
        }
      });

      es.onerror = () => {
        setStatus('reconnecting');
        // EventSource only auto-retries network blips; a non-event-stream
        // response (e.g. the dev proxy's 500 during a server restart) closes
        // it permanently — recreate it ourselves after a backoff.
        if (es?.readyState === EventSource.CLOSED && !disposed) {
          es.close();
          retryTimer = window.setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      es?.close();
    };
  }, [projectId, queryClient]);

  return { status };
}
