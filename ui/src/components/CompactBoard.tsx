import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Item, Column } from '../types';

interface CompactBoardProps {
  projectId: string;
}

function TypeBadge({ type }: { type: Item['type'] }) {
  const colors: Record<string, string> = {
    epic: '#7c3aed',
    story: '#0070f3',
    task: '#16a34a',
    bug: '#dc2626',
    investigation: '#0d9488',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0 6px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: colors[type] ?? '#888',
        color: '#fff',
        marginRight: 6,
        textTransform: 'uppercase',
      }}
    >
      {type}
    </span>
  );
}

export function CompactBoard({ projectId }: CompactBoardProps) {
  const { data: columns, isLoading: colsLoading, isError: colsError } = useQuery({
    queryKey: ['columns'],
    queryFn: () => api.columns.list(),
  });

  const { data: items, isLoading: itemsLoading, isError: itemsError } = useQuery({
    queryKey: ['items', projectId],
    queryFn: () => api.items.listByProject(projectId),
    enabled: !!projectId,
  });

  if (colsLoading || itemsLoading) {
    return <div style={{ padding: 16, color: '#888' }}>Loading board...</div>;
  }

  if (colsError || itemsError) {
    return <div style={{ padding: 16, color: '#ef4444' }}>Failed to load board</div>;
  }

  const sortedColumns = [...(columns ?? [])].sort((a: Column, b: Column) => a.position - b.position);
  const allItems = items ?? [];

  return (
    <div style={{ padding: '8px 16px', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {sortedColumns.map((col) => {
          const colItems = allItems.filter((item) => item.column_id === col.id);
          return (
            <div key={col.id} style={{ minWidth: 200, flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#666',
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {col.name}
                <span
                  style={{
                    background: '#e5e7eb',
                    borderRadius: 10,
                    padding: '0 6px',
                    fontSize: 12,
                  }}
                >
                  {colItems.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {colItems.map((item) => {
                  const title =
                    item.title.length > 60 ? item.title.slice(0, 60) + '…' : item.title;
                  return (
                    <div
                      key={item.id}
                      style={{
                        padding: '4px 8px',
                        background: '#fff',
                        border: '1px solid #e5e7eb',
                        borderRadius: 4,
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <TypeBadge type={item.type} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {title}
                      </span>
                      {item.flagged && <span style={{ marginLeft: 4 }} title="Flagged">🚩</span>}
                      {item.blocked && (
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: '#ef4444',
                            marginLeft: 4,
                          }}
                          title="Blocked"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
