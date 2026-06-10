import type { ChatMessage } from '../types';

export async function fetchPlanningHistory(projectId: string): Promise<{
  conversationId: string;
  messages: ChatMessage[];
}> {
  const res = await fetch(`/api/projects/${projectId}/planning/messages`);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json() as Promise<{ conversationId: string; messages: ChatMessage[] }>;
}

export async function sendPlanningMessage(
  projectId: string,
  content: string,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`/api/projects/${projectId}/planning/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal,
  });
}

export async function clearPlanningHistory(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/planning/messages`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) throw new Error('HTTP ' + res.status);
}
