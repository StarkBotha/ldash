import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../App';

// Mock the API client so tests don't need a running server
vi.mock('../api/client', () => ({
  api: {
    projects: {
      list: vi.fn().mockResolvedValue([]),
    },
    columns: {
      list: vi.fn().mockResolvedValue([]),
    },
    items: {
      listByProject: vi.fn().mockResolvedValue([]),
    },
  },
}));

function renderApp() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  );
}

describe('App smoke test', () => {
  it('renders and shows the New project button', async () => {
    renderApp();
    // The ProjectList shows a "New project" button
    const btn = await screen.findByText('New project');
    expect(btn).toBeTruthy();
  });
});
