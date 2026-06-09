import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export function useComments(itemId: string) {
  return useQuery({
    queryKey: ['comments', itemId],
    queryFn: () => api.comments.listByItem(itemId),
    enabled: !!itemId,
  });
}

export function useCreateComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { item_id: string; body: string; author?: string }) =>
      api.comments.create(data),
    onSuccess: (_comment, vars) => {
      qc.invalidateQueries({ queryKey: ['comments', vars.item_id] });
    },
  });
}

export function useDeleteComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      api.comments.delete(id),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['comments', vars.itemId] });
    },
  });
}

export function useItemActivity(itemId: string) {
  return useQuery({
    queryKey: ['activity', 'item', itemId],
    queryFn: () => api.activity.listByItem(itemId, { limit: 50 }),
    enabled: !!itemId,
  });
}
