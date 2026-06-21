import { useState, useEffect, useRef } from 'react';
import { useProject } from '../hooks/useProjects';
import { useColumns, useItems } from '../hooks/useBoard';
import { useSSE } from '../hooks/useSSE';
import { Column, CollapsedLane } from './Column';
import { HeaderMenu } from './HeaderMenu';
import { ConnectionIndicator } from './ConnectionIndicator';
import { HelpTip } from './HelpTip';
import { ItemDetailPanel } from './ItemDetailPanel';
import { ItemForm } from './ItemForm';
import { ProjectForm } from './ProjectForm';
import { PlanView } from './PlanView';
import { triggerExport } from '../api/export';
import { isWorkItemType } from '../types';
import type { Item, ItemType } from '../types';

// Five lanes at the 280px readable minimum need ~1496px (5×280 + 4×16 gaps +
// 2×16 padding). Below that the board would otherwise scroll horizontally, so
// the Review/Done/Cancelled lanes collapse to slim expandable rails instead —
// only Backlog and In Progress stay open by default.
const NARROW_BREAKPOINT = 1500;

interface Props {
  projectId: string;
  onBack: () => void;
  onShowKb: () => void;
  onOpenSettings: () => void;
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

export function Board({ projectId, onBack, onShowKb, onOpenSettings }: Props) {
  const { data: project } = useProject(projectId);
  const { data: columns, isLoading: colsLoading } = useColumns();
  const { data: items, isLoading: itemsLoading } = useItems(projectId);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [showItemForm, setShowItemForm] = useState(false);
  const [itemFormColId, setItemFormColId] = useState<string>('');
  // Seeds for a new item opened via a "+" button: parent and/or type to preselect.
  const [itemFormParentId, setItemFormParentId] = useState<string>('');
  const [itemFormType, setItemFormType] = useState<ItemType | undefined>(undefined);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [isPlanningMode, setIsPlanningMode] = useState(false);
  const [epicFilter, setEpicFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Done column shows only items moved to Done today; this reveals all of them.
  const [showAllDone, setShowAllDone] = useState(false);
  // On narrow viewports the Review/Done/Cancelled lanes collapse to rails; this
  // tracks which of them the user has manually expanded.
  const [expandedLanes, setExpandedLanes] = useState<Set<string>>(new Set());
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= NARROW_BREAKPOINT
  );
  // Brief "Copied!" feedback after clicking the repo-path chip in the header.
  const [copiedPath, setCopiedPath] = useState(false);
  // Tracks the project whose collapse defaults have been applied, so the
  // collapse-by-default only seeds once per project and never fights the user.
  const collapseInitRef = useRef<string | null>(null);
  const { status } = useSSE(projectId);

  // Track whether the viewport is narrow enough to collapse secondary lanes.
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT}px)`);
    const onChange = () => setIsNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Reset filters when switching projects
  useEffect(() => {
    setEpicFilter('all');
    setSearch('');
    setCollapsed(new Set());
    setShowAllDone(false);
    setExpandedLanes(new Set());
    collapseInitRef.current = null;
  }, [projectId]);

  // Collapse all epic/story headers by default — once per project, after its
  // items load. Collapse keys are per-column ("<columnId>::<itemId>") so each
  // column's copy of a story/epic header collapses independently. We seed the
  // key for every column where a header will render: the header's own column
  // (when its status is that column) and every column holding a descendant.
  // Guarded against stale data and against re-collapsing after the user acts.
  useEffect(() => {
    if (!items || items.length === 0) return;
    if (items[0].project_id !== projectId) return;
    if (collapseInitRef.current === projectId) return;
    const byId = new Map(items.map((i) => [i.id, i]));
    const keys = new Set<string>();
    for (const it of items) {
      if (it.type === 'epic' || it.type === 'story') keys.add(`${it.column_id}::${it.id}`);
      let parentId = it.parent_id;
      const seen = new Set<string>([it.id]); // cycle guard — never loop forever
      while (parentId != null && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (parent && (parent.type === 'epic' || parent.type === 'story')) {
          keys.add(`${it.column_id}::${parent.id}`);
        }
        parentId = parent?.parent_id ?? null;
      }
    }
    setCollapsed(keys);
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

  // Lanes that collapse to rails on a narrow viewport: everything past In
  // Progress (index 1) — i.e. Review, Done and Cancelled. Backlog and In
  // Progress always stay open.
  const collapsibleColIds = new Set(sortedColumns.filter((_, idx) => idx > 1).map((c) => c.id));

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

  // Collapse is applied per-column inside <Column> (headers always render; only
  // that column's descendants hide), so no board-wide hiding happens here.

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // The items shown in a given lane (the Done column hides items not moved there
  // today unless "show all done" is on). Shared by the full lane and its rail count.
  function itemsForColumn(col: { id: string }): Item[] {
    return searchedItems.filter((item) => {
      if (item.column_id !== col.id) return false;
      if (col.id === doneColId && !showAllDone && !isToday(item.column_changed_at)) return false;
      return true;
    });
  }

  function expandLane(colId: string) {
    setExpandedLanes((prev) => new Set(prev).add(colId));
  }

  function collapseLane(colId: string) {
    setExpandedLanes((prev) => {
      const next = new Set(prev);
      next.delete(colId);
      return next;
    });
  }

  function openNewItemForm(colId: string, opts?: { parentId?: string; type?: ItemType }) {
    setItemFormColId(colId);
    setItemFormParentId(opts?.parentId ?? '');
    setItemFormType(opts?.type);
    setEditingItem(null);
    setShowItemForm(true);
  }

  // A new item under a story/epic starts in the first column (Backlog) with the
  // parent preselected. An epic's natural child is a story; everything else
  // defaults to a task.
  function openAddChildForm(parent: Item) {
    openNewItemForm(sortedColumns[0]?.id ?? '', {
      parentId: parent.id,
      type: parent.type === 'epic' ? 'story' : 'task',
    });
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '12px 72px 12px 24px', // right padding clears the global settings gear
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        flexWrap: 'wrap', // narrow widths wrap controls to new rows instead of overflowing off-screen
        alignItems: 'center',
        gap: 12,
        background: 'var(--surface)',
      }}>
        <button onClick={onBack}>← Back</button>
        <h1 style={{ margin: 0, fontSize: 20 }}>{project?.name}</h1>
        {project?.repo_path && (
          <button
            type="button"
            title="Click to copy the repository path"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(project.repo_path!);
                setCopiedPath(true);
                setTimeout(() => setCopiedPath(false), 1500);
              } catch {
                // clipboard unavailable (e.g. non-secure context) — silently no-op
              }
            }}
            style={{
              fontFamily: 'monospace',
              fontSize: 12,
              color: 'var(--text-2)',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              maxWidth: 360,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {copiedPath ? 'Copied!' : project.repo_path}
          </button>
        )}
        <div className="view-tabs">
          <button className="active" disabled>Board</button>
          <button onClick={onShowKb}>Knowledgebase</button>
        </div>
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

        {/* Everything else lives behind the hamburger to keep the header tidy. */}
        <div style={{ marginLeft: 'auto' }}>
          <HeaderMenu label="Board menu">
            {(close) => (
              <>
                <button
                  className="header-menu-item"
                  onClick={() => { openNewItemForm(sortedColumns[0]?.id ?? '', { type: 'story' }); close(); }}
                >
                  ＋ New item
                </button>
                <button
                  className="header-menu-item"
                  onClick={() => { setIsPlanningMode(true); close(); }}
                >
                  ✦ Plan
                </button>
                <button
                  className="header-menu-item"
                  onClick={async () => {
                    close();
                    try {
                      const result = await triggerExport(projectId);
                      window.alert('Exported to: ' + result.outputDir);
                    } catch (err: unknown) {
                      window.alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
                    }
                  }}
                >
                  ⇩ Export
                </button>
                <button
                  className="header-menu-item"
                  onClick={() => { setShowProjectForm(true); close(); }}
                >
                  ✎ Edit project
                </button>

                <div className="header-menu-divider" />

                <div className="header-menu-section">Filter</div>
                <div className="header-menu-field">
                  <select value={epicFilter} onChange={(e) => setEpicFilter(e.target.value)}>
                    <option value="all">All items</option>
                    {epics.map((epic) => (
                      <option key={epic.id} value={epic.id}>{epic.title}</option>
                    ))}
                  </select>
                </div>
                <label className="header-menu-item" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showAllDone}
                    onChange={(e) => setShowAllDone(e.target.checked)}
                  />
                  Show all done
                </label>

                <div className="header-menu-divider" />

                <button
                  className="header-menu-item"
                  onClick={() => { onOpenSettings(); close(); }}
                >
                  ⚙ Settings
                </button>
              </>
            )}
          </HeaderMenu>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', overflowX: 'auto', padding: 16, gap: 16 }}>
        {sortedColumns.map((col) => {
          const laneItems = itemsForColumn(col);
          // On a narrow viewport, a collapsible lane the user hasn't expanded
          // shows as a slim rail instead of a full column.
          const railed = isNarrow && collapsibleColIds.has(col.id) && !expandedLanes.has(col.id);
          if (railed) {
            return (
              <CollapsedLane
                key={col.id}
                column={col}
                count={laneItems.filter((i) => isWorkItemType(i.type)).length}
                onExpand={() => expandLane(col.id)}
              />
            );
          }
          return (
            <Column
              key={col.id}
              column={col}
              items={laneItems}
              allItems={allItems}
              collapsedIds={collapsed}
              onToggleCollapse={toggleCollapse}
              onCardClick={(item) => setSelectedItem(item)}
              onNewItem={() => openNewItemForm(col.id, { type: 'story' })}
              onAddChild={openAddChildForm}
              isFirstColumn={col.id === sortedColumns[0]?.id}
              onCollapseLane={
                isNarrow && collapsibleColIds.has(col.id) ? () => collapseLane(col.id) : undefined
              }
            />
          );
        })}
      </div>

      <ConnectionIndicator status={status} />

      {liveSelectedItem && (
        <ItemDetailPanel
          item={liveSelectedItem}
          columns={sortedColumns}
          projectId={projectId}
          onClose={() => setSelectedItem(null)}
          onEdit={(item) => {
            // Clear create-mode seeds so a prior "+ add child" parent can't
            // bleed into an edit (that leak is what let an item self-parent).
            setItemFormParentId('');
            setItemFormType(undefined);
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
          defaultType={itemFormType}
          defaultParentId={itemFormParentId}
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
