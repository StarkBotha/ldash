import type { CSSProperties } from 'react';
import { Card } from './Card';
import { isWorkItemType } from '../types';
import type { Column as ColumnType, Item } from '../types';

/** Bordered box that wraps a parent's children so the hierarchy is visually
 *  contained. The border is type-tinted (purple for epics, blue for stories);
 *  the inner padding supplies the indent effect, so the box itself isn't
 *  margin-indented. */
const CHILD_BOX_BASE: CSSProperties = {
  padding: 8,
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

/** An epic's children container — purple-tinted boundary. */
const EPIC_CHILDREN: CSSProperties = { ...CHILD_BOX_BASE, border: '1px solid var(--epic-border)' };

/** A story's children (tasks) container — blue-tinted boundary. */
const STORY_CHILDREN: CSSProperties = { ...CHILD_BOX_BASE, border: '1px solid var(--story-border)' };

/** Children that are NOT contained (the "No epic" group's items render flush). */
const FLUSH_CHILDREN: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

interface Props {
  column: ColumnType;
  items: Item[];
  allItems: Item[];
  /** Per-column collapse keys, each "<columnId>::<itemId>". */
  collapsedIds: Set<string>;
  onToggleCollapse: (key: string) => void;
  onCardClick: (item: Item) => void;
  onNewItem: () => void;
  /** Open the new-item form parented to a story/epic. */
  onAddChild: (parent: Item) => void;
  /** True for the Backlog (first) lane — where completely empty epics are shown. */
  isFirstColumn: boolean;
  /** When set, the lane is collapsible (narrow viewport) — renders a "‹" handle
   *  in the header that collapses this lane back to a slim rail. */
  onCollapseLane?: () => void;
}

/** Walk parent_id up to find the root epic ancestor id, or null if none.
 *  The visited set guards against a parent cycle hanging the walk. */
function rootEpicId(item: Item, byId: Map<string, Item>): string | null {
  let current: Item | undefined = item;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.type === 'epic') return current.id;
    seen.add(current.id);
    if (current.parent_id == null) return null;
    current = byId.get(current.parent_id);
  }
  return null;
}

/** Walk parent_id up to find the nearest story ancestor id, or null if none.
 *  The visited set guards against a parent cycle hanging the walk. */
function nearestStoryId(item: Item, byId: Map<string, Item>): string | null {
  let parentId = item.parent_id;
  const seen = new Set<string>([item.id]);
  while (parentId != null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.type === 'story') return parent.id;
    seen.add(parentId);
    parentId = parent.parent_id;
  }
  return null;
}

/** A story header within a column plus the leaf work items it owns there. */
interface StorySection {
  story: Item;
  tasks: Item[];
}

interface EpicGroup {
  epicId: string | null; // null = "No epic"
  epicTitle: string;
  /** The epic's own card. Rendered in EVERY lane where the epic has a group (its
   *  status lane and any lane holding its descendants), like a story card — null
   *  only for the "No epic" group. */
  epicCard: Item | null;
  /** Story sections, ordered by story position. A story appears here whenever it
   *  has leaf work items in this column; a CHILDLESS story instead appears in its
   *  own status lane (it has no children to place it). */
  stories: StorySection[];
  /** Leaf work items in this column with no story ancestor (parented to the epic
   *  directly, or to nothing) — rendered top-level. */
  looseLeaves: Item[];
}

/** Group a column's items under their epic and story ancestors.
 *
 *  Stories and epics are CONTAINERS, not units of work — they're placed by their
 *  children, not by a derived single status. A story/epic appears in a lane only
 *  when it has a descendant there (its header is synthesized per-column so its
 *  in-column items can be collapsed independently). Two exceptions:
 *    - a CHILDLESS story shows in its own status lane (no children to place it —
 *      it's effectively a leaf placeholder until it's broken into tasks);
 *    - a completely EMPTY epic (no descendants at all) shows in the Backlog lane
 *      (`isFirstColumn`) so it stays visible until it gets children.
 *  An epic never gets a bare status-lane slot otherwise. */
