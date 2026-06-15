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
  { id: 'd1', project_id: 'p1', number: 1, key: 'DEM-KB-1', title: 'Architecture', pinned: false, created_at: '', updated_at: '' },
  { id: 'd2', project_id: 'p1', number: 2, key: 'DEM-KB-2', title: 'Hosting', pinned: false, created_at: '', updated_at: '' },
];

const archDoc: KbDocument = {
  id: 'd1',
  project_id: 'p1',
  number: 1,
  key: 'DEM-KB-1',
  title: 'Architecture',
  content: '# System overview\n\n| Service | Port |\n| ------- | ---- |\n| api | 3000 |\n',
  pinned: false,
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
      search: vi.fn(),
      searchAll: vi.fn(),
    },
  },
}));

// jsdom has no EventSource — stub the SSE hook
vi.mock('../hooks/useSSE', () => ({
  useSSE: () => ({ status: 'connected' }),
}));

// The KB chat drawer pulls settings for the provider badge
vi.mock('../api/settings', () => ({
  getSettings: vi.fn().mockResolvedValue({ activeProvider: null, providers: [] }),
}));

// Stub the chat hook so the drawer renders without a real conversation/stream
vi.mock('../hooks/useChat', () => ({
  useChat: () => ({
    conversation: { id: 'kb-conv', project_id: 'p1', item_id: null, type: 'kb', created_at: '' },
    messages: [],
    streamingText: '',
    toolCallIndicators: [],
    isStreaming: false,
    error: null,
    stallNotice: null,
    sendMessage: vi.fn(),
    dismissError: vi.fn(),
    dismissStallNotice: vi.fn(),
  }),
}));

