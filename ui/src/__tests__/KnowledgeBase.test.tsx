import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KnowledgeBase } from '../components/KnowledgeBase';
import type { KbDocument } from '../types';

const project = {
  id: 'p1',
  name: 'demo',
  description: '',
  prefix: 'DEM',
  created_at: '2026-06-12T00:00:00Z',
  updated_at: '2026-06-12T00:00:00Z',
};

const docSummaries = [
  { id: 'd1', project_id: 'p1', title: 'Architecture', created_at: '', updated_at: '' },
  { id: 'd2', project_id: 'p1', title: 'Hosting', created_at: '', updated_at: '' },
];

const archDoc: KbDocument = {
  id: 'd1',
  project_id: 'p1',
  title: 'Architecture',
  content: '# System overview\n\n| Service | Port |\n| ------- | ---- |\n| api | 3000 |\n',
  created_at: '',
  updated_at: '',
};

// Mock the API client so tests don't need a running server
vi.mock('../api/client', () => ({
  api: {
    projects: { get: vi.fn() },
    kb: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  },
}));

// jsdom has no EventSource — stub the SSE hook
vi.mock('../hooks/useSSE', () => ({
  useSSE: () => ({ status: 'connected' }),
}));

// The real component lazy-loads the mermaid library, which jsdom can't render
vi.mock('../components/Mermaid', () => ({
  Mermaid: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

import { api } from '../api/client';

const mockedApi = vi.mocked(api, true);

function renderKb() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KnowledgeBase projectId="p1" onBack={() => {}} onShowBoard={() => {}} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.projects.get.mockResolvedValue(project);
  mockedApi.kb.list.mockResolvedValue(docSummaries);
  mockedApi.kb.get.mockResolvedValue(archDoc);
});

describe('KnowledgeBase', () => {
  it('renders the doc list from the API', async () => {
    renderKb();
    expect(await screen.findByText('Architecture')).toBeTruthy();
    expect(screen.getByText('Hosting')).toBeTruthy();
    expect(mockedApi.kb.list).toHaveBeenCalledWith('p1');
  });

  it('shows an empty state when there are no docs', async () => {
    mockedApi.kb.list.mockResolvedValue([]);
    renderKb();
    expect(await screen.findByText('No documents yet')).toBeTruthy();
  });

  it('renders the selected doc as markdown (heading + table)', async () => {
    renderKb();
    fireEvent.click(await screen.findByText('Architecture'));

    const heading = await screen.findByRole('heading', { level: 1, name: 'System overview' });
    expect(heading).toBeTruthy();
    // GFM table from the markdown source
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('api')).toBeTruthy();
    expect(mockedApi.kb.get).toHaveBeenCalledWith('d1');
  });

  it('mermaid fences escape the pre wrapper; regular fences keep it', async () => {
    mockedApi.kb.get.mockResolvedValue({
      ...archDoc,
      content: '```mermaid\nflowchart LR\nA-->B\n```\n\n```js\nconst x = 1;\n```\n',
    });
    renderKb();
    fireEvent.click(await screen.findByText('Architecture'));

    const stub = await screen.findByTestId('mermaid-stub');
    expect(stub.closest('pre')).toBeNull();
    expect(screen.getByText('const x = 1;').closest('pre')).not.toBeNull();
  });

  it('create flow fires POST with title and content', async () => {
    const created: KbDocument = {
      id: 'd3',
      project_id: 'p1',
      title: 'Runbook',
      content: 'restart things',
      created_at: '',
      updated_at: '',
    };
    mockedApi.kb.create.mockResolvedValue(created);
    mockedApi.kb.get.mockResolvedValue(created);

    renderKb();
    fireEvent.click(await screen.findByText('+ New document'));
    fireEvent.change(screen.getByPlaceholderText('Document title'), {
      target: { value: 'Runbook' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Write markdown/), {
      target: { value: 'restart things' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(mockedApi.kb.create).toHaveBeenCalledWith('p1', {
        title: 'Runbook',
        content: 'restart things',
      })
    );
  });

  it('edit flow fires PATCH with the updated fields', async () => {
    mockedApi.kb.update.mockResolvedValue({ ...archDoc, content: 'updated' });

    renderKb();
    fireEvent.click(await screen.findByText('Architecture'));
    fireEvent.click(await screen.findByText('Edit'));

    const textarea = screen.getByPlaceholderText(/Write markdown/);
    expect((textarea as HTMLTextAreaElement).value).toBe(archDoc.content);
    fireEvent.change(textarea, { target: { value: 'updated' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(mockedApi.kb.update).toHaveBeenCalledWith('d1', {
        title: 'Architecture',
        content: 'updated',
      })
    );
  });

  it('delete asks for confirmation and fires DELETE', async () => {
    mockedApi.kb.remove.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderKb();
    fireEvent.click(await screen.findByText('Architecture'));
    fireEvent.click(await screen.findByText('Delete'));

    await waitFor(() => expect(mockedApi.kb.remove).toHaveBeenCalledWith('d1'));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
