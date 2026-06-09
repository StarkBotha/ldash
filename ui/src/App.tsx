import { useState } from 'react';
import { ProjectList } from './components/ProjectList';
import { Board } from './components/Board';

export function App() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  if (selectedProjectId) {
    return (
      <Board
        projectId={selectedProjectId}
        onBack={() => setSelectedProjectId(null)}
      />
    );
  }

  return <ProjectList onSelectProject={setSelectedProjectId} />;
}
