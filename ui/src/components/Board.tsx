import { useState, useEffect, useRef } from 'react';
import { useProject } from '../hooks/useProjects';
import { useColumns, useItems } from '../hooks/useBoard';
import { useSSE } from '../hooks/useSSE';
import { Column } from './Column';
import { ConnectionIndicator } from './ConnectionIndicator';
import { HelpTip } from './HelpTip';
import { ItemDetailPanel } from './ItemDetailPanel';
import { ItemForm } from './ItemForm';
import { ProjectForm } from './ProjectForm';
import { PlanView } from './PlanView';
import { triggerExport } from '../api/export';
import type { Item } from '../types';

interface Props {
  projectId: string;
  onBack: () => void;
  onShowKb: () => void;
}

/** True if an ISO timestamp falls on the current local calendar day. */
function isToday(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function Board({ projectId, onBack, onShowKb }: Props) {
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
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Done column shows only items moved to Done today; this reveals all of them.
  const [showAllDone, setShowAllDone] = useState(false);
  // Tracks the project whose collapse defaults have been applied, so the
  // collapse-by-default only seeds once per project and never fights the user.
  const collapseInitRef = useRef<string | null>(null);
  const { status } = useSSE(projectId);

  // Reset filters when switching projects
  useEffect(() => {
    setEpicFilter('all');
    setSearch('');
    setCollapsed(new Set());
    setShowAllDone(false);
    collapseInitRef.current = null;
  }, [projectId]);

  // Collapse all epics and stories by default — once per project, after its
  // items load. Guarded against stale data from the previous project, and
  // against re-collapsing once the user has started expanding things.
  useEffect(() => {
    if (!items || items.length === 0) return;
    if (items[0].project_id !== projectId) return;
    if (collapseInitRef.current === projectId) return;
    const ids = new Set(
      items.filter((i) => i.type === 'epic' || i.type === 'story').map((i) => i.id)
    );
    setCollapsed(ids);
    collapseInitRef.current = projectId;
  }, [projectId, items]);

  if (isPlanningMode) {
    return <PlanView projectId={projectId} onClose={() => setIsPlanningMode(false)} />;
  }

  if (colsLoading || itemsLoading) return <div style={{ padding: 24 }}>Loading board…</div>;

  const sortedColumns = [...(columns ?? [])].sort((a, b) => a.position - b.position);
  // The Done column is the last column whose role is not 'cancelled' (mirrors
  // the server's rollup rule). Its cards are filtered to "moved today" by default.
  const doneColId = [...sortedColumns].reverse().find((c) => c.role !== 'cancelled')?.id;

  const allItems = items ?? [];

  // The detail panel must reflect live query data (e.g. after a type change) —
  // the click-time snapshot in state goes stale once queries refetch.
  const liveSelectedItem = selectedItem
    ? allItems.find((i) => i.id === selectedItem.id) ?? selectedItem
    : null;

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

  const q = search.trim().toLowerCase();
  const searchedItems = q === ''
    ? visibleItems
    : visibleItems.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.key.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q)
      );

  // Hide items whose epic/story ancestor is collapsed (board-wide, across all columns)
  const itemById = new Map(allItems.map((i) => [i.id, i]));
  const displayedItems = searchedItems.filter((item) => {
    let parentId = item.parent_id;
    while (parentId != null) {
      if (collapsed.has(parentId)) return false;
      parentId = itemById.get(parentId)?.parent_id ?? null;
    }
    return true;
  });

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
        <div className="view-tabs">
          <button className="active" disabled>Board</button>
          <button onClick={onShowKb}>Knowledgebase</button>
        </div>
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
        <input
          type="search"
          placeholder="Search tickets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginLeft: 8, padding: '4px 8px', width: 200 }}
        />
        <HelpTip>
          <p>
            Filters the board as you type — nothing is sent to the server. Case-insensitive;
            matches your text anywhere in a ticket's title, key (e.g. LDA-12), or description.
          </p>
          <p>
            Stacks with the epic filter: only tickets matching both are shown. Clear the box to
            show everything.
          </p>
        </HelpTip>
        <label style={{ marginLeft: 8, fontSize: 13, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <input
            type="checkbox"
            checked={showAllDone}
            onChange={(e) => setShowAllDone(e.target.checked)}
          />
          Show all done
        </label>
        <HelpTip>
          <p>
            By default the <strong>Done</strong> column shows only items moved there today, so it
            doesn't grow without bound. Tick this to show every done item.
          </p>
          <p>
            This composes with search and the epic filter — searching still respects the "today"
            limit unless this box is ticked.
          </p>
        </HelpTip>
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
            items={displayedItems.filter((item) => {
              if (item.column_id !== col.id) return false;
              // In the Done column, hide items not moved there today unless the
              // user opted to show all. Other columns are unaffected.
              if (col.id === doneColId && !showAllDone && !isToday(item.column_changed_at)) {
                return false;
              }
              return true;
            })}
            allItems={allItems}
            collapsedIds={collapsed}
            onToggleCollapse={toggleCollapse}
            onCardClick={(item) => setSelectedItem(item)}
            onNewItem={() => openNewItemForm(col.id)}
          />
        ))}
      </div>

      <ConnectionIndicator status={status} />

      {liveSelectedItem && (
        <ItemDetailPanel
          item={liveSelectedItem}
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
