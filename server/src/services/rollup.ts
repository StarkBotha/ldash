import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type { ItemService } from './items.js';
import type { ActivityService } from './activity.js';
import type { ColumnService } from './columns.js';
import type { EventBus } from '../events/bus.js';
import { isWorkItemType, type Item } from '../types.js';

/**
 * List the direct children of an item that are leaf work items
 * (task/bug/investigation) — the inputs to status rollup.
 */
function listWorkChildren(itemService: ItemService, projectId: string, parentId: string): Item[] {
  return itemService
    .listFiltered({ project_id: projectId, parent_id: parentId })
    .filter((i) => isWorkItemType(i.type));
}

/**
 * Derive the target column for an aggregate item (story or epic) based on
 * the column positions of its descendant work items (tasks/bugs/investigations).
 *
 * The cancelled column is identified explicitly by role='cancelled' (not by
 * position — it sits after Done, so "last = done" would break). Positional
 * semantics apply to the remaining (non-cancelled) columns:
 *   FIRST  (lowest position)  = not-started
 *   LAST   (highest position, excluding cancelled) = done
 *   SECOND (index 1)          = in-progress representative
 *
 * Rules:
 *   - No work items → return null (don't touch the item)
 *   - ALL work items cancelled → cancelled column id
 *   - Otherwise cancelled work items are EXCLUDED, and the non-cancelled rest
 *     derive as before:
 *     - All in FIRST column → FIRST column id
 *     - All in DONE column → DONE column id
 *     - Otherwise → SECOND column id
 */
function deriveColumnId(
  tasks: Item[],
  sortedColumns: { id: string; position: number; role: string | null }[]
): string | null {
  if (tasks.length === 0) return null;
  if (sortedColumns.length === 0) return null;

  const cancelledCol = sortedColumns.find((c) => c.role === 'cancelled');
  const activeColumns = sortedColumns.filter((c) => c.role !== 'cancelled');
  if (activeColumns.length === 0) return null;

  const activeTasks = cancelledCol
    ? tasks.filter((t) => t.column_id !== cancelledCol.id)
    : tasks;

  // All leaf work items cancelled → the aggregate derives to Cancelled.
  if (activeTasks.length === 0) return cancelledCol!.id;

  const firstColId = activeColumns[0].id;
  const doneColId = activeColumns[activeColumns.length - 1].id;
  const secondColId = activeColumns.length > 1 ? activeColumns[1].id : firstColId;

  const allFirst = activeTasks.every((t) => t.column_id === firstColId);
  const allDone = activeTasks.every((t) => t.column_id === doneColId);

  if (allFirst) return firstColId;
  if (allDone) return doneColId;
  return secondColId;
}

/**
 * Persist a derived move for an aggregate item (story or epic).
 * Writes activity with actor_type 'system', emits item.moved on the bus.
 * Uses the internal flag so ItemService.move bypasses the guard.
 */
function persistDerivedMove(
  item: Item,
  targetColumnId: string,
  db: Database.Database,
  itemService: ItemService,
  activityService: ActivityService,
  columnService: ColumnService,
  bus: EventBus,
  emitEvents: boolean
): void {
  const fromColumnId = item.column_id;
  const fromColumn = columnService.get(fromColumnId);
  const toColumn = columnService.get(targetColumnId);

  // Use internal flag to bypass the guard
  itemService.move(item.id, { column_id: targetColumnId }, { internal: true });

  activityService.append({
    item_id: item.id,
    project_id: item.project_id,
    actor_type: 'system',
    actor_id: 'rollup',
    event_type: 'item.moved',
    payload: {
      from_column_id: fromColumnId,
      to_column_id: targetColumnId,
      from_column_name: fromColumn?.name ?? fromColumnId,
      to_column_name: toColumn?.name ?? targetColumnId,
    },
  });

  if (emitEvents) {
    const movedItem = itemService.get(item.id);
    bus.emit({
      type: 'item.moved',
      projectId: item.project_id,
      entityId: item.id,
      data: { item: movedItem, fromColumnId, toColumnId: targetColumnId },
    });
  }
}

/**
 * After a task move/create/delete, recompute the derived column of the task's
 * parent story (if any) and that story's parent epic (if any).
 *
 * Pass emitEvents=false during startup reconciliation (no clients connected).
 */
