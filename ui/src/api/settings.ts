import type { GatewaySettings } from '../types';

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