export function buildGroups(
  columnItems: Item[],
  allItems: Item[],
  isFirstColumn = false
): EpicGroup[] {
  const byId = new Map(allItems.map((i) => [i.id, i]));

  // Stories with at least one leaf descendant anywhere are placed by those
  // leaves, so they never claim their own status lane. Epics with no descendant
  // at all are "empty" and show only in Backlog.
  const storiesWithLeaves = new Set<string>();
  const epicsWithDescendants = new Set<string>();
  for (const i of allItems) {
    if (isWorkItemType(i.type)) {
      const sid = nearestStoryId(i, byId);
      if (sid) storiesWithLeaves.add(sid);
    }
    if (i.type !== 'epic') {
      const eid = rootEpicId(i, byId);
      if (eid) epicsWithDescendants.add(eid);
    }
  }

  interface Acc {
    storyTasks: Map<string, Item[]>; // storyId -> in-column leaves
    ownStoryCards: Set<string>; // CHILDLESS stories whose own status is this column
    looseLeaves: Item[];
  }
  const groups = new Map<string | null, Acc>();
  const ensure = (epicId: string | null): Acc => {
    let acc = groups.get(epicId);
    if (!acc) {
      acc = { storyTasks: new Map(), ownStoryCards: new Set(), looseLeaves: [] };
      groups.set(epicId, acc);
    }
    return acc;
  };

  for (const item of columnItems) {
    // Epics get no status-lane slot — they're placed purely by descendants (and,
    // if entirely empty, in Backlog below).
    if (item.type === 'epic') continue;

    if (item.type === 'story') {
      // A story with leaves is placed by those leaves (handled in the leaf branch,
      // wherever they sit). Only a childless story claims its own status lane.
      if (storiesWithLeaves.has(item.id)) continue;
      ensure(rootEpicId(item, byId)).ownStoryCards.add(item.id);
      continue;
    }

    if (isWorkItemType(item.type)) {
      const acc = ensure(rootEpicId(item, byId));
      const storyId = nearestStoryId(item, byId);
      if (storyId == null) {
        acc.looseLeaves.push(item);
      } else {
        const list = acc.storyTasks.get(storyId) ?? [];
        list.push(item);
        acc.storyTasks.set(storyId, list);
      }
    }
  }

  const toGroup = (epicId: string | null, acc: Acc): EpicGroup => {
    const storyIds = new Set<string>([...acc.storyTasks.keys(), ...acc.ownStoryCards]);
    const stories: StorySection[] = [...storyIds]
      .map((id) => byId.get(id))
      .filter((s): s is Item => !!s)
      .sort((a, b) => a.position - b.position)
      .map((story) => ({
        story,
        tasks: (acc.storyTasks.get(story.id) ?? []).slice().sort((a, b) => a.position - b.position),
      }));
    const looseLeaves = acc.looseLeaves.slice().sort((a, b) => a.position - b.position);
    const epic = epicId != null ? byId.get(epicId) : undefined;
    // The epic's card is shown in every lane it has a group (like a story card),
    // not only its status lane; null for the "No epic" group.
    return { epicId, epicTitle: epic?.title ?? 'No epic', epicCard: epic ?? null, stories, looseLeaves };
  };

  const result: EpicGroup[] = [];
  // Epic groups in project-level epic position order, "No epic" last.
  for (const epic of allItems.filter((i) => i.type === 'epic').sort((a, b) => a.position - b.position)) {
    const acc = groups.get(epic.id);
    if (acc) {
      result.push(toGroup(epic.id, acc));
    } else if (isFirstColumn && !epicsWithDescendants.has(epic.id)) {
      // A completely empty epic has no lane of its own to be placed in — keep it
      // visible in Backlog until it gets children.
      result.push({ epicId: epic.id, epicTitle: epic.title, epicCard: epic, stories: [], looseLeaves: [] });
    }
  }
  const noEpic = groups.get(null);
  if (noEpic) result.push(toGroup(null, noEpic));

  return result;
}

/** Slim, clickable rail shown in place of a full lane on narrow viewports.
 *  Clicking it expands the lane back to a full column. */
export function CollapsedLane({
  column,
  count,
  onExpand,
}: {
  column: ColumnType;
  count: number;
  onExpand: () => void;
}) {
  const isCancelled = column.role === 'cancelled';
  return (
    <button
      onClick={onExpand}
      title={`Expand ${column.name}`}
      style={{
        flex: '0 0 auto',
        width: 40,
        alignSelf: 'stretch',
        background: 'var(--surface-2)',
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: '12px 0',
        color: isCancelled ? 'var(--text-3)' : 'var(--text-2)',
      }}
    >
      <span style={{ fontSize: 12 }}>▸</span>
      <span style={{ fontSize: 13 }}>{count}</span>
      <span
        style={{
          writingMode: 'vertical-rl',
          fontWeight: 600,
          whiteSpace: 'nowrap',
          letterSpacing: '0.03em',
        }}
      >
        {column.name}
      </span>
    </button>
  );
}

