import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { useProject } from '../hooks/useProjects';
import { getSettings } from '../api/settings';
import { ChatPanel } from './ChatPanel';
import {
  useKbDocs,
  useKbDoc,
  useKbSearch,
  useKbSearchAll,
  useCreateKbDoc,
  useUpdateKbDoc,
  useDeleteKbDoc,
} from '../hooks/useKb';
import { useSSE } from '../hooks/useSSE';
import { ConnectionIndicator } from './ConnectionIndicator';
import { HelpTip } from './HelpTip';
import { Mermaid } from './Mermaid';
import type { Components } from 'react-markdown';
import type { KbSearchResult, KbGlobalSearchResult } from '../types';

// Global ("all projects") search hits carry the owning project's name
function isGlobalResult(r: KbSearchResult | KbGlobalSearchResult): r is KbGlobalSearchResult {
  return 'project_name' in r;
}

interface Props {
  projectId: string;
  // KB doc key from the URL (e.g. "lda-kb-3"), or null when on the plain KB route
  docKey: string | null;
  // Push the open article's key to the URL (lowercased upstream); null clears it
  onSelectDoc: (docKey: string | null) => void;
  onBack: () => void;
  onShowBoard: () => void;
}

// Sanitize schema for rendering KB markdown that may contain raw HTML (e.g.
// <br> inside GFM table cells). Based on the default GitHub schema (which strips
// <script>, event-handler attributes, javascript: URLs, etc.) but extended so it
// keeps the language-* className on code/pre fences — the mermaid component below
// detects diagrams by that className, and the default schema would strip it.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-./]],
    pre: [...(defaultSchema.attributes?.pre ?? []), ['className', /^language-./]],
  },
};

