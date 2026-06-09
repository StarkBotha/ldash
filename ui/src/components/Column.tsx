import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Card } from './Card';
import type { Column as ColumnType, Item } from '../types';

interface Props {
  column: ColumnType;
  items: Item[];
  onCardClick: (item: Item) => void;
  onNewItem: () => void;
}

export function Column({ column, items, onCardClick, onNewItem }: Props) {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const itemIds = sorted.map((item) => item.id);

  const { setNodeRef } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        width: 280,
        flexShrink: 0,
        background: '#f5f5f5',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '100%',
      }}
    >
      <div style={{
        padding: '10px 12px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid #e0e0e0',
      }}>
        <span style={{ fontWeight: 600 }}>{column.name}</span>
        <span style={{ color: '#888', fontSize: 13 }}>{items.length}</span>
        <button
          onClick={onNewItem}
          style={{ marginLeft: 8, padding: '2px 8px', fontSize: 16, cursor: 'pointer' }}
          title={`Add item to ${column.name}`}
        >
          +
        </button>
      </div>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sorted.map((item) => (
            <Card key={item.id} item={item} onClick={() => onCardClick(item)} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
