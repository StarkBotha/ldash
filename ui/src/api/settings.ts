import type { GatewaySettings } from '../types';

export interface ModelEntry {
  id: string;
  label?: string;
}

export interface ModelsResponse {
  models: ModelEntry[];
  source: 'provider' | 'fallback';
  error?: string;
}

export interface FetchModelsRequest {
  type: 'claude-subscription' | 'openai-compatible';
  baseUrl?: string;
  apiKey?: string;
  providerName?: string;
}

export async function fetchModels(req: FetchModelsRequest): Promise<ModelsResponse> {
  const res = await fetch('/api/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json() as Promise<ModelsResponse>;
}

export async function getSettings(): Promise<GatewaySettings> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json() as Promise<GatewaySettings>;
}

export async function updateSettings(settings: GatewaySettings): Promise<GatewaySettings> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    let errorMsg = 'Failed to save settings';
    try {
      const json = (await res.json()) as { error?: string };
      errorMsg = json.error ?? errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }
  return res.json() as Promise<GatewaySettings>;
}
