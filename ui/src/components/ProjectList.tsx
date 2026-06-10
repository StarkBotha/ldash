import { useState } from 'react';
import { useProjects, useDeleteProject } from '../hooks/useProjects';
import { ProjectForm } from './ProjectForm';
import type { Project } from '../types';

interface Props {
  onSelectProject: (id: string) => void;
}

export function ProjectList({ onSelectProject }: Props) {
  const { data: projects, isLoading, error } = useProjects();
  const deleteProject = useDeleteProject();
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  function handleDelete(e: React.MouseEvent, project: Project) {
    e.stopPropagation();
    if (window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
      deleteProject.mutate(project.id);
    }
  }

  if (isLoading) return <div style={{ padding: 24 }}>Loading projects…</div>;
  if (error) return <div style={{ padding: 24, color: 'red' }}>Error loading projects</div>;

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>ldash</h1>
        <button onClick={() => setShowForm(true)}>New project</button>
      </div>

      {projects?.length === 0 && (
        <p style={{ color: '#888' }}>No projects yet. Create one to get started.</p>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {projects?.map((project) => (
          <div
            key={project.id}
            onClick={() => onSelectProject(project.id)}
            style={{
              border: '1px solid #ddd',
              borderRadius: 8,
              padding: 16,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              background: '#fafafa',
            }}
          >
            <div>
              <strong>{project.name}</strong>
              {project.description && (
                <p style={{ margin: '4px 0 0', color: '#666', fontSize: 15 }}>{project.description}</p>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingProject(project);
                  setShowForm(true);
                }}
              >
                Edit
              </button>
              <button
                onClick={(e) => handleDelete(e, project)}
                style={{ color: 'red' }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <ProjectForm
          project={editingProject ?? undefined}
          onClose={() => {
            setShowForm(false);
            setEditingProject(null);
          }}
        />
      )}
    </div>
  );
}
