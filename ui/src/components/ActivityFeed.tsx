import { useItemActivity } from '../hooks/useItemDetail';
import type { ActivityEntry } from '../types';

interface Props {
  itemId: string;
}

function humaniseEvent(entry: ActivityEntry): string {
  const p = entry.payload as Record<string, unknown>;
  switch (entry.event_type) {
    case 'item.created': return `Item created in ${p.column_id ?? 'unknown column'}`;
    case 'item.updated': return 'Item updated';
    case 'item.moved':
      return `Moved from ${p.from_column_name ?? p.from_column_id} to ${p.to_column_name ?? p.to_column_id}`;
    case 'item.flagged': return 'Item flagged';
    case 'item.unflagged': return 'Item unflagged';
    case 'item.blocked': return `Item blocked: ${p.reason ?? ''}`;
    case 'item.unblocked': return 'Item unblocked';
    case 'item.deleted': return 'Item deleted';
    case 'comment.created': return 'Comment added';
    default: return entry.event_type;
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function ActivityFeed({ itemId }: Props) {
  const { data, isLoading } = useItemActivity(itemId);

  if (isLoading) return <div style={{ fontSize: 14, color: 'var(--text-2)' }}>Loading activity…</div>;

  // API returns newest-first; reverse for chronological display in UI
  const entries = [...(data?.entries ?? [])].reverse();

  if (entries.length === 0) {
    return <div style={{ fontSize: 14, color: 'var(--text-2)' }}>No activity yet.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {entries.map((entry) => (
        <div key={entry.id} style={{ fontSize: 14, display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ color: 'var(--text-2)', flexShrink: 0 }}>{relativeTime(entry.created_at)}</span>
          <span>{humaniseEvent(entry)}</span>
        </div>
      ))}
    </div>
  );
}