export function Column({ column, items, allItems, collapsedIds, onToggleCollapse, onCardClick, onNewItem, onAddChild, isFirstColumn, onCollapseLane }: Props) {
  const groups = buildGroups(items, allItems, isFirstColumn);
  const isCancelled = column.role === 'cancelled';
  // Count the actual work items (leaves) in the lane — stories/epics are
  // containers that span lanes, so counting them per-lane would double-count.
  const workItemCount = items.filter((i) => isWorkItemType(i.type)).length;
  const key = (id: string) => `${column.id}::${id}`;

  return (
    <div
      style={{
        // Grow equally to fill the board width; never shrink below a readable
        // floor (the board scrolls horizontally when the viewport is narrower).
        flex: 1,
        minWidth: 280,
        background: 'var(--surface-2)',
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
        borderBottom: '1px solid var(--border)',
      }}>
        {onCollapseLane && (
          <button
            onClick={onCollapseLane}
            style={{ marginRight: 6, padding: '0 6px', fontSize: 14, cursor: 'pointer' }}
            title={`Collapse ${column.name}`}
          >
            ‹
          </button>
        )}
        <span style={{ fontWeight: 600, color: isCancelled ? 'var(--text-3)' : undefined }}>{column.name}</span>
        <span style={{ color: 'var(--text-2)', fontSize: 14 }}>{workItemCount}</span>
        <button
          onClick={onNewItem}
          style={{ marginLeft: 8, padding: '2px 8px', fontSize: 16, cursor: 'pointer' }}
          title={`Add item to ${column.name}`}
        >
          +
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 0, opacity: isCancelled ? 0.6 : 1 }}>
        {groups.map((group) => {
          const isEpic = group.epicId != null;
          // Two collapse levels for an epic:
          //  • the slim bar (OUTER) tidies the whole epic — hides its card + children;
          //  • the epic card's own chevron (INNER) hides only its children, card stays.
          const barCollapsed = isEpic && collapsedIds.has(key(group.epicId!));
          const childrenKey = isEpic ? `${key(group.epicId!)}::children` : '';
          const childrenCollapsed = isEpic && collapsedIds.has(childrenKey);
          const epicChildCount = group.stories.length + group.looseLeaves.length;
          return (
            <div key={group.epicId ?? '__no_epic__'}>
              {/* Slim bar — the epic's OUTER collapse handle: collapsing it tidies the
                  whole epic (its card + children) down to this one line. Shown in
                  every lane the epic has a presence, so it reads consistently. */}
              {isEpic && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 8,
                  marginBottom: 4,
                }}>
                  <button
                    onClick={() => onToggleCollapse(key(group.epicId!))}
                    title={barCollapsed
                      ? `Show ${group.epicTitle}`
                      : `Hide ${group.epicTitle}`}
                    style={{
                      flexShrink: 0,
                      border: '1px solid var(--border)',
                      background: barCollapsed ? 'var(--surface-2)' : 'var(--surface)',
                      borderRadius: 4,
                      padding: '0 5px',
                      fontSize: 11,
                      color: 'var(--text-2)',
                      cursor: 'pointer',
                    }}
                  >
                    {barCollapsed ? '▸' : '▾'}
                  </button>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--text-3)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.07em',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}>
                    {group.epicTitle}
                  </span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
              )}

              {/* Body — hidden when the slim bar is collapsed. For an epic this is its
                  own card (whose chevron is the INNER collapse, hiding only children)
                  then the children; for the "No epic" group it's just the items. */}
              {!barCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
                  {group.epicCard && (
                    <Card
                      item={group.epicCard}
                      childCount={epicChildCount}
                      collapsed={childrenCollapsed}
                      onToggleCollapse={() => onToggleCollapse(childrenKey)}
                      onAddChild={() => onAddChild(group.epicCard!)}
                      onClick={() => onCardClick(group.epicCard!)}
                    />
                  )}

                  {!childrenCollapsed && (
                    // An epic's children sit in an indented, bordered container so
                    // they read as belonging to the epic and don't blur into the
                    // free-floating items below. The "No epic" group stays flush —
                    // its items ARE the free-floating ones.
                    <div style={isEpic ? EPIC_CHILDREN : FLUSH_CHILDREN}>
                      {/* Story sections — each story is a header for its in-column items */}
                      {group.stories.map((section) => {
                        const storyCollapsed = collapsedIds.has(key(section.story.id));
                        const epicTitle = group.epicId != null ? group.epicTitle : undefined;
                        return (
                          <div key={section.story.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <Card
                              item={section.story}
                              parentTitle={epicTitle}
                              childCount={section.tasks.length}
                              collapsed={storyCollapsed}
                              onToggleCollapse={() => onToggleCollapse(key(section.story.id))}
                              onAddChild={() => onAddChild(section.story)}
                              onClick={() => onCardClick(section.story)}
                            />
                            {/* A story's tasks sit in the same indented, bordered
                                container so they clearly belong to the story above. */}
                            {!storyCollapsed && section.tasks.length > 0 && (
                              <div style={STORY_CHILDREN}>
                                {section.tasks.map((task) => (
                                  <Card
                                    key={task.id}
                                    item={task}
                                    parentTitle={section.story.title}
                                    onClick={() => onCardClick(task)}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Leaves with no story ancestor — rendered top-level within the group */}
                      {group.looseLeaves.map((leaf) => {
                        const parent = leaf.parent_id ? allItems.find((i) => i.id === leaf.parent_id) : undefined;
                        return (
                          <Card
                            key={leaf.id}
                            item={leaf}
                            parentTitle={parent?.title}
                            onClick={() => onCardClick(leaf)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
