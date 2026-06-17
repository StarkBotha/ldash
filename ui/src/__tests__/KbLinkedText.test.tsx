import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KbLinkedText } from '../components/KbLinkedText';

describe('KbLinkedText', () => {
  it('links a KB key to the project KB deep-link, opening in a new tab', () => {
    render(<KbLinkedText text="KB: updated LDA-KB-12 today" projectName="ldash" prefix="LDA" />);
    const link = screen.getByRole('link', { name: 'LDA-KB-12' });
    expect(link.getAttribute('href')).toBe('/projects/ldash/kb/lda-kb-12');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('does NOT link board item keys (no -KB-)', () => {
    render(<KbLinkedText text="see LDA-96 for context" projectName="ldash" prefix="LDA" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/see LDA-96 for context/)).toBeTruthy();
  });

  it('links multiple keys and preserves surrounding text', () => {
    render(
      <KbLinkedText text="LDA-KB-1 and LDA-KB-13 both apply" projectName="ldash" prefix="LDA" />
    );
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/projects/ldash/kb/lda-kb-1',
      '/projects/ldash/kb/lda-kb-13',
    ]);
  });

  it('only links the current project prefix', () => {
    render(<KbLinkedText text="LDA-KB-2 vs DUN-KB-2" projectName="ldash" prefix="LDA" />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('LDA-KB-2');
  });

  it('renders plain text when the project is not yet known', () => {
    render(<KbLinkedText text="LDA-KB-12" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('LDA-KB-12')).toBeTruthy();
  });
});
