import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Card } from './Card';
import type { Column as ColumnType, Item } from '../types';

interface Props {
  column: ColumnType;
  items: Item[];
  allItems: Item[];
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
}

function buildGroups(columnItems: Item[], allItems: Item[]): EpicGroup[] {
  // Map of all items for fast lookup
  const byId = new Map(allItems.map((i) => [i.id, i]));

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

    // Separate this column's members by type
    const epicCard = members.find((i) => i.id === epic.id) ?? null;
    const stories = members.filter((i) => i.type === 'story').sort((a, b) => a.position - b.position);
    // tasks whose parent story IS in this column's member set
    const memberStoryIds = new Set(stories.map((s) => s.id));
    const orphanTasks = members.filter(
      (i) => i.type === 'task' && (i.parent_id == null || !memberStoryIds.has(i.parent_id))
    ).sort((a, b) => a.position - b.position);

    const orderedItems: Item[] = [];
    if (epicCard) orderedItems.push(epicCard);
    for (const story of stories) {
      orderedItems.push(story);
      // Tasks in this column whose parent is this story
      const storyTasks = members
        .filter((i) => i.type === 'task' && i.parent_id === story.id)
        .sort((a, b) => a.position - b.position);
      orderedItems.push(...storyTasks);
    }
    // Tasks whose parent story is not in this column
    orderedItems.push(...orphanTasks);

    groups.push({ epicId: epic.id, epicTitle: epic.title, orderedItems });
  }

  // "No epic" group last
  if (groupMap.has(null)) {
    const noEpicItems = groupMap.get(null)!.sort((a, b) => a.position - b.position);
    groups.push({ epicId: null, epicTitle: 'No epic', orderedItems: noEpicItems });
  }

  return groups;
}

export function Column({ column, items, allItems, onCardClick, onNewItem }: Props) {
  const groups = buildGroups(items, allItems);

  // SortableContext items list must match the render order across all groups
  const itemIds = groups.flatMap((g) => g.orderedItems.map((i) => i.id));

  const { setNodeRef } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
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
        <span style={{ fontWeight: 600 }}>{column.name}</span>
        <span style={{ color: '#888', fontSize: 14 }}>{items.length}</span>
        <button
          onClick={onNewItem}
          style={{ marginLeft: 8, padding: '2px 8px', fontSize: 16, cursor: 'pointer' }}
          title={`Add item to ${column.name}`}
        >
          +
        </button>
      </div>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 0 }}>
          {groups.map((group) => (
            <div key={group.epicId ?? '__no_epic__'}>
              {/* Epic group header — label only, not draggable */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 8,
                marginBottom: 4,
              }}>
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
                  const isTask = item.type === 'task';
                  return (
                    <div
                      key={item.id}
                      style={isTask ? {
                        marginLeft: 14,
                        borderLeft: '2px solid #d0d0d0',
                        paddingLeft: 6,
                      } : undefined}
                    >
                      <Card item={item} parentTitle={parent?.title} onClick={() => onCardClick(item)} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