// ```mermaid fences render as diagrams; everything else stays a code block
const markdownComponents: Components = {
  // react-markdown wraps every fence in <pre>; mermaid fences must escape it
  // so the diagram doesn't sit in the dark code-block container (a <pre> also
  // can't legally contain the rendered <div>)
  pre({ node, children, ...rest }) {
    const child = node?.children[0];
    if (
      child?.type === 'element' &&
      Array.isArray(child.properties.className) &&
      child.properties.className.includes('language-mermaid')
    ) {
      return <>{children}</>;
    }
    return <pre {...rest}>{children}</pre>;
  },
  code({ node, className, children, ...rest }) {
    void node;
    if (/language-mermaid/.test(className ?? '')) {
      return <Mermaid code={String(children).replace(/\n$/, '')} />;
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
};

export function KnowledgeBase({ projectId, docKey, onSelectDoc, onBack, onShowBoard }: Props) {
  const { data: project } = useProject(projectId);
  const { data: docs, isLoading } = useKbDocs(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 'view' shows the rendered doc; 'edit' edits the selected doc; 'create' is a blank editor
  const [mode, setMode] = useState<'view' | 'edit' | 'create'>('view');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [search, setSearch] = useState('');
  // "All projects" search mode — results come from the global endpoint instead
  const [allProjects, setAllProjects] = useState(false);
  // Project name of a cross-project doc opened from a global search result
  // (only known when it came from the search result — list/local docs are null)
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(null);
  // The whole-KB chat drawer (one chat per project, scoped to all its docs)
  const [chatOpen, setChatOpen] = useState(false);
  const { status } = useSSE(projectId);

  // Drag-resizable sidebar. Width persists across reloads; clamped so it can't
  // be dragged to nothing or eat the whole view.
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 560;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('kb-sidebar-width'));
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : 260;
  });
  useEffect(() => {
    localStorage.setItem('kb-sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    dragStart.current = { x: e.clientX, width: sidebarWidth };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      if (!dragStart.current) return;
      const next = dragStart.current.width + (ev.clientX - dragStart.current.x);
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next)));
    };
    const onUp = () => {
      dragStart.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: 30_000,
  });
  const providerLabel = (() => {
    if (!settings || !settings.activeProvider) return '';
    const active = settings.providers.find((p) => p.name === settings.activeProvider);
    if (!active) return '';
    return `${active.name} / ${active.model || 'sonnet'}`;
  })();

  const searching = search.trim() !== '';
  // Passing an empty query disables the per-project search while the toggle is on
  const { data: localResults, isLoading: localLoading } = useKbSearch(
    projectId,
    allProjects ? '' : search
  );
  const { data: globalResults, isLoading: globalLoading } = useKbSearchAll(search, allProjects);
  const searchResults = allProjects ? globalResults : localResults;
  const searchLoading = allProjects ? globalLoading : localLoading;

  const { data: selectedDoc } = useKbDoc(mode === 'create' ? null : selectedId);

  const createDoc = useCreateKbDoc(projectId);
  const updateDoc = useUpdateKbDoc(projectId);
  const deleteDoc = useDeleteKbDoc(projectId);

  // Sort by key, numeric-aware so LDA-KB-2 sorts before LDA-KB-10 (a plain
  // string sort would order it KB-1, KB-10, KB-11, …, KB-2).
  const sortedDocs = [...(docs ?? [])].sort((a, b) =>
    a.key.localeCompare(b.key, undefined, { numeric: true })
  );
  // Pinned docs surface at the top of the sidebar and stay visible even while a
  // search/filter is active — so they're rendered from the full doc list, not
  // from the (possibly filtered) search results, and excluded everywhere else
  // to avoid showing the same doc twice.
  const pinnedDocs = sortedDocs.filter((d) => d.pinned);
  const pinnedIds = new Set(pinnedDocs.map((d) => d.id));
  const unpinnedDocs = sortedDocs.filter((d) => !d.pinned);

  // Deep-linking: resolve the URL doc-key to a doc id once the list is loaded.
  // Match is case-insensitive (URL keys are lowercased). An unknown key falls
  // through to the empty viewer (the list still renders). Only runs when the URL
  // key and the loaded list change so a user click that already pushed the URL
  // doesn't get re-resolved here.
  useEffect(() => {
    if (!docs) return;
    if (!docKey) {
      // Plain KB URL: clear the viewer — unless a cross-project doc is open
      // (those open by id and intentionally carry no key in the URL)
      if (selectedProjectName === null) setSelectedId(null);
      return;
    }
    const match = docs.find((d) => d.key.toLowerCase() === docKey.toLowerCase());
    setSelectedId(match ? match.id : null);
    if (match) setSelectedProjectName(null);
    setMode('view');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, docs]);

  function startCreate() {
    setMode('create');
    setDraftTitle('');
    setDraftContent('');
  }

  function startEdit() {
    if (!selectedDoc) return;
    setMode('edit');
    setDraftTitle(selectedDoc.title);
    setDraftContent(selectedDoc.content);
  }

  async function save() {
    const title = draftTitle.trim();
    if (!title) return;
    if (mode === 'create') {
      const doc = await createDoc.mutateAsync({ title, content: draftContent });
      setSelectedId(doc.id);
      onSelectDoc(doc.key);
    } else if (mode === 'edit' && selectedId) {
      await updateDoc.mutateAsync({ id: selectedId, data: { title, content: draftContent } });
    }
    setMode('view');
  }

  async function remove() {
    if (!selectedDoc) return;
    if (!window.confirm(`Delete "${selectedDoc.title}"? This cannot be undone.`)) return;
    await deleteDoc.mutateAsync(selectedDoc.id);
    setSelectedId(null);
    setMode('view');
    onSelectDoc(null);
  }

  async function togglePin() {
    if (!selectedDoc) return;
    await updateDoc.mutateAsync({ id: selectedDoc.id, data: { pinned: !selectedDoc.pinned } });
  }

  const saving = createDoc.isPending || updateDoc.isPending;
  const editing = mode === 'edit' || mode === 'create';

  // A sidebar list entry for a current-project doc (used by both the pinned
  // section and the full doc list). Cross-project search hits are rendered
  // separately because they carry a snippet and a project badge.
  const docListItem = (doc: { id: string; key: string; title: string; pinned: boolean }) => (
    <li key={doc.id}>
      <button
        className={doc.id === selectedId && mode !== 'create' ? 'active' : ''}
        onClick={() => {
          setSelectedId(doc.id);
          setMode('view');
          setSelectedProjectName(null);
          onSelectDoc(doc.key);
        }}
      >
        <span className="kb-doc-key">
          {doc.pinned && (
            <span className="kb-doc-pin" aria-hidden="true">
              📌
            </span>
          )}
          {doc.key}
        </span>
        <span className="kb-doc-title-cell">{doc.title}</span>
      </button>
    </li>
  );

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '12px 72px 12px 24px', // right padding clears the global settings gear
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          flexWrap: 'wrap', // narrow widths wrap controls to new rows instead of overflowing off-screen
          alignItems: 'center',
          gap: 12,
          background: 'var(--surface)',
        }}
      >
        <button onClick={onBack}>← Back</button>
        <h1 style={{ margin: 0, fontSize: 20 }}>{project?.name}</h1>
        <div className="view-tabs">
          <button onClick={onShowBoard}>Board</button>
          <button className="active" disabled>
            Knowledgebase
          </button>
        </div>
        <button
          className="kb-chat-toggle"
          onClick={() => setChatOpen((v) => !v)}
          style={{ marginLeft: 'auto' }}
        >
          {chatOpen ? 'Close chat' : '💬 Ask the KB'}
        </button>
      </div>

      <div className="kb-layout">
        <aside className="kb-sidebar" style={{ width: sidebarWidth }}>
          <div className="kb-search">
            <div className="kb-search-field">
              <input
                className="kb-search-input"
                type="text"
                placeholder="Search docs…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search !== '' && (
                <button
                  className="kb-search-clear"
                  aria-label="Clear search"
                  onClick={() => setSearch('')}
                >
                  ✕
                </button>
              )}
            </div>
            <HelpTip>
              <p>
                Searches document titles, keys (e.g. LDA-KB-1), and content on the server.
                Case-insensitive; matches your text anywhere it appears (plain substring — no
                wildcards, % and _ are matched literally). Searching a number like "40" finds
                LDA-KB-40.
              </p>
              <p>
                Results show a short snippet around the first match in the content; documents whose
                title or key matches are listed first. Click a result to open it; clear the box to
                show all documents.
              </p>
              <p>
                "All projects" searches every project's knowledgebase; results show which project
                each document belongs to.
              </p>
            </HelpTip>
          </div>
          <label className="kb-search-all">
            <input
              type="checkbox"
              checked={allProjects}
              onChange={(e) => setAllProjects(e.target.checked)}
            />
            All projects
          </label>
          <button className="kb-new-doc" onClick={startCreate}>
            + New document
          </button>
          {/* Pinned docs stay at the top regardless of search/filter state */}
          {pinnedDocs.length > 0 && (
            <div className="kb-pinned-section">
              <div className="kb-section-label">📌 Pinned</div>
              <ul className="kb-doc-list">{pinnedDocs.map(docListItem)}</ul>
            </div>
          )}
          {searching ? (
            searchLoading ? (
              <div className="kb-sidebar-empty">Searching…</div>
            ) : !searchResults || searchResults.length === 0 ? (
              <div className="kb-sidebar-empty">No matches</div>
            ) : (
              <ul className="kb-doc-list">
                {/* Pinned hits are already shown above — don't list them twice */}
                {searchResults
                  .filter((result) => !pinnedIds.has(result.id))
                  .map((result) => (
                    <li key={result.id}>
                      <button
                        className={`kb-search-result${
                          result.id === selectedId && mode !== 'create' ? ' active' : ''
                        }`}
                        onClick={() => {
                          const crossProject =
                            isGlobalResult(result) && result.project_id !== projectId;
                          setSelectedId(result.id);
                          setMode('view');
                          setSelectedProjectName(crossProject ? result.project_name : null);
                          // The URL only reflects current-project article keys;
                          // a cross-project doc opens by id with a plain KB URL
                          onSelectDoc(crossProject ? null : result.key);
                        }}
                      >
                        <span className="kb-search-result-title">
                          <span className="kb-doc-key">{result.key}</span>
                          <span className="kb-doc-title-cell">
                            {result.title}
                            {isGlobalResult(result) && (
                              <span className="kb-search-result-project">{result.project_name}</span>
                            )}
                          </span>
                        </span>
                        {result.snippet !== '' && (
                          <span className="kb-search-result-snippet">{result.snippet}</span>
                        )}
                      </button>
                    </li>
                  ))}
              </ul>
            )
          ) : isLoading ? (
            <div className="kb-sidebar-empty">Loading…</div>
          ) : sortedDocs.length === 0 ? (
            <div className="kb-sidebar-empty">No documents yet</div>
          ) : (
            <ul className="kb-doc-list">{unpinnedDocs.map(docListItem)}</ul>
          )}
        </aside>

        <div
          className="kb-resizer"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />

        <main className="kb-main">
          {editing ? (
            <div className="kb-editor">
              <input
                className="kb-title-input"
                placeholder="Document title"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                autoFocus
              />
              <textarea
                className="kb-content-input"
                placeholder="Write markdown… (```mermaid fences render as diagrams)"
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
              />
              <div className="kb-editor-actions">
                <button onClick={save} disabled={saving || draftTitle.trim() === ''}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setMode('view')} disabled={saving}>
                  Cancel
                </button>
              </div>
            </div>
          ) : selectedDoc ? (
            <article className="kb-doc">
              <div className="kb-doc-toolbar">
                <span className="kb-doc-key">{selectedDoc.key}</span>
                {selectedProjectName !== null && selectedDoc.project_id !== projectId && (
                  <span className="kb-doc-project">{selectedProjectName}</span>
                )}
                {selectedDoc.project_id === projectId && (
                  <button onClick={togglePin} disabled={updateDoc.isPending}>
                    {selectedDoc.pinned ? 'Unpin' : '📌 Pin'}
                  </button>
                )}
                <button onClick={startEdit}>Edit</button>
                <button onClick={remove} disabled={deleteDoc.isPending}>
                  Delete
                </button>
              </div>
              <h1 className="kb-doc-title">{selectedDoc.title}</h1>
              <div className="kb-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
                  components={markdownComponents}
                >
                  {selectedDoc.content}
                </ReactMarkdown>
              </div>
            </article>
          ) : (
            <div className="kb-empty">
              {sortedDocs.length === 0
                ? 'No documents yet — create one to capture architecture notes, how-tos, or hosting info.'
                : 'Select a document'}
            </div>
          )}
        </main>

        {chatOpen && (
          <aside className="kb-chat-drawer">
            <div className="kb-chat-drawer-header">
              <strong>Knowledgebase chat</strong>
              <HelpTip>
                <p>
                  One chat for the whole knowledgebase of this project. Ask it to find information,
                  explain a document, or create and touch up documents — it can search, read, list,
                  and write docs in this project's KB.
                </p>
              </HelpTip>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ChatPanel
                projectId={projectId}
                itemId=""
                kb
                providerLabel={providerLabel}
                placeholder="Ask about this knowledgebase, or ask to write a doc… (Enter to send)"
              />
            </div>
          </aside>
        )}
      </div>

      <ConnectionIndicator status={status} />
    </div>
  );
}
