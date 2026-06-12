import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export function useKbDocs(projectId: string) {
  return useQuery({
    queryKey: ['kb', projectId],
    queryFn: () => api.kb.list(projectId),
    enabled: !!projectId,
  });
}

export function useKbDoc(id: string | null) {
  return useQuery({
    queryKey: ['kb-doc', id],
    queryFn: () => api.kb.get(id as string),
    enabled: !!id,
  });
}

export function useKbSearch(projectId: string, q: string) {
  return useQuery({
    queryKey: ['kb-search', projectId, q],
    queryFn: () => api.kb.search(projectId, q),
    enabled: !!projectId && q.trim() !== '',
  });
}

export function useCreateKbDoc(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { title: string; content?: string }) => api.kb.create(projectId, data),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ['kb', projectId] });
      qc.setQueryData(['kb-doc', doc.id], doc);
    },
  });
}

export function useUpdateKbDoc(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<{ title: string; content: string }> }) =>
      api.kb.update(id, data),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ['kb', projectId] });
      qc.invalidateQueries({ queryKey: ['kb-doc', doc.id] });
    },
  });
}

export function useDeleteKbDoc(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.kb.remove(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['kb', projectId] });
      qc.removeQueries({ queryKey: ['kb-doc', id] });
    },
  });
}
