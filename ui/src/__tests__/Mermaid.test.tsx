import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Mermaid } from '../components/Mermaid';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: { initialize: mocks.initialize, render: mocks.render },
}));

beforeEach(() => {
  mocks.render.mockReset();
});

describe('Mermaid', () => {
  it('renders the diagram SVG on success', async () => {
    mocks.render.mockResolvedValue({ svg: '<svg><text>my diagram</text></svg>' });

    const { container } = render(<Mermaid code="graph TD; A-->B" />);

    await waitFor(() => {
      expect(container.querySelector('.kb-mermaid svg')).toBeTruthy();
    });
    expect(screen.getByText('my diagram')).toBeTruthy();
    expect(mocks.render).toHaveBeenCalledWith(expect.any(String), 'graph TD; A-->B');
  });

  it('falls back to the raw code block plus an error note on failure', async () => {
    mocks.render.mockRejectedValue(new Error('Parse error on line 1'));

    const { container } = render(<Mermaid code="graph TD; this is broken" />);

    expect(await screen.findByText('graph TD; this is broken')).toBeTruthy();
    expect(
      screen.getByText(/Mermaid diagram failed to render: Parse error on line 1/)
    ).toBeTruthy();
    expect(container.querySelector('.kb-mermaid-error pre code')).toBeTruthy();
  });
});
