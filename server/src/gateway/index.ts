import { ClaudeAdapter } from './adapters/claude.js';
import { OpenAIAdapter } from './adapters/openai.js';
import type { ChatAdapter } from './types.js';
import type { SettingsService } from '../services/settings.js';

const CLAUDE_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
};

/**
 * Normalize a model string for a claude-subscription provider.
 * Maps friendly aliases (case-insensitive) to full model ids.
 * Anything that is not a known alias passes through unchanged.
 * An empty/undefined value returns undefined so the adapter uses its built-in default.
 */
export function normalizeClaudeModel(model: string | undefined): string | undefined {
  if (!model || model.trim() === '') return undefined;
  const lower = model.trim().toLowerCase();
  return CLAUDE_ALIASES[lower] ?? model.trim();
}

export function getAdapter(settings: SettingsService): ChatAdapter {
  const gatewaySettings = settings.getGatewaySettings();

  if (!gatewaySettings.activeProvider || gatewaySettings.providers.length === 0) {
    throw new Error('No LLM provider configured. Go to Settings to add a provider.');
  }

  const provider = gatewaySettings.providers.find(
    (p) => p.name === gatewaySettings.activeProvider
  );

  if (!provider) {
    throw new Error('Active provider not found in settings. Check your provider configuration.');
  }

  if (provider.type === 'claude-subscription') {
    return new ClaudeAdapter({ authMode: 'subscription', model: normalizeClaudeModel(provider.model) });
  }

  if (provider.type === 'openai-compatible') {
    return new OpenAIAdapter({
      baseUrl: provider.baseUrl!,
      apiKey: provider.apiKey!,
      model: provider.model!,
    });
  }

  throw new Error('Unknown provider type: ' + provider.type);
}
