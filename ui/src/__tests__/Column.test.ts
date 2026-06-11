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
    ...overrides,
  };
}

describe('buildGroups (Column hierarchy grouping)', () => {
  it('renders the epic above its stories and tasks even when the epic has the highest position', () => {
    // Mirrors the rollup behaviour: the epic is moved into the column AFTER
    // its children, so its position is larger than theirs.
    const task = makeItem({ id: 'task1', type: 'task', parent_id: 'story1', position: 4 });
    const story = makeItem({ id: 'story1', type: 'story', parent_id: 'epic1', position: 5 });
    const epic = makeItem({ id: 'epic1', type: 'epic', position: 6, title: 'Epic One' });
    const all = [task, story, epic];

    const groups = buildGroups(all, all);

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBe('epic1');
    expect(groups[0].orderedItems.map((i) => i.id)).toEqual(['epic1', 'story1', 'task1']);
  });

  it('keeps a parent story above its tasks in the "No epic" group regardless of position', () => {
    // Mirrors the reported Done column: tasks at positions 0,1,2,10 and the
    // parent story (no epic) at position 11 — the story must render first.
    const t1 = makeItem({ id: 't1', type: 'task', parent_id: 's1', position: 0 });
    const t2 = makeItem({ id: 't2', type: 'task', parent_id: 's1', position: 1 });
    const t3 = makeItem({ id: 't3', type: 'task', parent_id: 's1', position: 10 });
    const s1 = makeItem({ id: 's1', type: 'story', parent_id: null, position: 11 });
    const all = [t1, t2, t3, s1];

    const groups = buildGroups(all, all);

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBeNull();
    expect(groups[0].orderedItems.map((i) => i.id)).toEqual(['s1', 't1', 't2', 't3']);
  });

  it('nests tasks under their own story when multiple no-epic stories share a column', () => {
    const s1 = makeItem({ id: 's1', type: 'story', position: 1 });
    const s2 = makeItem({ id: 's2', type: 'story', position: 2 });
    const t1 = makeItem({ id: 't1', type: 'task', parent_id: 's1', position: 8 });
    const t2 = makeItem({ id: 't2', type: 'task', parent_id: 's2', position: 9 });
    const loose = makeItem({ id: 'loose', type: 'task', parent_id: null, position: 3 });
    const all = [s1, s2, t1, t2, loose];

    const groups = buildGroups(all, all);

    expect(groups).toHaveLength(1);
    // Each story followed by its tasks; parentless tasks last
    expect(groups[0].orderedItems.map((i) => i.id)).toEqual(['s1', 't1', 's2', 't2', 'loose']);
  });

  it('groups stories under their epic header when the epic card is in another column', () => {
    const epic = makeItem({ id: 'epic1', type: 'epic', position: 0, column_id: 'progress', title: 'Epic One' });
    const story = makeItem({ id: 'story1', type: 'story', parent_id: 'epic1', position: 7 });
    const task = makeItem({ id: 'task1', type: 'task', parent_id: 'story1', position: 3 });
    const all = [epic, story, task];

    // Column only contains the story and task — epic lives elsewhere
    const groups = buildGroups([story, task], all);

    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBe('epic1');
    expect(groups[0].epicTitle).toBe('Epic One');
    expect(groups[0].orderedItems.map((i) => i.id)).toEqual(['story1', 'task1']);
  });

  it('puts tasks whose parent story is not in the column after in-column stories, and the No-epic group last', () => {
    const epic = makeItem({ id: 'epic1', type: 'epic', position: 9, title: 'Epic One' });
    const storyElsewhere = makeItem({ id: 'storyX', type: 'story', parent_id: 'epic1', column_id: 'progress', position: 1 });
    const storyHere = makeItem({ id: 'storyY', type: 'story', parent_id: 'epic1', position: 2 });
    const orphanTask = makeItem({ id: 'orphan', type: 'task', parent_id: 'storyX', position: 0 });
    const noEpicTask = makeItem({ id: 'free', type: 'task', parent_id: null, position: 0 });
    const all = [epic, storyElsewhere, storyHere, orphanTask, noEpicTask];

    const groups = buildGroups([epic, storyHere, orphanTask, noEpicTask], all);

    expect(groups.map((g) => g.epicId)).toEqual(['epic1', null]);
    expect(groups[0].orderedItems.map((i) => i.id)).toEqual(['epic1', 'storyY', 'orphan']);
    expect(groups[1].orderedItems.map((i) => i.id)).toEqual(['free']);
  });
});
