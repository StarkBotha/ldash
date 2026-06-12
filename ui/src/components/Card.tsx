import type { Item } from '../types';

interface Props {
  item: Item;
  parentTitle?: string;
  /** Number of direct children — only set for epics and stories */
  childCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onClick: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  epic: '#8b5cf6',
  story: '#3b82f6',
  task: '#10b981',
};

export function Card({ item, parentTitle, childCount, collapsed, onToggleCollapse, onClick }: Props) {
  const childLabel = item.type === 'epic' ? 'stories' : 'tasks';
  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        border: item.flagged ? '2px solid #f59e0b' : '1px solid #e0e0e0',
        borderRadius: 6,
        padding: 10,
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: '#fff',
          background: TYPE_COLORS[item.type] ?? '#888',
          borderRadius: 4,
          padding: '1px 6px',
          flexShrink: 0,
        }}>
          {item.type}
        </span>
        {childCount != null && childCount > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse?.();
            }}
            title={collapsed ? `Show ${childCount} ${childLabel}` : `Hide ${childCount} ${childLabel}`}
            style={{
              flexShrink: 0,
              border: '1px solid #e0e0e0',
              background: collapsed ? '#eee' : '#fff',
              borderRadius: 4,
              padding: '0 5px',
              fontSize: 12,
              color: '#666',
              cursor: 'pointer',
            }}
          >
            {collapsed ? '▸' : '▾'} {childCount}
          </button>
        )}
      </div>
      <div style={{ marginTop: 4, fontSize: 15 }}>
        <span style={{ fontSize: 12, color: '#999', fontWeight: 600, marginRight: 5 }}>{item.key}</span>
        {item.title}
      </div>
      {parentTitle && (
        <div style={{
          marginTop: 3,
          fontSize: 12,
          color: '#999',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          ↳ {parentTitle}
        </div>
      )}

      <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
        {item.flagged && (
          <span title="Flagged" style={{ fontSize: 15 }}>🚩</span>
        )}
        {item.blocked && (
          <span
            style={{
              fontSize: 12,
              color: '#fff',
              background: '#ef4444',
              borderRadius: 4,
              padding: '1px 6px',
            }}
          >
            BLOCKED
          </span>
        )}
      </div>
    </div>
  );
}
