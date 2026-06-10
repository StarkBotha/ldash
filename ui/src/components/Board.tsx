import { useState, useEffect } from 'react';
import { useProject } from '../hooks/useProjects';
import { useColumns, useItems } from '../hooks/useBoard';
import { useSSE } from '../hooks/useSSE';
import { Column } from './Column';
import { ConnectionIndicator } from './ConnectionIndicator';
import { ItemDetailPanel } from './ItemDetailPanel';
import { ItemForm } from './ItemForm';
import { ProjectForm } from './ProjectForm';
import { PlanView } from './PlanView';
import { triggerExport } from '../api/export';
import type { Item } from '../types';

interface Props {
  projectId: string;
  onBack: () => void;
}

export function Board({ projectId, onBack }: Props) {
  const { data: project } = useProject(projectId);
  const { data: columns, isLoading: colsLoading } = useColumns();
  const { data: items, isLoading: itemsLoading } = useItems(projectId);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [showItemForm, setShowItemForm] = useState(false);
  const [itemFormColId, setItemFormColId] = useState<string>('');
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [isPlanningMode, setIsPlanningMode] = useState(false);
  const [epicFilter, setEpicFilter] = useState<string>('all');
  const { status } = useSSE(projectId);

  // Reset epic filter when switching projects
  useEffect(() => {
    setEpicFilter('all');
  }, [projectId]);

  if (isPlanningMode) {
    return <PlanView projectId={projectId} onClose={() => setIsPlanningMode(false)} />;
  }

  if (colsLoading || itemsLoading) return <div style={{ padding: 24 }}>Loading board…</div>;

  const sortedColumns = [...(columns ?? [])].sort((a, b) => a.position - b.position);

  const allItems = items ?? [];

  // Compute filtered items based on epic filter selection
  const epics = allItems.filter((item) => item.type === 'epic');
  const visibleItems: Item[] = (() => {
    if (epicFilter === 'all') return allItems;
    // Include the selected epic, its direct story children, and tasks whose parent is one of those stories
    const epicItem = allItems.find((i) => i.id === epicFilter);
    if (!epicItem) return allItems;
    const storyIds = new Set(allItems.filter((i) => i.parent_id === epicFilter).map((i) => i.id));
    return allItems.filter(
      (i) => i.id === epicFilter || storyIds.has(i.id) || (i.parent_id != null && storyIds.has(i.parent_id))
    );
  })();

  function openNewItemForm(colId: string) {
    setItemFormColId(colId);
    setEditingItem(null);
    setShowItemForm(true);
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '12px 72px 12px 24px', // right padding clears the global settings gear
        borderBottom: '1px solid #ddd',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: '#fff',
      }}>
        <button onClick={onBack}>← Back</button>
        <h1 style={{ margin: 0, fontSize: 20 }}>{project?.name}</h1>
        <button onClick={() => setShowProjectForm(true)}>Edit</button>
        <select
          value={epicFilter}
          onChange={(e) => setEpicFilter(e.target.value)}
          style={{ marginLeft: 8 }}
        >
          <option value="all">All items</option>
          {epics.map((epic) => (
            <option key={epic.id} value={epic.id}>{epic.title}</option>
          ))}
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setIsPlanningMode(true)}>Plan</button>
          <button
            onClick={async () => {
              try {
                const result = await triggerExport(projectId);
                window.alert('Exported to: ' + result.outputDir);
              } catch (err: unknown) {
                window.alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
              }
            }}
          >
            Export
          </button>
          <button onClick={() => openNewItemForm(sortedColumns[0]?.id ?? '')}>
            New item
          </button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', overflowX: 'auto', padding: 16, gap: 16 }}>
        {sortedColumns.map((col) => (
          <Column
            key={col.id}
            column={col}
            items={visibleItems.filter((item) => item.column_id === col.id)}
            allItems={allItems}
            onCardClick={(item) => setSelectedItem(item)}
            onNewItem={() => openNewItemForm(col.id)}
          />
        ))}
      </div>

      <ConnectionIndicator status={status} />

      {selectedItem && (
        <ItemDetailPanel
          item={selectedItem}
          columns={sortedColumns}
          projectId={projectId}
          onClose={() => setSelectedItem(null)}
          onEdit={(item) => {
            setEditingItem(item);
            setShowItemForm(true);
          }}
          onDeleted={() => setSelectedItem(null)}
        />
      )}

      {showItemForm && (
        <ItemForm
          projectId={projectId}
          columnId={itemFormColId}
          columns={sortedColumns}
          items={items ?? []}
          item={editingItem ?? undefined}
          onClose={() => {
            setShowItemForm(false);
            setEditingItem(null);
          }}
        />
      )}

      {showProjectForm && project && (
        <ProjectForm
          project={project}
          onClose={() => setShowProjectForm(false)}
        />
      )}
    </div>
  );
}
