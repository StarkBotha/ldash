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
