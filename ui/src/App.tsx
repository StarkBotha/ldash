import { useEffect, useState } from 'react';
import { ProjectList } from './components/ProjectList';
import { Board } from './components/Board';
import { SettingsPage } from './components/SettingsPage';
import { useProjects } from './hooks/useProjects';

function boardPath(name: string): string {
  return `/projects/${encodeURIComponent(name)}/board`;
}

function projectNameFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/board\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
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

  const routeName = projectNameFromPath(path);
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
    navigate(project ? boardPath(project.name) : '/');
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
        <Board
          projectId={selectedProject.id}
          onBack={() => navigate('/')}
        />
      ) : routeName && !projects ? (
        <div style={{ padding: 24 }}>Loading…</div>
      ) : (
        <ProjectList onSelectProject={openProject} />
      )}
    </>
  );
}
