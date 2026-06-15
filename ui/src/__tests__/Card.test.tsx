import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Card } from '../components/Card';
import type { Item } from '../types';

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

describe('Card add-child button', () => {
  it('renders a "+" when onAddChild is provided and fires it without selecting the card', () => {
    const onAddChild = vi.fn();
    const onClick = vi.fn();
    render(<Card item={story} onAddChild={onAddChild} onClick={onClick} />);

    const plus = screen.getByTitle('Add a child to Login flow');
    fireEvent.click(plus);

    expect(onAddChild).toHaveBeenCalledTimes(1);
    // The click must not bubble to the card (which would open the detail panel)
    expect(onClick).not.toHaveBeenCalled();
  });

  it('omits the "+" when onAddChild is not provided (e.g. leaf cards)', () => {
    render(<Card item={{ ...story, type: 'task' }} onClick={() => {}} />);
    expect(screen.queryByTitle(/Add a child to/)).toBeNull();
  });
});
