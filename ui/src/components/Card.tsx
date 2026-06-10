import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Item } from '../types';

interface Props {
  item: Item;
  onClick: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  epic: '#8b5cf6',
  story: '#3b82f6',
  task: '#10b981',
};

export function Card({ item, onClick }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      style={{
        background: '#fff',
        border: item.flagged ? '2px solid #f59e0b' : '1px solid #e0e0e0',
        borderRadius: 6,
        padding: 10,
        cursor: 'pointer',
        position: 'relative',
        opacity: isDragging ? 0.4 : 1,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
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
        <span style={{ fontSize: 15, flex: 1 }}>{item.title}</span>
      </div>

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
