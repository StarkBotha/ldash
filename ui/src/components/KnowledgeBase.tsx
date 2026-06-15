import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  onBack: () => void;
  onShowBoard: () => void;
}

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

export function KnowledgeBase({ projectId, onBack, onShowBoard }: Props) {
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

  const sortedDocs = [...(docs ?? [])].sort((a, b) => a.title.localeCompare(b.title));

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
  }

  const saving = createDoc.isPending || updateDoc.isPending;
  const editing = mode === 'edit' || mode === 'create';

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '12px 72px 12px 24px', // right padding clears the global settings gear
          borderBottom: '1px solid #ddd',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: '#fff',
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
        <aside className="kb-sidebar">
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
                Searches document titles and content on the server. Case-insensitive; matches your
                text anywhere it appears (plain substring — no wildcards, % and _ are matched
                literally).
              </p>
              <p>
                Results show a short snippet around the first match in the content; documents whose
                title matches are listed first. Click a result to open it; clear the box to show
                all documents.
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
          {searching ? (
            searchLoading ? (
              <div className="kb-sidebar-empty">Searching…</div>
            ) : !searchResults || searchResults.length === 0 ? (
              <div className="kb-sidebar-empty">No matches</div>
            ) : (
              <ul className="kb-doc-list">
                {searchResults.map((result) => (
                  <li key={result.id}>
                    <button
                      className={`kb-search-result${
                        result.id === selectedId && mode !== 'create' ? ' active' : ''
                      }`}
                      onClick={() => {
                        setSelectedId(result.id);
                        setMode('view');
                        setSelectedProjectName(
                          isGlobalResult(result) && result.project_id !== projectId
                            ? result.project_name
                            : null
                        );
                      }}
                    >
                      <span className="kb-search-result-title">
                        <span className="kb-doc-key">{result.key}</span>
                        {result.title}
                        {isGlobalResult(result) && (
                          <span className="kb-search-result-project">{result.project_name}</span>
                        )}
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
            <ul className="kb-doc-list">
              {sortedDocs.map((doc) => (
                <li key={doc.id}>
                  <button
                    className={doc.id === selectedId && mode !== 'create' ? 'active' : ''}
                    onClick={() => {
                      setSelectedId(doc.id);
                      setMode('view');
                      setSelectedProjectName(null);
                    }}
                  >
                    <span className="kb-doc-key">{doc.key}</span>
                    {doc.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

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
                <button onClick={startEdit}>Edit</button>
                <button onClick={remove} disabled={deleteDoc.isPending}>
                  Delete
                </button>
              </div>
              <div className="kb-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
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
