import { useEffect, useState } from 'react';
import { ProjectList } from './components/ProjectList';
import { Board } from './components/Board';
import { KnowledgeBase } from './components/KnowledgeBase';
import { SettingsPage } from './components/SettingsPage';
import { useProjects } from './hooks/useProjects';

type ProjectView = 'board' | 'kb';

function projectPath(name: string, view: ProjectView): string {
  return `/projects/${encodeURIComponent(name)}/${view}`;
}

// A KB doc key (lowercased) may trail the kb route, e.g. /projects/ldash/kb/lda-kb-3
function kbDocPath(name: string, docKey: string): string {
  return `/projects/${encodeURIComponent(name)}/kb/${encodeURIComponent(docKey.toLowerCase())}`;
}

function projectRouteFromPath(
  pathname: string
): { name: string; view: ProjectView; docKey: string | null } | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/(board|kb)(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const view = match[2] as ProjectView;
  // Only the KB view carries a trailing doc-key segment
  const docKey = view === 'kb' && match[3] ? decodeURIComponent(match[3]) : null;
  return { name: decodeURIComponent(match[1]), view, docKey };
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [showSettings, setShowSettings] = useState(false);
  const { data: projects } = useProjects();

  // Keep path state in sync with browser back/forward
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const route = projectRouteFromPath(path);
  const routeName = route?.name ?? null;
  const selectedProject =
    routeName && projects ? projects.find((p) => p.name === routeName) : undefined;

  // URL names a project that doesn't exist (deleted/renamed/typo) — go home
  useEffect(() => {
    if (routeName && projects && !selectedProject) {
      window.history.replaceState(null, '', '/');
      setPath('/');
    }
  }, [routeName, projects, selectedProject]);

  useEffect(() => {
    document.title = selectedProject ? `${selectedProject.name} · ldash` : 'ldash';
  }, [selectedProject]);

  const navigate = (to: string) => {
    window.history.pushState(null, '', to);
    setPath(to);
  };

  const openProject = (id: string) => {
    const project = projects?.find((p) => p.id === id);
    navigate(project ? projectPath(project.name, 'board') : '/');
  };

  return (
    <>
      {/* Gear icon always visible in top-right */}
      <button
        onClick={() => setShowSettings(true)}
        title="Settings"
        style={{
          position: 'fixed',
          top: 12,
          right: 16,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 20,
          zIndex: 900,
          color: '#6b7280',
        }}
      >
        ⚙
      </button>

      {showSettings && (
        <SettingsPage onClose={() => setShowSettings(false)} />
      )}

      {selectedProject ? (
        route?.view === 'kb' ? (
          <KnowledgeBase
            projectId={selectedProject.id}
            docKey={route.docKey}
            onSelectDoc={(docKey) =>
              navigate(
                docKey
                  ? kbDocPath(selectedProject.name, docKey)
                  : projectPath(selectedProject.name, 'kb')
              )
            }
            onBack={() => navigate('/')}
            onShowBoard={() => navigate(projectPath(selectedProject.name, 'board'))}
          />
        ) : (
          <Board
            projectId={selectedProject.id}
            onBack={() => navigate('/')}
            onShowKb={() => navigate(projectPath(selectedProject.name, 'kb'))}
          />
        )
      ) : routeName && !projects ? (
        <div style={{ padding: 24 }}>Loading…</div>
      ) : (
        <ProjectList onSelectProject={openProject} />
      )}
    </>
  );
}
