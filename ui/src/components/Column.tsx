import { Card } from './Card';
import { isWorkItemType } from '../types';
import type { Column as ColumnType, Item } from '../types';

interface Props {
  column: ColumnType;
  items: Item[];
  allItems: Item[];
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
  onCardClick: (item: Item) => void;
  onNewItem: () => void;
}

/** Walk parent_id up through allItems to find the root epic ancestor id.
 *  Returns the epic's id, or null if no epic ancestor exists. */
function getRootEpicId(item: Item, allItems: Item[]): string | null {
  const byId = new Map(allItems.map((i) => [i.id, i]));
  let current: Item | undefined = item;
  let epicId: string | null = null;
  while (current) {
    if (current.type === 'epic') {
      epicId = current.id;
      break;
    }
    if (current.parent_id == null) break;
    current = byId.get(current.parent_id);
  }
  return epicId;
}

interface EpicGroup {
  epicId: string | null; // null = "No epic"
  epicTitle: string;
  /** Cards to render in order for this group */
  orderedItems: Item[];
  /** Ids of work items rendered directly under their parent story in this
   *  group — only these get the child indent. Orphans (no parent, parent in
   *  another column, or parented straight to the epic) render top-level. */
  indentedIds: Set<string>;
}

/** Order a group's stories and work items (tasks/bugs/investigations)
 *  hierarchically: each story (by position) followed by its work items in this
 *  column, then work items whose parent story is not in the column. Ignores
 *  epics — the caller places the epic card first. Work items emitted under
 *  their own story are recorded in indentedIds. */
function orderStoriesAndTasks(members: Item[], indentedIds: Set<string>): Item[] {
  const stories = members.filter((i) => i.type === 'story').sort((a, b) => a.position - b.position);
  const memberStoryIds = new Set(stories.map((s) => s.id));
  // work items whose parent story is NOT in this column's member set
  const orphanTasks = members.filter(
    (i) => isWorkItemType(i.type) && (i.parent_id == null || !memberStoryIds.has(i.parent_id))
  ).sort((a, b) => a.position - b.position);

  const ordered: Item[] = [];
  for (const story of stories) {
    ordered.push(story);
    // Work items in this column whose parent is this story
    const storyTasks = members
      .filter((i) => isWorkItemType(i.type) && i.parent_id === story.id)
      .sort((a, b) => a.position - b.position);
    for (const t of storyTasks) indentedIds.add(t.id);
    ordered.push(...storyTasks);
  }
  ordered.push(...orphanTasks);
  return ordered;
}

export function buildGroups(columnItems: Item[], allItems: Item[]): EpicGroup[] {
  // All epics in the entire project (not just this column), for ordering groups
  const allEpics = allItems
    .filter((i) => i.type === 'epic')
    .sort((a, b) => a.position - b.position);

  // Assign each column item to its root epic group
  const groupMap = new Map<string | null, Item[]>();
  for (const item of columnItems) {
    const epicId = getRootEpicId(item, allItems);
    if (!groupMap.has(epicId)) groupMap.set(epicId, []);
    groupMap.get(epicId)!.push(item);
  }

  const groups: EpicGroup[] = [];

  // Process epic groups in project-level epic position order
  for (const epic of allEpics) {
    if (!groupMap.has(epic.id)) continue;

    const members = groupMap.get(epic.id)!;

    // Epic card always renders first in its group (regardless of its position
    // value — the rollup can move it into a column after its children, giving
    // it a higher position), then stories with their tasks nested.
    const epicCard = members.find((i) => i.id === epic.id) ?? null;
    const orderedItems: Item[] = [];
    const indentedIds = new Set<string>();
    if (epicCard) orderedItems.push(epicCard);
    orderedItems.push(...orderStoriesAndTasks(members, indentedIds));

    groups.push({ epicId: epic.id, epicTitle: epic.title, orderedItems, indentedIds });
  }

  // "No epic" group last — same hierarchical ordering, so a parent story
  // never sinks below its own tasks just because its position is higher.
  if (groupMap.has(null)) {
    const indentedIds = new Set<string>();
    const orderedItems = orderStoriesAndTasks(groupMap.get(null)!, indentedIds);
    groups.push({ epicId: null, epicTitle: 'No epic', orderedItems, indentedIds });
  }

  return groups;
}

export function Column({ column, items, allItems, collapsedIds, onToggleCollapse, onCardClick, onNewItem }: Props) {
  const groups = buildGroups(items, allItems);
  const isCancelled = column.role === 'cancelled';

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
        {groups.map((group) => (
          <div key={group.epicId ?? '__no_epic__'}>
            {/* Epic group header — label + collapse toggle (skip "No epic") */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 8,
              marginBottom: 4,
            }}>
              {group.epicId != null && (
                <button
                  onClick={() => onToggleCollapse(group.epicId!)}
                  title={collapsedIds.has(group.epicId)
                    ? `Show items in ${group.epicTitle}`
                    : `Hide items in ${group.epicTitle}`}
                  style={{
                    flexShrink: 0,
                    border: '1px solid #e0e0e0',
                    background: collapsedIds.has(group.epicId) ? '#eee' : '#fff',
                    borderRadius: 4,
                    padding: '0 5px',
                    fontSize: 11,
                    color: '#666',
                    cursor: 'pointer',
                  }}
                >
                  {collapsedIds.has(group.epicId) ? '▸' : '▾'}
                </button>
              )}
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

            {/* Cards in this group */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
              {group.orderedItems.map((item) => {
                const parent = item.parent_id ? allItems.find((i) => i.id === item.parent_id) : undefined;
                const isTask = isWorkItemType(item.type);
                const childCount = isTask
                  ? undefined
                  : allItems.filter((i) => i.parent_id === item.id).length;
                // Indent only when the parent story card is rendered directly
                // above in this group — orphan leaves stay top-level.
                const indented = group.indentedIds.has(item.id);
                return (
                  <div
                    key={item.id}
                    style={indented ? {
                      marginLeft: 14,
                      borderLeft: '2px solid #d0d0d0',
                      paddingLeft: 6,
                    } : undefined}
                  >
                    <Card
                      item={item}
                      parentTitle={parent?.title}
                      childCount={childCount}
                      collapsed={collapsedIds.has(item.id)}
                      onToggleCollapse={() => onToggleCollapse(item.id)}
                      onClick={() => onCardClick(item)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
