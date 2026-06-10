import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMoveItem, useFlagItem, useBlockItem, useDeleteItem } from '../hooks/useBoard';
import { CommentBox } from './CommentBox';
import { ActivityFeed } from './ActivityFeed';
import { ChatPanel } from './ChatPanel';
import { getSettings } from '../api/settings';
import type { Item, Column } from '../types';

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
  const flagItem = useFlagItem();
  const blockItem = useBlockItem();
  const deleteItem = useDeleteItem();
  const [showBlockReason, setShowBlockReason] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('details');

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
    zIndex: 500,
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
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.1)', zIndex: 499,
        }}
      />
      <div style={panelStyle}>
        {/* Header */}
        <div style={{ ...sectionStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                fontSize: 12, fontWeight: 600, color: '#fff',
                background: item.type === 'epic' ? '#8b5cf6' : item.type === 'story' ? '#3b82f6' : '#10b981',
                borderRadius: 4, padding: '1px 6px',
              }}>
                {item.type}
              </span>
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
                <select
                  value={item.column_id}
                  onChange={handleStatusChange}
                  style={{ width: '100%', padding: 6 }}
                >
                  {columns.map((col) => (
                    <option key={col.id} value={col.id}>{col.name}</option>
                  ))}
                </select>
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
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 15 }}>{item.description}</p>
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
                <CommentBox itemId={item.id} />
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
