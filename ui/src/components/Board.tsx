import { useState, useEffect } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { useProject } from '../hooks/useProjects';
import { useColumns, useItems } from '../hooks/useBoard';
import { useSSE } from '../hooks/useSSE';
import { Column } from './Column';
import { ConnectionIndicator } from './ConnectionIndicator';
import { ItemDetailPanel } from './ItemDetailPanel';
import { ItemForm } from './ItemForm';
import { ProjectForm } from './ProjectForm';
import { PlanView } from './PlanView';
import { api } from '../api/client';
import { triggerExport } from '../api/export';
import type { Item } from '../types';
import { logClientError } from '../clientLog';

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
  const [dragOverride, setDragOverride] = useState<{ itemId: string; toColumnId: string } | null>(null);
  const [isPlanningMode, setIsPlanningMode] = useState(false);
  const [epicFilter, setEpicFilter] = useState<string>('all');
  const queryClient = useQueryClient();
  const { status } = useSSE(projectId);
  // Require 8px of movement before a drag starts, so plain clicks on cards
  // still fire onClick instead of being swallowed as zero-distance drags.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Reset epic filter when switching projects
  useEffect(() => {
    setEpicFilter('all');
  }, [projectId]);

  if (isPlanningMode) {
    return <PlanView projectId={projectId} onClose={() => setIsPlanningMode(false)} />;
  }

  if (colsLoading || itemsLoading) return <div style={{ padding: 24 }}>Loading board…</div>;

  const sortedColumns = [...(columns ?? [])].sort((a, b) => a.position - b.position);

  // Build item distribution with dragOverride applied
  const allItems = items ?? [];
  const distributedItems = allItems.map((item) => {
    if (dragOverride && item.id === dragOverride.itemId) {
      return { ...item, column_id: dragOverride.toColumnId };
    }
    return item;
  });

  // Compute filtered items based on epic filter selection
  const epics = allItems.filter((item) => item.type === 'epic');
  const visibleItems: Item[] = (() => {
    if (epicFilter === 'all') return distributedItems;
    // Include the selected epic, its direct story children, and tasks whose parent is one of those stories
    const epicItem = allItems.find((i) => i.id === epicFilter);
    if (!epicItem) return distributedItems;
    const storyIds = new Set(allItems.filter((i) => i.parent_id === epicFilter).map((i) => i.id));
    return distributedItems.filter(
      (i) => i.id === epicFilter || storyIds.has(i.id) || (i.parent_id != null && storyIds.has(i.parent_id))
    );
  })();

  function openNewItemForm(colId: string) {
    setItemFormColId(colId);
    setEditingItem(null);
    setShowItemForm(true);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const itemId = String(active.id);
    const overId = String(over.id);

    // Dropped onto itself (e.g. a zero-distance drag) — nothing to do
    if (itemId === overId) return;

    // Determine toColumnId: if overId is a column id use it directly, else look up the item's column
    const columnIds = new Set(sortedColumns.map((c) => c.id));
    let toColumnId: string;
    if (columnIds.has(overId)) {
      toColumnId = overId;
    } else {
      // overId is another item's id — find its column
      const overItem = allItems.find((i) => i.id === overId);
      if (!overItem) return;
      toColumnId = overItem.column_id;
    }

    // Determine toPosition: index of the item in the target column after override
    const targetColumnItems = distributedItems
      .filter((i) => i.column_id === toColumnId || (i.id === itemId && toColumnId === toColumnId))
      .filter((i) => {
        if (i.id === itemId) return true;
        return i.column_id === toColumnId;
      })
      .sort((a, b) => a.position - b.position);

    const toPosition = targetColumnItems.findIndex((i) => i.id === itemId);
    const position = toPosition >= 0 ? toPosition : targetColumnItems.length;

    setDragOverride({ itemId, toColumnId });

    try {
      await api.items.move(itemId, { column_id: toColumnId, position });
      queryClient.invalidateQueries({ queryKey: ['items', projectId] });
    } catch (err) {
      console.error('Failed to move item:', err);
      logClientError('Failed to move item', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setDragOverride(null);
    }
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

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
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
      </DndContext>

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
