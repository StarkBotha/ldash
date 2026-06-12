import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useProject } from '../hooks/useProjects';
import { useKbDocs, useKbDoc, useCreateKbDoc, useUpdateKbDoc, useDeleteKbDoc } from '../hooks/useKb';
import { useSSE } from '../hooks/useSSE';
import { ConnectionIndicator } from './ConnectionIndicator';
import { Mermaid } from './Mermaid';
import type { Components } from 'react-markdown';

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
  const { status } = useSSE(projectId);

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
      </div>

      <div className="kb-layout">
        <aside className="kb-sidebar">
          <button className="kb-new-doc" onClick={startCreate}>
            + New document
          </button>
          {isLoading ? (
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
                    }}
                  >
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
      </div>

      <ConnectionIndicator status={status} />
    </div>
  );
}
