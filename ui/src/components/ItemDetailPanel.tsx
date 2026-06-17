import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMoveItem, useFlagItem, useBlockItem, useDeleteItem, useUpdateItem } from '../hooks/useBoard';
import { useAttachments, useUploadAttachment, useDeleteAttachment } from '../hooks/useItemDetail';
import { useProject } from '../hooks/useProjects';
import { api } from '../api/client';
import { CommentBox } from './CommentBox';
import { KbLinkedText } from './KbLinkedText';
import { ActivityFeed } from './ActivityFeed';
import { ChatPanel } from './ChatPanel';
import { getSettings } from '../api/settings';
import { TYPE_COLORS } from './Card';
import { isWorkItemType, WORK_ITEM_TYPES } from '../types';
import type { Item, Column, ItemType } from '../types';

interface Props {
  item: Item;
  columns: Column[];
  projectId: string;
  onClose: () => void;
  onEdit: (item: Item) => void;
  onDeleted: () => void;
}

type Tab = 'details' | 'comments' | 'chat';

export function ItemDetailPanel({ item, columns, projectId, onClose, onEdit, onDeleted }: Props) {
  const moveItem = useMoveItem();
  const updateItem = useUpdateItem();
  const flagItem = useFlagItem();
  const blockItem = useBlockItem();
  const deleteItem = useDeleteItem();
  const [showBlockReason, setShowBlockReason] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('details');
  const [uploadingCount, setUploadingCount] = useState(0);
  const { data: attachmentsData } = useAttachments(item.id);
  const attachments = attachmentsData?.attachments ?? [];
  const uploadAttachment = useUploadAttachment();
  const deleteAttachment = useDeleteAttachment();

  const { data: project } = useProject(projectId);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: 30_000,
  });

  const providerLabel = (() => {
    if (!settings || !settings.activeProvider) return '';
    const active = settings.providers.find((p) => p.name === settings.activeProvider);
    if (!active) return '';
    const modelPart = active.model || 'sonnet';
    return `${active.name} / ${modelPart}`;
  })();

  async function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    await moveItem.mutateAsync({ id: item.id, projectId, data: { column_id: e.target.value } });
  }

  async function handleTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    await updateItem.mutateAsync({ id: item.id, projectId, data: { type: e.target.value as ItemType } });
  }

  async function handleFlagToggle() {
    await flagItem.mutateAsync({ id: item.id, projectId, flagged: !item.flagged });
  }

  async function handleBlockToggle() {
    if (item.blocked) {
      await blockItem.mutateAsync({ id: item.id, projectId, blocked: false });
    } else {
      setShowBlockReason(true);
    }
  }

  async function handleBlockSubmit() {
    if (!blockReason.trim()) return;
    await blockItem.mutateAsync({ id: item.id, projectId, blocked: true, reason: blockReason });
    setShowBlockReason(false);
    setBlockReason('');
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
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        setUploadingCount((n) => n + 1);
        try {
          await uploadAttachment.mutateAsync({
            itemId: item.id,
            data: { filename: file.name || undefined, mime: file.type, data_base64: base64 },
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

  async function handleDelete() {
    if (window.confirm(`Delete "${item.title}"? This cannot be undone.`)) {
      await deleteItem.mutateAsync({ id: item.id, projectId });
      onDeleted();
    }
  }

  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    width: 420,
    height: '100vh',
    background: '#fff',
    borderLeft: '1px solid #ddd',
    display: 'flex',
    flexDirection: 'column',
    // Above the global Settings gear (900) so it can't cover the panel's ✕,
    // below modals (1000).
    zIndex: 950,
  };

  const sectionStyle: React.CSSProperties = {
    padding: '12px 20px',
    borderBottom: '1px solid #f0f0f0',
  };

  const tabStyle = (tab: Tab): React.CSSProperties => ({
    padding: '8px 16px',
    background: activeTab === tab ? '#fff' : '#f9fafb',
    border: 'none',
    borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: activeTab === tab ? 600 : 400,
    color: activeTab === tab ? '#1d4ed8' : '#6b7280',
  });

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.1)', zIndex: 949,
        }}
      />
      <div style={panelStyle} onPaste={handlePaste}>
        {/* Header */}
        <div style={{ ...sectionStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              {isWorkItemType(item.type) ? (
                <select
                  value={item.type}
                  onChange={handleTypeChange}
                  title="Change item type"
                  style={{
                    fontSize: 12, fontWeight: 600, color: '#fff',
                    background: TYPE_COLORS[item.type] ?? '#888',
                    border: 'none', borderRadius: 4, padding: '1px 6px',
                    cursor: 'pointer',
                  }}
                >
                  {WORK_ITEM_TYPES.map((t) => (
                    <option key={t} value={t} style={{ color: '#111', background: '#fff' }}>{t}</option>
                  ))}
                </select>
              ) : (
                <span style={{
                  fontSize: 12, fontWeight: 600, color: '#fff',
                  background: TYPE_COLORS[item.type] ?? '#888',
                  borderRadius: 4, padding: '1px 6px',
                }}>
                  {item.type}
                </span>
              )}
              <span style={{ fontSize: 13, fontWeight: 600, color: '#999' }}>{item.key}</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{item.title}</h2>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button onClick={() => onEdit(item)}>Edit</button>
            <button onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb' }}>
          <button style={tabStyle('details')} onClick={() => setActiveTab('details')}>Details</button>
          <button style={tabStyle('comments')} onClick={() => setActiveTab('comments')}>Comments / Activity</button>
          <button style={tabStyle('chat')} onClick={() => setActiveTab('chat')}>Chat</button>
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: activeTab === 'chat' ? 'hidden' : 'auto', display: 'flex', flexDirection: 'column' }}>
          {activeTab === 'details' && (
            <>
              <div style={sectionStyle}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 14 }}>Status</label>
                {isWorkItemType(item.type) ? (
                  <select
                    value={item.column_id}
                    onChange={handleStatusChange}
                    style={{ width: '100%', padding: 6 }}
                  >
                    {columns.map((col) => (
                      <option key={col.id} value={col.id}>{col.name}</option>
                    ))}
                  </select>
                ) : (
                  <div>
                    <span style={{ fontSize: 14 }}>
                      {columns.find((col) => col.id === item.column_id)?.name ?? item.column_id}
                    </span>
                    <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>
                      derived from its work items
                    </span>
                  </div>
                )}
              </div>

              <div style={{ ...sectionStyle, display: 'flex', gap: 8 }}>
                <button
                  onClick={handleFlagToggle}
                  style={{ background: item.flagged ? '#f59e0b' : undefined }}
                >
                  {item.flagged ? '🚩 Unflag' : '🚩 Flag'}
                </button>
                <button
                  onClick={handleBlockToggle}
                  style={{ background: item.blocked ? '#ef4444' : undefined, color: item.blocked ? '#fff' : undefined }}
                >
                  {item.blocked ? 'Unblock' : 'Block'}
                </button>
              </div>

              {showBlockReason && (
                <div style={sectionStyle}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 14 }}>Block reason *</label>
                  <textarea
                    value={blockReason}
                    onChange={(e) => setBlockReason(e.target.value)}
                    rows={2}
                    style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button onClick={handleBlockSubmit}>Block</button>
                    <button onClick={() => setShowBlockReason(false)}>Cancel</button>
                  </div>
                </div>
              )}

              {item.blocked && item.blocked_reason && (
                <div style={{ ...sectionStyle, background: '#fef2f2' }}>
                  <strong style={{ fontSize: 14 }}>Blocked:</strong>{' '}
                  <span style={{ fontSize: 14, color: '#991b1b' }}>{item.blocked_reason}</span>
                </div>
              )}

              {item.description && (
                <div style={sectionStyle}>
                  <label style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: 14 }}>Description</label>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 15 }}>
                    <KbLinkedText text={item.description} projectName={project?.name} prefix={project?.prefix} />
                  </p>
                </div>
              )}

              {(attachments.length > 0 || uploadingCount > 0) && (
                <div style={sectionStyle}>
                  <label style={{ display: 'block', marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Attachments</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {attachments.map((att) => (
                      <div key={att.id} style={{ position: 'relative' }}>
                        <img
                          src={api.attachments.url(att.id)}
                          alt={att.filename}
                          title={att.filename}
                          onClick={() => window.open(api.attachments.url(att.id), '_blank')}
                          style={{
                            height: 80, width: 80, objectFit: 'cover',
                            borderRadius: 6, border: '1px solid #e5e7eb',
                            cursor: 'pointer', display: 'block',
                          }}
                        />
                        <button
                          onClick={() => deleteAttachment.mutate({ id: att.id, itemId: item.id })}
                          title="Delete attachment"
                          style={{
                            position: 'absolute', top: 2, right: 2,
                            width: 18, height: 18, padding: 0, lineHeight: '16px',
                            fontSize: 11, borderRadius: 9, border: 'none',
                            background: 'rgba(0,0,0,0.55)', color: '#fff', cursor: 'pointer',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    {uploadingCount > 0 && (
                      <div style={{
                        height: 80, width: 80, borderRadius: 6,
                        border: '1px dashed #d1d5db', background: '#f9fafb',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, color: '#9ca3af',
                      }}>
                        Uploading…
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div style={{ ...sectionStyle, marginTop: 'auto' }}>
                <button onClick={handleDelete} style={{ color: 'red', width: '100%' }}>
                  Delete item
                </button>
              </div>
            </>
          )}

          {activeTab === 'comments' && (
            <>
              <div style={sectionStyle}>
                <label style={{ display: 'block', marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Comments</label>
                <CommentBox itemId={item.id} projectName={project?.name} prefix={project?.prefix} />
              </div>

              <div style={sectionStyle}>
                <label style={{ display: 'block', marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Activity</label>
                <ActivityFeed itemId={item.id} />
              </div>
            </>
          )}

          {activeTab === 'chat' && (
            <ChatPanel
              projectId={projectId}
              itemId={item.id}
              providerLabel={providerLabel}
            />
          )}
        </div>
      </div>
    </>
  );
}
