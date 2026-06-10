import { createLogger } from '../logger.js';
import type { SettingsService } from './settings.js';

const logger = createLogger('models');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelEntry {
  id: string;
  label?: string;
}

export interface ModelsResponse {
  models: ModelEntry[];
  source: 'provider' | 'fallback';
  error?: string;
}

// ---------------------------------------------------------------------------
// Fallback list for claude-subscription when no credential is available
// ---------------------------------------------------------------------------

const CLAUDE_FALLBACK_MODELS: ModelEntry[] = [
  { id: 'claude-fable-5', label: 'Fable — most powerful (claude-fable-5)' },
  { id: 'claude-opus-4-8', label: 'Opus (claude-opus-4-8)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (claude-sonnet-4-6)' },
  { id: 'claude-haiku-4-5', label: 'Haiku (claude-haiku-4-5)' },
];

// ---------------------------------------------------------------------------
// Label mapping for Claude model ids
// ---------------------------------------------------------------------------

function claudeLabel(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes('fable')) return `Fable — most powerful (${id})`;
  if (lower.includes('opus')) return `Opus (${id})`;
  if (lower.includes('sonnet')) return `Sonnet (${id})`;
  if (lower.includes('haiku')) return `Haiku (${id})`;
  return id;
}

// ---------------------------------------------------------------------------
// In-memory cache keyed by "type|baseUrl"
// ---------------------------------------------------------------------------

interface CacheEntry {
  response: ModelsResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cacheKey(type: string, baseUrl?: string): string {
  return `${type}|${baseUrl ?? ''}`;
}

function getCached(key: string): ModelsResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.response;
}

function setCached(key: string, response: ModelsResponse): void {
  cache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Exported for tests
export function clearModelsCache(): void {
  cache.clear();
}

// True when both URLs parse and share scheme + host + port.
function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

async function fetchOpenAIModels(
  baseUrl: string,
  apiKey: string | undefined
): Promise<ModelsResponse> {
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey && apiKey.trim() !== '') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  logger.debug('fetching openai-compatible models', { url });

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('openai-compatible models fetch failed', { url, error: msg });
    return { models: [], source: 'fallback', error: msg };
  }

  if (!res.ok) {
    const msg = `HTTP ${res.status}`;
    logger.warn('openai-compatible models returned error', { url, status: res.status });
    return { models: [], source: 'fallback', error: msg };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('openai-compatible models bad json', { url, error: msg });
    return { models: [], source: 'fallback', error: msg };
  }

  // Parse OpenAI shape: { data: [{ id: string, ... }] }
  const parsed = json as { data?: { id: string }[] };
  if (!parsed || !Array.isArray(parsed.data)) {
    logger.warn('openai-compatible models unexpected shape', { url });
    return { models: [], source: 'fallback', error: 'Unexpected response shape' };
  }

  const ids = parsed.data
    .map((m) => m.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  ids.sort();

  const models: ModelEntry[] = ids.map((id) => ({ id }));
  logger.info('openai-compatible models loaded', { url, count: models.length });
  return { models, source: 'provider' };
}

// ---------------------------------------------------------------------------
// Claude subscription provider
// ---------------------------------------------------------------------------

async function fetchClaudeModels(): Promise<ModelsResponse> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!oauthToken && !apiKey) {
    logger.debug('no claude credentials in env, returning fallback models');
    return { models: CLAUDE_FALLBACK_MODELS, source: 'fallback' };
  }

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };

  if (oauthToken) {
    headers['Authorization'] = `Bearer ${oauthToken}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const url = 'https://api.anthropic.com/v1/models';
  logger.debug('fetching claude models from api', { auth: oauthToken ? 'oauth' : 'api-key' });

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('claude models fetch failed', { error: msg });
    return { models: CLAUDE_FALLBACK_MODELS, source: 'fallback' };
  }

  if (!res.ok) {
    logger.warn('claude models api returned error', { status: res.status });
    return { models: CLAUDE_FALLBACK_MODELS, source: 'fallback' };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('claude models bad json', { error: msg });
    return { models: CLAUDE_FALLBACK_MODELS, source: 'fallback' };
  }

  // Anthropic /v1/models shape: { data: [{ id, display_name?, created_at?, ... }] }
  const parsed = json as { data?: { id: string; display_name?: string; created_at?: number }[] };
  if (!parsed || !Array.isArray(parsed.data)) {
    logger.warn('claude models unexpected shape');
    return { models: CLAUDE_FALLBACK_MODELS, source: 'fallback' };
  }

  // Sort newest first if created_at is available; otherwise keep API order
  const items = [...parsed.data];
  if (items.length > 0 && items[0].created_at !== undefined) {
    items.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  }

  const models: ModelEntry[] = items
    .filter((m) => typeof m.id === 'string' && m.id.length > 0)
    .map((m) => ({ id: m.id, label: claudeLabel(m.id) }));

  logger.info('claude models loaded from api', { count: models.length });
  return { models, source: 'provider' };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function fetchModels(
  body: Record<string, unknown>,
  settings: SettingsService
): Promise<ModelsResponse> {
  const type = body.type as string;

  if (type === 'openai-compatible') {
    const baseUrl = (body.baseUrl as string | undefined) ?? '';
    if (!baseUrl || baseUrl.trim() === '') {
      return { models: [], source: 'fallback', error: 'baseUrl is required' };
    }

    // Resolve API key: use provided key, or fall back to stored key for the providerName.
    // The stored key is only used when the request's baseUrl has the same origin as the
    // stored provider's baseUrl — otherwise a request could name a saved provider but
    // point baseUrl at an attacker server and exfiltrate the stored credential.
    let apiKey = (body.apiKey as string | undefined) ?? '';
    if ((!apiKey || apiKey.trim() === '') && typeof body.providerName === 'string' && body.providerName.trim() !== '') {
      const stored = settings.getGatewaySettings();
      const match = stored.providers.find((p) => p.name === body.providerName && p.type === 'openai-compatible');
      if (match?.apiKey && match.apiKey.trim() !== '' && sameOrigin(match.baseUrl, baseUrl)) {
        apiKey = match.apiKey;
        logger.debug('using stored apiKey for models fetch', { provider: body.providerName });
      }
    }

    const key = cacheKey(type, baseUrl);
    const cached = getCached(key);
    if (cached) {
      logger.debug('returning cached openai-compatible models', { baseUrl });
      return cached;
    }

    const result = await fetchOpenAIModels(baseUrl, apiKey || undefined);
    if (result.source === 'provider') {
      setCached(key, result);
    }
    return result;
  }

  // claude-subscription
  const key = cacheKey('claude-subscription');
  const cached = getCached(key);
  if (cached) {
    logger.debug('returning cached claude models');
    return cached;
  }

  const result = await fetchClaudeModels();
  if (result.source === 'provider') {
    setCached(key, result);
  }
  return result;
}
