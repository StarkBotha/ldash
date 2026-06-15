import { Card } from './Card';
import { isWorkItemType } from '../types';
import type { Column as ColumnType, Item } from '../types';

interface Props {
  column: ColumnType;
  items: Item[];
  allItems: Item[];
  /** Per-column collapse keys, each "<columnId>::<itemId>". */
  collapsedIds: Set<string>;
  onToggleCollapse: (key: string) => void;
  onCardClick: (item: Item) => void;
  onNewItem: () => void;
}

/** Walk parent_id up to find the root epic ancestor id, or null if none. */
function rootEpicId(item: Item, byId: Map<string, Item>): string | null {
  let current: Item | undefined = item;
  while (current) {
    if (current.type === 'epic') return current.id;
    if (current.parent_id == null) return null;
    current = byId.get(current.parent_id);
  }
  return null;
}

/** Walk parent_id up to find the nearest story ancestor id, or null if none. */
function nearestStoryId(item: Item, byId: Map<string, Item>): string | null {
  let parentId = item.parent_id;
  while (parentId != null) {
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.type === 'story') return parent.id;
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
  /** The epic's own card, only when its derived status is this column. */
  epicCard: Item | null;
  /** Story sections, ordered by story position. A story appears here whenever it
   *  has leaf work items in this column OR its own derived status is this column,
   *  so every column carries its own header "copy" of the story. */
  stories: StorySection[];
  /** Leaf work items in this column with no story ancestor (parented to the epic
   *  directly, or to nothing) — rendered top-level. */
  looseLeaves: Item[];
}

/** Group a column's items under their epic and story ancestors. Headers are
 *  synthesized per-column: a story/epic that lives (by derived status) in
 *  another column still gets a header here when it has descendants here, so its
 *  in-column items can be collapsed independently of the other columns. */
export function buildGroups(columnItems: Item[], allItems: Item[]): EpicGroup[] {
  const byId = new Map(allItems.map((i) => [i.id, i]));

  interface Acc {
    epicCard: Item | null;
    storyTasks: Map<string, Item[]>; // storyId -> in-column leaves
    ownStoryCards: Set<string>; // stories whose own status is this column
    looseLeaves: Item[];
  }
  const groups = new Map<string | null, Acc>();
  const ensure = (epicId: string | null): Acc => {
    let acc = groups.get(epicId);
    if (!acc) {
      acc = { epicCard: null, storyTasks: new Map(), ownStoryCards: new Set(), looseLeaves: [] };
      groups.set(epicId, acc);
    }
    return acc;
  };

  for (const item of columnItems) {
    if (item.type === 'epic') {
      ensure(item.id).epicCard = item;
      continue;
    }
    const acc = ensure(rootEpicId(item, byId));
    if (item.type === 'story') {
      acc.ownStoryCards.add(item.id);
      if (!acc.storyTasks.has(item.id)) acc.storyTasks.set(item.id, []);
      continue;
    }
    if (isWorkItemType(item.type)) {
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
    return { epicId, epicTitle: epic?.title ?? 'No epic', epicCard: acc.epicCard, stories, looseLeaves };
  };

  const result: EpicGroup[] = [];
  // Epic groups in project-level epic position order, "No epic" last.
  for (const epic of allItems.filter((i) => i.type === 'epic').sort((a, b) => a.position - b.position)) {
    const acc = groups.get(epic.id);
    if (acc) result.push(toGroup(epic.id, acc));
  }
  const noEpic = groups.get(null);
  if (noEpic) result.push(toGroup(null, noEpic));

  return result;
}

export function Column({ column, items, allItems, collapsedIds, onToggleCollapse, onCardClick, onNewItem }: Props) {
  const groups = buildGroups(items, allItems);
  const isCancelled = column.role === 'cancelled';
  const key = (id: string) => `${column.id}::${id}`;

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        background: '#f5f5f5',
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
        borderBottom: '1px solid #e0e0e0',
      }}>
        <span style={{ fontWeight: 600, color: isCancelled ? '#999' : undefined }}>{column.name}</span>
        <span style={{ color: '#888', fontSize: 14 }}>{items.length}</span>
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
          const epicCollapsed = group.epicId != null && collapsedIds.has(key(group.epicId));
          return (
            <div key={group.epicId ?? '__no_epic__'}>
              {/* Epic group header — label + per-column collapse toggle (skip "No epic") */}
              {group.epicId != null && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 8,
                  marginBottom: 4,
                }}>
                  <button
                    onClick={() => onToggleCollapse(key(group.epicId!))}
                    title={epicCollapsed
                      ? `Show items in ${group.epicTitle}`
                      : `Hide items in ${group.epicTitle}`}
                    style={{
                      flexShrink: 0,
                      border: '1px solid #e0e0e0',
                      background: epicCollapsed ? '#eee' : '#fff',
                      borderRadius: 4,
                      padding: '0 5px',
                      fontSize: 11,
                      color: '#666',
                      cursor: 'pointer',
                    }}
                  >
                    {epicCollapsed ? '▸' : '▾'}
                  </button>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#aaa',
                    textTransform: 'uppercase',
                    letterSpacing: '0.07em',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}>
                    {group.epicTitle}
                  </span>
                  <div style={{ flex: 1, height: 1, background: '#e0e0e0' }} />
                </div>
              )}

              {!epicCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
                  {/* The epic's own card, when its derived status is this column */}
                  {group.epicCard && (
                    <Card
                      item={group.epicCard}
                      childCount={group.stories.length}
                      collapsed={epicCollapsed}
                      onToggleCollapse={() => onToggleCollapse(key(group.epicId!))}
                      onClick={() => onCardClick(group.epicCard!)}
                    />
                  )}

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
                          onClick={() => onCardClick(section.story)}
                        />
                        {!storyCollapsed && section.tasks.map((task) => (
                          <div
                            key={task.id}
                            style={{ marginLeft: 14, borderLeft: '2px solid #d0d0d0', paddingLeft: 6 }}
                          >
                            <Card
                              item={task}
                              parentTitle={section.story.title}
                              onClick={() => onCardClick(task)}
                            />
                          </div>
                        ))}
                      </div>
                    );
                  })}

                  {/* Leaves with no story ancestor — rendered top-level */}
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
          );
        })}
      </div>
    </div>
  );
}
