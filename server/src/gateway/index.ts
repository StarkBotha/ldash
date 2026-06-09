import { ClaudeAdapter } from './adapters/claude.js';
import { OpenAIAdapter } from './adapters/openai.js';
import type { ChatAdapter } from './types.js';
import type { SettingsService } from '../services/settings.js';

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
    return new ClaudeAdapter({ authMode: 'subscription', model: provider.model });
  }

  if (provider.type === 'openai-compatible') {
    return new OpenAIAdapter({
      baseUrl: provider.baseUrl!,
      apiKey: provider.apiKey!,
      model: provider.model,
    });
  }

  throw new Error('Unknown provider type: ' + provider.type);
}
