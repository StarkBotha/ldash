import { useState } from 'react';
import { useCreateItem, useUpdateItem } from '../hooks/useBoard';
import { useAttachments, useUploadAttachment } from '../hooks/useItemDetail';
import { api } from '../api/client';
import { logClientError } from '../clientLog';
import { isWorkItemType, WORK_ITEM_TYPES } from '../types';
import type { Item, Column, ItemType } from '../types';

interface Props {
  projectId: string;
  columnId: string;
  columns: Column[];
  items: Item[];
  item?: Item;
  /** Pre-selected type for a new item (ignored when editing). Defaults to task. */
  defaultType?: ItemType;
  /** Pre-selected parent for a new item (ignored when editing). */
  defaultParentId?: string;
  onClose: () => void;
}

export function ItemForm({ projectId, columnId, columns, items, item, defaultType, defaultParentId, onClose }: Props) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [type, setType] = useState<ItemType>(item?.type ?? defaultType ?? 'task');
  const [description, setDescription] = useState(item?.description ?? '');
  const [parentId, setParentId] = useState<string>(item?.parent_id ?? defaultParentId ?? '');
  const [colId, setColId] = useState(item?.column_id ?? columnId);
  const [error, setError] = useState('');

  const createItem = useCreateItem();
  const updateItem = useUpdateItem();
  const [uploadingCount, setUploadingCount] = useState(0);
  // Images pasted while creating a new item — held locally and uploaded right
  // after the item is created (no id exists to attach to before that).
  const [pendingImages, setPendingImages] = useState<
    { filename?: string; mime: string; dataUrl: string }[]
  >([]);
  const { data: attachmentData } = useAttachments(item?.id ?? '');
  const attachments = attachmentData?.attachments ?? [];
  const uploadAttachment = useUploadAttachment();

  function base64Of(dataUrl: string): string {
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const imageItems = Array.from(e.clipboardData.items).filter((it) =>
      it.type.startsWith('image/')
    );
    if (imageItems.length === 0) return; // normal text paste — leave it alone
    e.preventDefault();
    for (const clipItem of imageItems) {
      const file = clipItem.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        if (!item) {
          setPendingImages((prev) => [
            ...prev,
            { filename: file.name || undefined, mime: file.type, dataUrl },
          ]);
          return;
        }
        setUploadingCount((n) => n + 1);
        try {
          await uploadAttachment.mutateAsync({
            itemId: item.id,
            data: { filename: file.name || undefined, mime: file.type, data_base64: base64Of(dataUrl) },
          });
        } catch {
          // upload failed — thumbnail simply won't appear
        } finally {
          setUploadingCount((n) => n - 1);
        }
      };
      reader.readAsDataURL(file);
    }
  }

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
            ...(isWorkItemType(item.type) && type !== item.type ? { type } : {}),
          },
        });
      } else {
        const created = await createItem.mutateAsync({
          project_id: projectId,
          parent_id: parentId || null,
          type,
          title,
          description,
          column_id: colId,
        });
        for (const img of pendingImages) {
          try {
            await uploadAttachment.mutateAsync({
              itemId: created.id,
              data: { filename: img.filename, mime: img.mime, data_base64: base64Of(img.dataUrl) },
            });
          } catch (uploadErr) {
            // item is already created — don't fail the whole submit over an image
            logClientError(`attachment upload after item create failed: ${(uploadErr as Error).message}`);
          }
        }
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Parent options: only stories/epics whose derived status is Backlog or
  // In Progress — the first two non-cancelled columns by position (mirrors the
  // server rollup, where index 0 = not-started, index 1 = in-progress).
  const activeCols = [...columns]
    .filter((c) => c.role !== 'cancelled')
    .sort((a, b) => a.position - b.position);
  const parentableColIds = new Set([activeCols[0]?.id, activeCols[1]?.id].filter(Boolean));
  const parentCandidates = items.filter(
    (i) =>
      (i.type === 'story' || i.type === 'epic') &&
      i.id !== item?.id &&
      parentableColIds.has(i.column_id)
  );
  // Keep the currently-selected parent visible even if it falls outside the
  // filter (editing an item whose parent is now Done, or a "+"-add launched
  // from a Done story) so it isn't silently dropped on save.
  const selectedParent = parentId ? items.find((i) => i.id === parentId) : undefined;
  const parentOptions =
    selectedParent && !parentCandidates.some((i) => i.id === selectedParent.id)
      ? [selectedParent, ...parentCandidates]
      : parentCandidates;

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
      <div style={modalStyle} onClick={(e) => e.stopPropagation()} onPaste={handlePaste}>
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

          {!item ? (
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
                <option value="bug">Bug</option>
                <option value="investigation">Investigation</option>
              </select>
            </div>
          ) : isWorkItemType(item.type) && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', marginBottom: 4 }}>Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ItemType)}
                style={{ width: '100%', padding: 8 }}
              >
                {WORK_ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
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
            {(attachments.length > 0 || pendingImages.length > 0 || uploadingCount > 0) && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {attachments.map((a) => (
                  <img
                    key={a.id}
                    src={api.attachments.url(a.id)}
                    alt={a.filename}
                    title={a.filename}
                    style={{ height: 40, width: 40, objectFit: 'cover', borderRadius: 4, border: '1px solid #e5e7eb' }}
                  />
                ))}
                {pendingImages.map((img, i) => (
                  <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
                    <img
                      src={img.dataUrl}
                      alt={img.filename ?? 'pasted image'}
                      title={`${img.filename ?? 'pasted image'} — uploads when you press Create`}
                      style={{ height: 40, width: 40, objectFit: 'cover', borderRadius: 4, border: '1px dashed #9ca3af' }}
                    />
                    <button
                      type="button"
                      onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                      title="Remove"
                      style={{
                        position: 'absolute', top: -6, right: -6, width: 16, height: 16,
                        borderRadius: '50%', border: 'none', background: '#374151', color: '#fff',
                        fontSize: 10, lineHeight: '16px', padding: 0, cursor: 'pointer',
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                {uploadingCount > 0 && (
                  <span style={{ fontSize: 12, color: '#6b7280', alignSelf: 'center' }}>
                    Uploading {uploadingCount} image{uploadingCount > 1 ? 's' : ''}…
                  </span>
                )}
              </div>
            )}
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#9ca3af' }}>
              {item
                ? 'Paste an image (Ctrl+V) to attach it to this ticket.'
                : 'Paste an image (Ctrl+V) to attach it — it uploads when you press Create.'}
            </p>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', marginBottom: 4 }}>Parent item (optional)</label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              style={{ width: '100%', padding: 8 }}
            >
              <option value="">None</option>
              {parentOptions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.key} [{i.type}] {i.title}
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