export function recomputeAncestors(
  taskId: string,
  db: Database.Database,
  itemService: ItemService,
  activityService: ActivityService,
  columnService: ColumnService,
  bus: EventBus,
  emitEvents = true
): void {
  const task = itemService.get(taskId);
  if (!task) return;

  const sortedColumns = columnService.list().sort((a, b) => a.position - b.position);

  // Find the task's parent (story or epic)
  const parentId = task.parent_id;
  if (!parentId) return;

  const parent = itemService.get(parentId);
  if (!parent) return;

  // Determine story and epic
  let storyId: string | null = null;
  let epicId: string | null = null;

  if (parent.type === 'story') {
    storyId = parent.id;
    epicId = parent.parent_id;
  } else if (parent.type === 'epic') {
    epicId = parent.id;
  }

  // Recompute story
  if (storyId) {
    const story = itemService.get(storyId)!;
    const storyTasks = listWorkChildren(itemService, story.project_id, storyId);

    const derived = deriveColumnId(storyTasks, sortedColumns);
    if (derived !== null && derived !== story.column_id) {
      persistDerivedMove(story, derived, db, itemService, activityService, columnService, bus, emitEvents);
    }
  }

  // Recompute epic (no recursion beyond story → epic)
  if (epicId) {
    const epic = itemService.get(epicId);
    if (!epic) return;

    // Get ALL descendant tasks: direct task children of epic + tasks of epic's stories
    const epicStories = itemService.listFiltered({
      project_id: epic.project_id,
      type: 'story',
      parent_id: epicId,
    });

    const storyIds = epicStories.map((s) => s.id);
    let allDescendantTasks: Item[] = [];

    // Direct work item children of epic
    const directTasks = listWorkChildren(itemService, epic.project_id, epicId);
    allDescendantTasks.push(...directTasks);

    // Work items of each story under this epic
    for (const sid of storyIds) {
      const storyTasks = listWorkChildren(itemService, epic.project_id, sid);
      allDescendantTasks.push(...storyTasks);
    }

    const derivedEpic = deriveColumnId(allDescendantTasks, sortedColumns);
    if (derivedEpic !== null && derivedEpic !== epic.column_id) {
      persistDerivedMove(epic, derivedEpic, db, itemService, activityService, columnService, bus, emitEvents);
    }
  }
}

/**
 * Recompute ancestors starting from a known parent item id (used when the
 * triggering task has already been deleted from the DB).
 */
export function recomputeAncestorsByParent(
  parentId: string,
  projectId: string,
  db: Database.Database,
  itemService: ItemService,
  activityService: ActivityService,
  columnService: ColumnService,
  bus: EventBus,
  emitEvents = true
): void {
  const sortedColumns = columnService.list().sort((a, b) => a.position - b.position);
  const parent = itemService.get(parentId);
  if (!parent) return;

  let storyId: string | null = null;
  let epicId: string | null = null;

  if (parent.type === 'story') {
    storyId = parent.id;
    epicId = parent.parent_id;
  } else if (parent.type === 'epic') {
    epicId = parent.id;
  }

  if (storyId) {
    const story = itemService.get(storyId)!;
    const storyTasks = listWorkChildren(itemService, projectId, storyId);

    const derived = deriveColumnId(storyTasks, sortedColumns);
    if (derived !== null && derived !== story.column_id) {
      persistDerivedMove(story, derived, db, itemService, activityService, columnService, bus, emitEvents);
    }
  }

  if (epicId) {
    const epic = itemService.get(epicId);
    if (!epic) return;

    const epicStories = itemService.listFiltered({
      project_id: projectId,
      type: 'story',
      parent_id: epicId,
    });

    let allDescendantTasks: Item[] = [];

    const directTasks = listWorkChildren(itemService, projectId, epicId);
    allDescendantTasks.push(...directTasks);

    for (const s of epicStories) {
      const storyTasks = listWorkChildren(itemService, projectId, s.id);
      allDescendantTasks.push(...storyTasks);
    }

    const derivedEpic = deriveColumnId(allDescendantTasks, sortedColumns);
    if (derivedEpic !== null && derivedEpic !== epic.column_id) {
      persistDerivedMove(epic, derivedEpic, db, itemService, activityService, columnService, bus, emitEvents);
    }
  }
}

/**
 * One-time startup reconciliation: recompute all stories and epics across
 * all projects. Activity entries are written; events are skipped (no clients
 * are connected yet).
 */
export function reconcileAllOnStartup(
  db: Database.Database,
  itemService: ItemService,
  activityService: ActivityService,
  columnService: ColumnService,
  bus: EventBus
): void {
  const sortedColumns = columnService.list().sort((a, b) => a.position - b.position);
  if (sortedColumns.length === 0) return;

  // Get all items
  const allProjectIds = (db.prepare('SELECT DISTINCT project_id FROM items').all() as { project_id: string }[])
    .map((r) => r.project_id);

  for (const projectId of allProjectIds) {
    // Recompute all stories in this project
    const stories = itemService.listFiltered({ project_id: projectId, type: 'story' });
    for (const story of stories) {
      const storyTasks = listWorkChildren(itemService, projectId, story.id);

      const derived = deriveColumnId(storyTasks, sortedColumns);
      if (derived !== null && derived !== story.column_id) {
        // Refetch in case a previous iteration moved it
        const currentStory = itemService.get(story.id);
        if (currentStory && derived !== currentStory.column_id) {
          persistDerivedMove(currentStory, derived, db, itemService, activityService, columnService, bus, false);
        }
      }
    }

    // Recompute all epics in this project
    const epics = itemService.listFiltered({ project_id: projectId, type: 'epic' });
    for (const epic of epics) {
      const epicStories = itemService.listFiltered({
        project_id: projectId,
        type: 'story',
        parent_id: epic.id,
      });

      let allDescendantTasks: Item[] = [];

      const directTasks = listWorkChildren(itemService, projectId, epic.id);
      allDescendantTasks.push(...directTasks);

      for (const s of epicStories) {
        const storyTasks = listWorkChildren(itemService, projectId, s.id);
        allDescendantTasks.push(...storyTasks);
      }

      const derivedEpic = deriveColumnId(allDescendantTasks, sortedColumns);
      if (derivedEpic !== null) {
        const currentEpic = itemService.get(epic.id);
        if (currentEpic && derivedEpic !== currentEpic.column_id) {
          persistDerivedMove(currentEpic, derivedEpic, db, itemService, activityService, columnService, bus, false);
        }
      }
    }
  }
}
