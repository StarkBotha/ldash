import type Database from 'better-sqlite3';
import type { GatewaySettings, ProviderConfig } from '../types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('db');

function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  const visible = key.slice(0, 7);
  return visible + '...' + key.slice(-4).replace(/./g, 'X');
}

export class SettingsService {
  constructor(private db: Database.Database) {}

  getGatewaySettings(): GatewaySettings {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('gateway') as { value: string } | undefined;

    if (!row) {
      return { providers: [], activeProvider: null };
    }

    try {
      return JSON.parse(row.value) as GatewaySettings;
    } catch {
      logger.error('failed to parse gateway settings, returning defaults');
      return { providers: [], activeProvider: null };
    }
  }

  setGatewaySettings(settings: GatewaySettings): GatewaySettings {
    if (!Array.isArray(settings.providers)) {
      throw new Error('providers must be an array');
    }

    // Load existing settings for API key preservation
    const existing = this.getGatewaySettings();
    const existingByName = new Map<string, ProviderConfig>(
      existing.providers.map((p) => [p.name, p])
    );

    const normalizedProviders: ProviderConfig[] = [];
    const names = new Set<string>();

    for (const provider of settings.providers) {
      if (!provider.name || typeof provider.name !== 'string' || provider.name.trim() === '') {
        throw new Error('Each provider must have a non-empty name');
      }
      if (!['claude-subscription', 'openai-compatible'].includes(provider.type)) {
        throw new Error(`Provider type must be 'claude-subscription' or 'openai-compatible'`);
      }
      if (provider.type === 'openai-compatible' && (!provider.model || typeof provider.model !== 'string')) {
        throw new Error(`Provider '${provider.name}' must have a model`);
      }
      if (names.has(provider.name)) {
        throw new Error('Provider names must be unique');
      }
      names.add(provider.name);

      if (provider.type === 'openai-compatible') {
        if (!provider.baseUrl || provider.baseUrl.trim() === '') {
          throw new Error(`Provider '${provider.name}' must have a baseUrl`);
        }

        // Determine API key: use incoming if provided, else preserve stored
        let apiKey = provider.apiKey;
        if (!apiKey || apiKey.trim() === '') {
          const stored = existingByName.get(provider.name);
          apiKey = stored?.apiKey;
        }

        if (!apiKey || apiKey.trim() === '') {
          throw new Error(`Provider '${provider.name}' must have an apiKey`);
        }

        normalizedProviders.push({
          name: provider.name,
          type: provider.type,
          model: provider.model,
          baseUrl: provider.baseUrl,
          apiKey,
        });
      } else {
        // claude-subscription: strip baseUrl and apiKey; model is optional
        const entry: ProviderConfig = {
          name: provider.name,
          type: provider.type,
        };
        if (provider.model && provider.model.trim() !== '') {
          entry.model = provider.model.trim();
        }
        normalizedProviders.push(entry);
      }
    }

    if (settings.activeProvider !== null) {
      if (typeof settings.activeProvider !== 'string') {
        throw new Error('activeProvider must be a string or null');
      }
      if (!names.has(settings.activeProvider)) {
        throw new Error('activeProvider does not match any provider name');
      }
    }

    const saved: GatewaySettings = {
      providers: normalizedProviders,
      activeProvider: settings.activeProvider,
    };

    this.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('gateway', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
      )
      .run(JSON.stringify(saved));

    return saved;
  }

  getMaskedGatewaySettings(): GatewaySettings {
    const settings = this.getGatewaySettings();
    return {
      ...settings,
      providers: settings.providers.map((p) => ({
        ...p,
        apiKey: p.apiKey ? maskApiKey(p.apiKey) : undefined,
      })),
    };
  }
}
