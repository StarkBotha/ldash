import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ItemForm } from '../components/ItemForm';
import type { Column, Item } from '../types';

// ItemForm only needs these hooks to exist; the defaults we test are pure state.
vi.mock('../hooks/useBoard', () => ({
  useCreateItem: () => ({ mutateAsync: vi.fn() }),
  useUpdateItem: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useItemDetail', () => ({
  useAttachments: () => ({ data: { attachments: [] } }),
  useUploadAttachment: () => ({ mutateAsync: vi.fn() }),
}));

const columns: Column[] = [
  { id: 'c1', name: 'Backlog', position: 0, role: null, created_at: '', updated_at: '' },
];

// A fuller column set for parent-filter tests: Backlog, In Progress, Done, Cancelled.
const fullColumns: Column[] = [
  { id: 'backlog', name: 'Backlog', position: 0, role: null, created_at: '', updated_at: '' },
  { id: 'inprog', name: 'In Progress', position: 1, role: null, created_at: '', updated_at: '' },
  { id: 'done', name: 'Done', position: 2, role: null, created_at: '', updated_at: '' },
  { id: 'cancelled', name: 'Cancelled', position: 3, role: 'cancelled', created_at: '', updated_at: '' },
];

function mkItem(over: Partial<Item> & Pick<Item, 'id' | 'type' | 'key' | 'column_id'>): Item {
  return {
    project_id: 'p1',
    parent_id: null,
    number: 1,
    title: over.key,
    description: '',
    position: 0,
    flagged: false,
    blocked: false,
    blocked_reason: '',
    created_at: '',
    updated_at: '',
    column_changed_at: '',
    ...over,
  } as Item;
}

const story: Item = {
  id: 's1',
  project_id: 'p1',
  parent_id: null,
  type: 'story',
  number: 1,
  key: 'DEM-1',
  title: 'Login flow',
  description: '',
  column_id: 'c1',
  position: 0,
  flagged: false,
  blocked: false,
  blocked_reason: '',
  created_at: '',
  updated_at: '',
  column_changed_at: '',
};

function selects() {
  return screen.getAllByRole('combobox') as HTMLSelectElement[];
}

function parentOptionTexts() {
  // Parent is the second combobox (after Type) for a new item
  const parent = selects()[1];
  return Array.from(parent.options).map((o) => o.textContent ?? '');
}

describe('ItemForm defaults', () => {
  it('defaults the type to task when no defaultType is given', () => {
    render(<ItemForm projectId="p1" columnId="c1" columns={columns} items={[]} onClose={() => {}} />);
    // Order in the DOM: Type, Parent, Column
    expect(selects()[0].value).toBe('task');
  });

  it('preselects defaultType (LDA-81: from-scratch adds default to story)', () => {
    render(
      <ItemForm projectId="p1" columnId="c1" columns={columns} items={[]} defaultType="story" onClose={() => {}} />
    );
    expect(selects()[0].value).toBe('story');
  });

  it('preselects defaultParentId and a task type (LDA-80: add child to a story)', () => {
    render(
      <ItemForm
        projectId="p1"
        columnId="c1"
        columns={columns}
        items={[story]}
        defaultType="task"
        defaultParentId="s1"
        onClose={() => {}}
      />
    );
    const [typeSelect, parentSelect] = selects();
    expect(typeSelect.value).toBe('task');
    expect(parentSelect.value).toBe('s1');
  });
});

describe('ItemForm parent dropdown (LDA-84)', () => {
  const epicBacklog = mkItem({ id: 'e1', type: 'epic', key: 'DEM-10', column_id: 'backlog' });
  const storyInProg = mkItem({ id: 's1', type: 'story', key: 'DEM-11', column_id: 'inprog' });
  const storyDone = mkItem({ id: 's2', type: 'story', key: 'DEM-12', column_id: 'done' });
  const taskBacklog = mkItem({ id: 't1', type: 'task', key: 'DEM-13', column_id: 'backlog' });

  it('only lists stories/epics in Backlog or In Progress, with their ticket key', () => {
    render(
      <ItemForm
        projectId="p1"
        columnId="backlog"
        columns={fullColumns}
        items={[epicBacklog, storyInProg, storyDone, taskBacklog]}
        onClose={() => {}}
      />
    );
    const opts = parentOptionTexts();
    // None + the two eligible parents
    expect(opts).toEqual(['None', 'DEM-10 [epic] DEM-10', 'DEM-11 [story] DEM-11']);
    // A Done story and a task are excluded
    expect(opts.some((o) => o.includes('DEM-12'))).toBe(false);
    expect(opts.some((o) => o.includes('DEM-13'))).toBe(false);
  });

  it('keeps a preset Done-story parent visible so it is not silently dropped', () => {
    render(
      <ItemForm
        projectId="p1"
        columnId="backlog"
        columns={fullColumns}
        items={[storyInProg, storyDone]}
        defaultParentId="s2"
        onClose={() => {}}
      />
    );
    // The Done story is outside the filter but still present and selected
    expect(parentOptionTexts().some((o) => o.includes('DEM-12'))).toBe(true);
    expect(selects()[1].value).toBe('s2');
  });
});
