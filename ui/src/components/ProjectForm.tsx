import { useState } from 'react';
import { useCreateProject, useUpdateProject } from '../hooks/useProjects';
import type { Project } from '../types';

interface Props {
  project?: Project;
  onClose: () => void;
}

export function ProjectForm({ project, onClose }: Props) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [error, setError] = useState('');

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    try {
      if (project) {
        await updateProject.mutateAsync({ id: project.id, data: { name, description } });
      } else {
        await createProject.mutateAsync({ name, description });
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  };

  const modalStyle: React.CSSProperties = {
    background: '#fff', borderRadius: 8, padding: 24, width: 420, maxWidth: '90vw',
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 16px' }}>{project ? 'Edit project' : 'New project'}</h2>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', marginBottom: 4 }}>Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
              autoFocus
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4 }}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
            />
          </div>
          {error && <p style={{ color: 'red', marginBottom: 12 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit">{project ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
