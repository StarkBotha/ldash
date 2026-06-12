import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpTip } from '../components/HelpTip';

function renderTip() {
  return render(
    <div>
      <span>outside</span>
      <HelpTip>
        <p>How this search works.</p>
      </HelpTip>
    </div>
  );
}

describe('HelpTip', () => {
  it('clicking the "?" shows the panel; clicking again hides it', () => {
    renderTip();
    expect(screen.queryByText('How this search works.')).toBeNull();

    const button = screen.getByLabelText('Search help');
    fireEvent.click(button);
    expect(screen.getByText('How this search works.')).toBeTruthy();

    fireEvent.click(button);
    expect(screen.queryByText('How this search works.')).toBeNull();
  });

  it('Escape hides the panel', () => {
    renderTip();
    fireEvent.click(screen.getByLabelText('Search help'));
    expect(screen.getByText('How this search works.')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('How this search works.')).toBeNull();
  });

  it('clicking outside hides the panel; clicking inside it does not', () => {
    renderTip();
    fireEvent.click(screen.getByLabelText('Search help'));

    fireEvent.mouseDown(screen.getByText('How this search works.'));
    expect(screen.getByText('How this search works.')).toBeTruthy();

    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByText('How this search works.')).toBeNull();
  });
});
