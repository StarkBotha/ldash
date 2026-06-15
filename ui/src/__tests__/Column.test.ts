import { describe, it, expect } from 'vitest';
import { buildGroups } from '../components/Column';
import type { Item, ItemType } from '../types';

let seq = 0;
function makeItem(overrides: Partial<Item> & { id: string; type: ItemType }): Item {
  seq += 1;
  return {
    project_id: 'p1',
    parent_id: null,
    number: seq,
    key: `TST-${seq}`,
    title: overrides.id,
    description: '',
    column_id: 'done',
    position: 0,
    flagged: false,
    blocked: false,
    blocked_reason: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    column_changed_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const storyIds = (g: ReturnType<typeof buildGroups>[number]) => g.stories.map((s) => s.story.id);
const tasksOf = (g: ReturnType<typeof buildGroups>[number], storyId: string) =>
  g.stories.find((s) => s.story.id === storyId)?.tasks.map((t) => t.id) ?? [];

describe('buildGroups (Column hierarchy grouping)', () => {
  it('returns the epic card and its story sections', () => {
    // Mirrors the rollup: the epic is moved into the column AFTER its children,
    // so its position is larger — it must still head the group.
    const task = makeItem({ id: 'task1', type: 'task', parent_id: 'story1', position: 4 });
    const story = makeItem({ id: 'story1', type: 'story', parent_id: 'epic1', position: 5 });
    const epic = makeItem({ id: 'epic1', type: 'epic', position: 6, title: 'Epic One' });
    const all = [task, story, epic];

    const groups = buildGroups(all, all);

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBe('epic1');
    expect(groups[0].epicCard?.id).toBe('epic1');
    expect(storyIds(groups[0])).toEqual(['story1']);
    expect(tasksOf(groups[0], 'story1')).toEqual(['task1']);
    expect(groups[0].looseLeaves).toHaveLength(0);
  });

  it('orders a story section\'s tasks by position, story first', () => {
    const t1 = makeItem({ id: 't1', type: 'task', parent_id: 's1', position: 0 });
    const t2 = makeItem({ id: 't2', type: 'task', parent_id: 's1', position: 1 });
    const t3 = makeItem({ id: 't3', type: 'task', parent_id: 's1', position: 10 });
    const s1 = makeItem({ id: 's1', type: 'story', parent_id: null, position: 11 });
    const all = [t1, t2, t3, s1];

    const groups = buildGroups(all, all);

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBeNull();
    expect(storyIds(groups[0])).toEqual(['s1']);
    expect(tasksOf(groups[0], 's1')).toEqual(['t1', 't2', 't3']);
  });

  it('nests tasks under their own story; parentless leaves go to looseLeaves', () => {
    const s1 = makeItem({ id: 's1', type: 'story', position: 1 });
    const s2 = makeItem({ id: 's2', type: 'story', position: 2 });
    const t1 = makeItem({ id: 't1', type: 'task', parent_id: 's1', position: 8 });
    const t2 = makeItem({ id: 't2', type: 'task', parent_id: 's2', position: 9 });
    const loose = makeItem({ id: 'loose', type: 'task', parent_id: null, position: 3 });
    const all = [s1, s2, t1, t2, loose];

    const groups = buildGroups(all, all);

    expect(groups).toHaveLength(1);
    expect(storyIds(groups[0])).toEqual(['s1', 's2']);
    expect(tasksOf(groups[0], 's1')).toEqual(['t1']);
    expect(tasksOf(groups[0], 's2')).toEqual(['t2']);
    expect(groups[0].looseLeaves.map((i) => i.id)).toEqual(['loose']);
  });

  it('groups stories under their epic header even when the epic card is in another column', () => {
    const epic = makeItem({ id: 'epic1', type: 'epic', position: 0, column_id: 'progress', title: 'Epic One' });
    const story = makeItem({ id: 'story1', type: 'story', parent_id: 'epic1', position: 7 });
    const task = makeItem({ id: 'task1', type: 'task', parent_id: 'story1', position: 3 });
    const all = [epic, story, task];

    // Column only contains the story and task — epic lives elsewhere
    const groups = buildGroups([story, task], all);

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBe('epic1');
    expect(groups[0].epicTitle).toBe('Epic One');
    expect(groups[0].epicCard).toBeNull(); // epic card is in another column
    expect(storyIds(groups[0])).toEqual(['story1']);
    expect(tasksOf(groups[0], 'story1')).toEqual(['task1']);
  });

  it('synthesizes a story header in a column where the story\'s own status is elsewhere (LDA-75)', () => {
    // The core fix: a leaf whose parent story lives (by derived status) in
    // another column still gets its own story header here, so this column can
    // collapse it independently rather than the leaf vanishing.
    const storyElsewhere = makeItem({ id: 'storyX', type: 'story', column_id: 'progress', position: 1 });
    const task = makeItem({ id: 'taskX', type: 'task', parent_id: 'storyX', column_id: 'done', position: 2 });
    const all = [storyElsewhere, task];

    const groups = buildGroups([task], all); // column 'done' holds only the task

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBeNull();
    expect(storyIds(groups[0])).toEqual(['storyX']);
    expect(tasksOf(groups[0], 'storyX')).toEqual(['taskX']);
    expect(groups[0].looseLeaves).toHaveLength(0);
  });

  it('places a leaf parented directly to an epic in looseLeaves (no story section)', () => {
    const epic = makeItem({ id: 'epic1', type: 'epic', position: 0, title: 'Epic One' });
    const epicTask = makeItem({ id: 'epicTask', type: 'task', parent_id: 'epic1', position: 1 });
    const all = [epic, epicTask];

    const groups = buildGroups(all, all);

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBe('epic1');
    expect(groups[0].epicCard?.id).toBe('epic1');
    expect(groups[0].stories).toHaveLength(0);
    expect(groups[0].looseLeaves.map((i) => i.id)).toEqual(['epicTask']);
  });

  it('mixes own + synthesized story headers and a No-epic group, ordered correctly', () => {
    const epic = makeItem({ id: 'epic1', type: 'epic', position: 9, title: 'Epic One' });
    const storyElsewhere = makeItem({ id: 'storyX', type: 'story', parent_id: 'epic1', column_id: 'progress', position: 1 });
    const storyHere = makeItem({ id: 'storyY', type: 'story', parent_id: 'epic1', position: 2 });
    const orphanTask = makeItem({ id: 'orphan', type: 'task', parent_id: 'storyX', position: 0 });
    const noEpicTask = makeItem({ id: 'free', type: 'task', parent_id: null, position: 0 });
    const all = [epic, storyElsewhere, storyHere, orphanTask, noEpicTask];

    const groups = buildGroups([epic, storyHere, orphanTask, noEpicTask], all);

    expect(groups.map((g) => g.epicId)).toEqual(['epic1', null]);
    expect(groups[0].epicCard?.id).toBe('epic1');
    // storyX (pos 1, synthesized for its orphan) before storyY (pos 2, own card)
    expect(storyIds(groups[0])).toEqual(['storyX', 'storyY']);
    expect(tasksOf(groups[0], 'storyX')).toEqual(['orphan']);
    expect(tasksOf(groups[0], 'storyY')).toEqual([]);
    expect(groups[1].epicId).toBeNull();
    expect(groups[1].looseLeaves.map((i) => i.id)).toEqual(['free']);
  });
});