// The real component lazy-loads the mermaid library, which jsdom can't render
vi.mock('../components/Mermaid', () => ({
  Mermaid: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

import { api } from '../api/client';

const mockedApi = vi.mocked(api, true);

// Capture the latest URL key the component pushed via onSelectDoc
let lastSelectedDocKey: string | null | undefined;

function renderKb(docKey: string | null = null) {
  lastSelectedDocKey = undefined;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <KnowledgeBase
        projectId="p1"
        docKey={docKey}
        onSelectDoc={(k) => {
          lastSelectedDocKey = k;
        }}
        onBack={() => {}}
        onShowBoard={() => {}}
      />
    </QueryClientProvider>
  );
  return { ...result, qc };
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom doesn't implement scrollIntoView, which ChatPanel calls on mount
  Element.prototype.scrollIntoView = vi.fn();
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

  it('shows each doc key in the list', async () => {
    renderKb();
    expect(await screen.findByText('DEM-KB-1')).toBeTruthy();
    expect(screen.getByText('DEM-KB-2')).toBeTruthy();
  });

  it('shows an empty state when there are no docs', async () => {
    mockedApi.kb.list.mockResolvedValue([]);
    renderKb();
    expect(await screen.findByText('No documents yet')).toBeTruthy();
  });

  it('toggles the knowledgebase chat drawer open and closed', async () => {
    renderKb();
    // Drawer is closed initially
    expect(screen.queryByText('Knowledgebase chat')).toBeNull();
    const toggle = await screen.findByText('💬 Ask the KB');
    fireEvent.click(toggle);
    // Drawer opens with its header and KB-specific input placeholder
    expect(await screen.findByText('Knowledgebase chat')).toBeTruthy();
    expect(
      screen.getByPlaceholderText('Ask about this knowledgebase, or ask to write a doc… (Enter to send)')
    ).toBeTruthy();
    // Toggle closes it again
    fireEvent.click(screen.getByText('Close chat'));
    expect(screen.queryByText('Knowledgebase chat')).toBeNull();
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

  it('renders a <br> inside a GFM table cell as a real line break', async () => {
    mockedApi.kb.get.mockResolvedValue({
      ...archDoc,
      content: '| Col |\n| --- |\n| line one<br>line two |\n',
    });
    const { container } = renderKb();
    fireEvent.click(await screen.findByText('Architecture'));

    // Wait for the table cell to render, then assert it contains a real <br> element
    await screen.findByRole('table');
    const cell = container.querySelector('td');
    expect(cell).not.toBeNull();
    expect(cell?.querySelector('br')).not.toBeNull();
    expect(cell?.textContent).toContain('line one');
    expect(cell?.textContent).toContain('line two');
  });

  it('strips a <script> tag and neutralises an onerror img payload', async () => {
    mockedApi.kb.get.mockResolvedValue({
      ...archDoc,
      content:
        '# Safe heading\n\n<script>window.__xss = 1;</script>\n\n<img src="x" onerror="window.__xss = 2;">\n',
    });
    const { container } = renderKb();
    fireEvent.click(await screen.findByText('Architecture'));
    await screen.findByRole('heading', { level: 1, name: 'Safe heading' });

    // The <script> element must not survive the sanitizer
    expect(container.querySelector('script')).toBeNull();
    // An <img> may render but its onerror handler attribute must be stripped
    const img = container.querySelector('img');
    expect(img?.getAttribute('onerror')).toBeNull();
    // Neither payload executed
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
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
      number: 3,
      key: 'DEM-KB-3',
      title: 'Runbook',
      content: 'restart things',
      pinned: false,
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

  it('typing a query searches and shows result titles + snippets', async () => {
    mockedApi.kb.search.mockResolvedValue([
      { id: 'd1', project_id: 'p1', key: 'DEM-KB-1', title: 'Architecture', updated_at: '', snippet: 'the api service runs on port 3000' },
      { id: 'd2', project_id: 'p1', key: 'DEM-KB-2', title: 'Hosting', updated_at: '', snippet: '' },
    ]);

    renderKb();
    await screen.findByText('Architecture');
    fireEvent.change(screen.getByPlaceholderText('Search docs…'), {
      target: { value: 'port' },
    });

    await waitFor(() => expect(mockedApi.kb.search).toHaveBeenCalledWith('p1', 'port'));
    expect(await screen.findByText('the api service runs on port 3000')).toBeTruthy();
    expect(screen.getByText('Hosting')).toBeTruthy();
  });

  it('clicking a search result loads that doc', async () => {
    mockedApi.kb.search.mockResolvedValue([
      { id: 'd2', project_id: 'p1', key: 'DEM-KB-2', title: 'Hosting', updated_at: '', snippet: 'deployed on a vps' },
    ]);
    const hostingDoc: KbDocument = {
      id: 'd2',
      project_id: 'p1',
      number: 2,
      key: 'DEM-KB-2',
      title: 'Hosting',
      content: '# Hosting notes',
      pinned: false,
      created_at: '',
      updated_at: '',
    };
    mockedApi.kb.get.mockResolvedValue(hostingDoc);

    renderKb();
    fireEvent.change(await screen.findByPlaceholderText('Search docs…'), {
      target: { value: 'vps' },
    });
    fireEvent.click(await screen.findByText('deployed on a vps'));

    await waitFor(() => expect(mockedApi.kb.get).toHaveBeenCalledWith('d2'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Hosting notes' })
    ).toBeTruthy();
  });

  it('clearing the search restores the full doc list', async () => {
    mockedApi.kb.search.mockResolvedValue([
      { id: 'd1', project_id: 'p1', key: 'DEM-KB-1', title: 'Architecture', updated_at: '', snippet: 'sys' },
    ]);

    renderKb();
    await screen.findByText('Hosting');
    fireEvent.change(screen.getByPlaceholderText('Search docs…'), {
      target: { value: 'arch' },
    });
    await waitFor(() => expect(screen.queryByText('Hosting')).toBeNull());

    fireEvent.click(screen.getByLabelText('Clear search'));

    expect(await screen.findByText('Hosting')).toBeTruthy();
    expect(screen.getByText('Architecture')).toBeTruthy();
  });

  it('the search "?" opens a help popover explaining the search', async () => {
    renderKb();
    await screen.findByText('Architecture');

    fireEvent.click(screen.getByLabelText('Search help'));
    expect(screen.getByText(/Searches document titles, keys/)).toBeTruthy();
  });

  it('shows "No matches" when the search returns nothing', async () => {
    mockedApi.kb.search.mockResolvedValue([]);

    renderKb();
    await screen.findByText('Architecture');
    fireEvent.change(screen.getByPlaceholderText('Search docs…'), {
      target: { value: 'zzz' },
    });

    expect(await screen.findByText('No matches')).toBeTruthy();
  });

  it('"All projects" toggle searches globally and shows project badges', async () => {
    mockedApi.kb.searchAll.mockResolvedValue([
      {
        id: 'd1',
        project_id: 'p1',
        project_name: 'demo',
        key: 'DEM-KB-1',
        title: 'Architecture',
        updated_at: '',
        snippet: 'the api service',
      },
      {
        id: 'x1',
        project_id: 'p2',
        project_name: 'otherproj',
        key: 'OTH-KB-1',
        title: 'Deploy guide',
        updated_at: '',
        snippet: 'api deploy steps',
      },
    ]);

    renderKb();
    await screen.findByText('Hosting');
    fireEvent.click(screen.getByLabelText('All projects'));
    fireEvent.change(screen.getByPlaceholderText('Search docs…'), {
      target: { value: 'api' },
    });

    await waitFor(() => expect(mockedApi.kb.searchAll).toHaveBeenCalledWith('api'));
    expect(mockedApi.kb.search).not.toHaveBeenCalled();
    expect(await screen.findByText('Deploy guide')).toBeTruthy();
    expect(screen.getByText('otherproj')).toBeTruthy();
    // 'demo' appears in the page header too — the second hit is the result badge
    expect(screen.getAllByText('demo')).toHaveLength(2);
  });

  it('clicking a cross-project result opens that doc by id', async () => {
    mockedApi.kb.searchAll.mockResolvedValue([
      {
        id: 'x1',
        project_id: 'p2',
        project_name: 'otherproj',
        key: 'OTH-KB-1',
        title: 'Deploy guide',
        updated_at: '',
        snippet: 'api deploy steps',
      },
    ]);
    const crossDoc: KbDocument = {
      id: 'x1',
      project_id: 'p2',
      number: 1,
      key: 'OTH-KB-1',
      title: 'Deploy guide',
      content: '# Deploy notes',
      pinned: false,
      created_at: '',
      updated_at: '',
    };
    mockedApi.kb.get.mockResolvedValue(crossDoc);

    renderKb();
    await screen.findByText('Hosting');
    fireEvent.click(screen.getByLabelText('All projects'));
    fireEvent.change(screen.getByPlaceholderText('Search docs…'), {
      target: { value: 'deploy' },
    });
    fireEvent.click(await screen.findByText('api deploy steps'));

    await waitFor(() => expect(mockedApi.kb.get).toHaveBeenCalledWith('x1'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Deploy notes' })
    ).toBeTruthy();
    // 'otherproj' renders on the sidebar result badge AND the viewer toolbar badge
    expect(screen.getAllByText('otherproj')).toHaveLength(2);
  });

  it('opening an article reports its key (lowercased) for the URL', async () => {
    renderKb();
    fireEvent.click(await screen.findByText('Architecture'));
    await waitFor(() => expect(mockedApi.kb.get).toHaveBeenCalledWith('d1'));
    // The component hands the key up to App, which lowercases it for the URL
    expect(lastSelectedDocKey).toBe('DEM-KB-1');
  });

  it('a docKey in the URL opens that article (case-insensitive)', async () => {
    // Lowercased key as it would arrive from the URL segment
    renderKb('dem-kb-2');
    const hostingDoc: KbDocument = {
      id: 'd2',
      project_id: 'p1',
      number: 2,
      key: 'DEM-KB-2',
      title: 'Hosting',
      content: '# Hosting notes',
      pinned: false,
      created_at: '',
      updated_at: '',
    };
    mockedApi.kb.get.mockResolvedValue(hostingDoc);

    // No click needed — deep-link resolves the key to the doc once the list loads
    await waitFor(() => expect(mockedApi.kb.get).toHaveBeenCalledWith('d2'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Hosting notes' })
    ).toBeTruthy();
  });

  it('an unknown docKey in the URL degrades to the empty viewer (no crash)', async () => {
    renderKb('dem-kb-999');
    // List still renders; viewer shows the "select a document" prompt
    expect(await screen.findByText('Architecture')).toBeTruthy();
    expect(await screen.findByText('Select a document')).toBeTruthy();
    // Never tried to fetch a doc since nothing resolved
    expect(mockedApi.kb.get).not.toHaveBeenCalled();
  });

  it('clearing the open article reports null for the URL', async () => {
    mockedApi.kb.remove.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderKb('dem-kb-1');
    await waitFor(() => expect(mockedApi.kb.get).toHaveBeenCalledWith('d1'));
    fireEvent.click(await screen.findByText('Delete'));
    await waitFor(() => expect(lastSelectedDocKey).toBeNull());
  });

  it('shows a Pinned section and pins/unpins via PATCH', async () => {
    // Hosting is pinned
    mockedApi.kb.list.mockResolvedValue([
      docSummaries[0],
      { ...docSummaries[1], pinned: true },
    ]);
    mockedApi.kb.get.mockResolvedValue({ ...archDoc, id: 'd2', key: 'DEM-KB-2', title: 'Hosting', pinned: true });
    mockedApi.kb.update.mockResolvedValue({ ...archDoc, id: 'd2', title: 'Hosting', pinned: false });

    renderKb();
    // The "Pinned" section label appears because a doc is pinned
    expect(await screen.findByText('📌 Pinned')).toBeTruthy();

    // Open the pinned doc — its toolbar offers Unpin
    fireEvent.click(await screen.findByText('Hosting'));
    const unpin = await screen.findByText('Unpin');
    fireEvent.click(unpin);
    await waitFor(() =>
      expect(mockedApi.kb.update).toHaveBeenCalledWith('d2', { pinned: false })
    );
  });

  it('keeps pinned docs visible while a search/filter is active', async () => {
    // Architecture is pinned; the search only matches Hosting
    mockedApi.kb.list.mockResolvedValue([
      { ...docSummaries[0], pinned: true },
      docSummaries[1],
    ]);
    mockedApi.kb.search.mockResolvedValue([
      { id: 'd2', project_id: 'p1', key: 'DEM-KB-2', title: 'Hosting', updated_at: '', snippet: 'on a vps' },
    ]);

    renderKb();
    await screen.findByText('Architecture');
    fireEvent.change(screen.getByPlaceholderText('Search docs…'), {
      target: { value: 'vps' },
    });

    await waitFor(() => expect(mockedApi.kb.search).toHaveBeenCalledWith('p1', 'vps'));
    // Search result is shown…
    expect(await screen.findByText('on a vps')).toBeTruthy();
    // …and the pinned doc remains visible even though it doesn't match the query
    expect(screen.getByText('📌 Pinned')).toBeTruthy();
    expect(screen.getByText('Architecture')).toBeTruthy();
  });

  it('toggling "All projects" off restores the per-project search', async () => {
    mockedApi.kb.searchAll.mockResolvedValue([]);
    mockedApi.kb.search.mockResolvedValue([
      { id: 'd1', project_id: 'p1', key: 'DEM-KB-1', title: 'Architecture', updated_at: '', snippet: 'local hit' },
    ]);

    renderKb();
    await screen.findByText('Hosting');
    fireEvent.click(screen.getByLabelText('All projects'));
    fireEvent.change(screen.getByPlaceholderText('Search docs…'), {
      target: { value: 'arch' },
    });
    await waitFor(() => expect(mockedApi.kb.searchAll).toHaveBeenCalledWith('arch'));

    fireEvent.click(screen.getByLabelText('All projects'));

    await waitFor(() => expect(mockedApi.kb.search).toHaveBeenCalledWith('p1', 'arch'));
    expect(await screen.findByText('local hit')).toBeTruthy();
  });
});
