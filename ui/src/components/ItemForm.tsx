import { useState } from 'react';
import { useCreateItem, useUpdateItem } from '../hooks/useBoard';
import type { Item, Column, ItemType } from '../types';

interface Props {
  projectId: string;
  columnId: string;
  columns: Column[];
  items: Item[];
  item?: Item;
  onClose: () => void;
}

export function ItemForm({ projectId, columnId, columns, items, item, onClose }: Props) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [type, setType] = useState<ItemType>(item?.type ?? 'task');
  const [description, setDescription] = useState(item?.description ?? '');
  const [parentId, setParentId] = useState<string>(item?.parent_id ?? '');
  const [colId, setColId] = useState(item?.column_id ?? columnId);
  const [error, setError] = useState('');

  const createItem = useCreateItem();
  const updateItem = useUpdateItem();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    try {
      if (item) {
        await updateItem.mutateAsync({
          id: item.id,
          projectId,
          data: {
            title,
            description,
            parent_id: parentId || null,
          },
        });
      } else {
        await createItem.mutateAsync({
          project_id: projectId,
          parent_id: parentId || null,
          type,
          title,
          description,
          column_id: colId,
        });
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  };

  const modalStyle: React.CSSProperties = {
    background: '#fff', borderRadius: 8, padding: 24, width: 480, maxWidth: '90vw',
    maxHeight: '90vh', overflowY: 'auto',
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 16px' }}>{item ? 'Edit item' : 'New item'}</h2>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', marginBottom: 4 }}>Title *</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
              autoFocus
            />
          </div>

          {!item && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', marginBottom: 4 }}>Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ItemType)}
                style={{ width: '100%', padding: 8 }}
              >
                <option value="epic">Epic</option>
                <option value="story">Story</option>
                <option value="task">Task</option>
              </select>
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', marginBottom: 4 }}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', marginBottom: 4 }}>Parent item (optional)</label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              style={{ width: '100%', padding: 8 }}
            >
              <option value="">None</option>
              {items
                .filter((i) => i.id !== item?.id)
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    [{i.type}] {i.title}
                  </option>
                ))}
            </select>
          </div>

          {!item && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', marginBottom: 4 }}>Column</label>
              <select
                value={colId}
                onChange={(e) => setColId(e.target.value)}
                style={{ width: '100%', padding: 8 }}
              >
                {columns.map((col) => (
                  <option key={col.id} value={col.id}>{col.name}</option>
                ))}
              </select>
            </div>
          )}

          {error && <p style={{ color: 'red', marginBottom: 12 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit">{item ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
