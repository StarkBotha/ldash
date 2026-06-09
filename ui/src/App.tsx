import { useState } from 'react';
import { ProjectList } from './components/ProjectList';
import { Board } from './components/Board';
import { SettingsPage } from './components/SettingsPage';

export function App() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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

      {selectedProjectId ? (
        <Board
          projectId={selectedProjectId}
          onBack={() => setSelectedProjectId(null)}
        />
      ) : (
        <ProjectList onSelectProject={setSelectedProjectId} />
      )}
    </>
  );
}
