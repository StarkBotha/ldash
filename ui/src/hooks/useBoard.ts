import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export function useColumns() {
  return useQuery({
    queryKey: ['columns'],
    queryFn: () => api.columns.list(),
  });
}

export function useItems(projectId: string) {
  return useQuery({
    queryKey: ['items', projectId],
    queryFn: () => api.items.listByProject(projectId),
    enabled: !!projectId,
  });
}

export function useCreateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      project_id: string;
      parent_id?: string | null;
      type: string;
      title: string;
      description?: string;
      column_id: string;
    }) => api.items.create(data),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['items', item.project_id] });
    },
  });
}

export function useUpdateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      projectId,
      data,
    }: {
      id: string;
      projectId: string;
      data: Partial<{ title: string; description: string; parent_id: string | null }>;
    }) => api.items.update(id, data),
    onSuccess: (_item, vars) => {
      qc.invalidateQueries({ queryKey: ['items', vars.projectId] });
    },
  });
}

export function useMoveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      projectId: string;
      data: { column_id: string; position?: number };
    }) => api.items.move(id, data),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['items', item.project_id] });
    },
  });
}

export function useFlagItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, flagged }: { id: string; projectId: string; flagged: boolean }) =>
      api.items.flag(id, flagged),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['items', item.project_id] });
    },
  });
}

export function useBlockItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      blocked,
      reason,
    }: {
      id: string;
      projectId: string;
      blocked: boolean;
      reason?: string;
    }) => api.items.block(id, blocked, reason),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['items', item.project_id] });
    },
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId: string }) =>
      api.items.delete(id),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['items', vars.projectId] });
    },
  });
}
