import type {
  Project,
  Column,
  Item,
  ItemType,
  Comment,
  ActivityEntry,
  Attachment,
  KbDocument,
  KbDocSummary,
  KbSearchResult,
} from '../types';

const BASE = '/api';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error((err as { error: string }).error), { status: res.status });
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// Projects
export const api = {
  projects: {
    list: () => apiFetch<Project[]>('/projects'),
    get: (id: string) => apiFetch<Project>(`/projects/${id}`),
    create: (data: { name: string; description?: string }) =>
      apiFetch<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<{ name: string; description: string }>) =>
      apiFetch<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      apiFetch<void>(`/projects/${id}`, { method: 'DELETE' }),
  },

  columns: {
    list: () => apiFetch<Column[]>('/columns'),
    create: (data: { name: string }) =>
      apiFetch<Column>('/columns', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name: string }) =>
      apiFetch<Column>(`/columns/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    reorder: (order: string[]) =>
      apiFetch<Column[]>('/columns/reorder', { method: 'POST', body: JSON.stringify({ order }) }),
    delete: (id: string) =>
      apiFetch<void>(`/columns/${id}`, { method: 'DELETE' }),
  },

  items: {
    listByProject: (projectId: string) =>
      apiFetch<Item[]>(`/projects/${projectId}/items`),
    get: (id: string) => apiFetch<Item>(`/items/${id}`),
    create: (data: {
      project_id: string;
      parent_id?: string | null;
      type: string;
      title: string;
      description?: string;
      column_id: string;
    }) => apiFetch<Item>('/items', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<{ title: string; description: string; parent_id: string | null; type: ItemType }>) =>
      apiFetch<Item>(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    move: (id: string, data: { column_id: string; position?: number }) =>
      apiFetch<Item>(`/items/${id}/move`, { method: 'PATCH', body: JSON.stringify(data) }),
    flag: (id: string, flagged: boolean) =>
      apiFetch<Item>(`/items/${id}/flag`, { method: 'PATCH', body: JSON.stringify({ flagged }) }),
    block: (id: string, blocked: boolean, reason?: string) =>
      apiFetch<Item>(`/items/${id}/block`, {
        method: 'PATCH',
        body: JSON.stringify({ blocked, reason }),
      }),
    delete: (id: string) =>
      apiFetch<void>(`/items/${id}`, { method: 'DELETE' }),
  },

  comments: {
    listByItem: (itemId: string) =>
      apiFetch<Comment[]>(`/items/${itemId}/comments`),
    create: (data: { item_id: string; body: string; author?: string }) =>
      apiFetch<Comment>('/comments', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) =>
      apiFetch<void>(`/comments/${id}`, { method: 'DELETE' }),
  },

  attachments: {
    listByItem: (itemId: string) =>
      apiFetch<{ attachments: Attachment[] }>(`/items/${itemId}/attachments`),
    upload: (itemId: string, data: { filename?: string; mime: string; data_base64: string }) =>
      apiFetch<Attachment>(`/items/${itemId}/attachments`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      apiFetch<void>(`/attachments/${id}`, { method: 'DELETE' }),
    url: (id: string) => `${BASE}/attachments/${id}`,
  },

  kb: {
    list: (projectId: string) =>
      apiFetch<KbDocSummary[]>(`/projects/${projectId}/kb`),
    get: (id: string) => apiFetch<KbDocument>(`/kb/${id}`),
    create: (projectId: string, data: { title: string; content?: string }) =>
      apiFetch<KbDocument>(`/projects/${projectId}/kb`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<{ title: string; content: string }>) =>
      apiFetch<KbDocument>(`/kb/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: string) =>
      apiFetch<void>(`/kb/${id}`, { method: 'DELETE' }),
    search: (projectId: string, q: string) =>
      apiFetch<KbSearchResult[]>(`/projects/${projectId}/kb/search?q=${encodeURIComponent(q)}`),
  },

  activity: {
    listByProject: (projectId: string, params?: { limit?: number; before?: string }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.before) qs.set('before', params.before);
      const query = qs.toString() ? `?${qs.toString()}` : '';
      return apiFetch<{ entries: ActivityEntry[]; next_before: string | null }>(
        `/projects/${projectId}/activity${query}`
      );
    },
    listByItem: (itemId: string, params?: { limit?: number; before?: string }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.before) qs.set('before', params.before);
      const query = qs.toString() ? `?${qs.toString()}` : '';
      return apiFetch<{ entries: ActivityEntry[]; next_before: string | null }>(
        `/items/${itemId}/activity${query}`
      );
    },
  },
};
