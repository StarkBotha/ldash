import { useState, useEffect } from 'react';
import { getSettings, updateSettings } from '../api/settings';
import type { GatewaySettings, ProviderConfig, ProviderType } from '../types';

interface SettingsPageProps {
  onClose: () => void;
}

const emptyProvider = (): ProviderConfig & { editing: boolean; apiKeyInput: string } => ({
  name: '',
  type: 'openai-compatible' as ProviderType,
  model: '',
  baseUrl: '',
  apiKey: undefined,
  editing: true,
  apiKeyInput: '',
});

type ExtendedProvider = ProviderConfig & { editing: boolean; apiKeyInput: string };

export function SettingsPage({ onClose }: SettingsPageProps) {
  const [providers, setProviders] = useState<ExtendedProvider[]>([]);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((s: GatewaySettings) => {
      setProviders(
        s.providers.map((p) => ({ ...p, editing: false, apiKeyInput: '' }))
      );
      setActiveProvider(s.activeProvider);
    }).catch(() => {
      // Start with empty state on error
    });
  }, []);

  function updateProvider(index: number, updates: Partial<ExtendedProvider>) {
    setProviders((prev) => prev.map((p, i) => (i === index ? { ...p, ...updates } : p)));
  }

  function addProvider() {
    setProviders((prev) => [...prev, emptyProvider()]);
  }

  function removeProvider(index: number) {
    const removed = providers[index];
    setProviders((prev) => prev.filter((_, i) => i !== index));
    if (activeProvider === removed.name) {
      setActiveProvider(null);
    }
  }

  async function handleSave() {
    setSaveStatus('saving');
    setSaveError(null);

    const toSave: GatewaySettings = {
      providers: providers.map((p) => {
        const base: ProviderConfig = {
          name: p.name,
          type: p.type,
          model: p.model,
        };
        if (p.type === 'openai-compatible') {
          base.baseUrl = p.baseUrl;
          // Only send apiKey if user typed something new
          if (p.apiKeyInput && p.apiKeyInput.trim() !== '') {
            base.apiKey = p.apiKeyInput;
          }
          // If no new key, omit apiKey so server preserves stored key
        }
        return base;
      }),
      activeProvider,
    };

    try {
      const saved = await updateSettings(toSave);
      setProviders(saved.providers.map((p) => ({ ...p, editing: false, apiKeyInput: '' })));
      setActiveProvider(saved.activeProvider);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaveStatus('error');
    }
  }

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 8,
    padding: 24,
    width: 560,
    maxWidth: '90vw',
    maxHeight: '80vh',
    overflowY: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>LLM Settings</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Providers</h3>

        {providers.map((provider, index) => (
          <div
            key={index}
            style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 12, marginBottom: 12 }}
          >
            {!provider.editing ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{provider.name}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    {provider.type} · {provider.model || 'default (sonnet)'}
                    {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
                    {provider.apiKey ? ` · key: ${provider.apiKey}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => updateProvider(index, { editing: true })} style={{ fontSize: 12 }}>Edit</button>
                  <button onClick={() => removeProvider(index)} style={{ fontSize: 12, color: 'red' }}>Delete</button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 3 }}>Name *</label>
                  <input
                    type="text"
                    value={provider.name}
                    onChange={(e) => updateProvider(index, { name: e.target.value })}
                    style={{ width: '100%', padding: '4px 8px', fontSize: 13, boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 3 }}>Type</label>
                  <select
                    value={provider.type}
                    onChange={(e) => {
                      const newType = e.target.value as ProviderType;
                      const updates: Partial<ExtendedProvider> = { type: newType };
                      if (newType === 'claude-subscription') {
                        updates.model = '';
                      }
                      updateProvider(index, updates);
                    }}
                    style={{ width: '100%', padding: '4px 8px', fontSize: 13 }}
                  >
                    <option value="claude-subscription">claude-subscription</option>
                    <option value="openai-compatible">openai-compatible</option>
                  </select>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 3 }}>Model</label>
                  {provider.type === 'claude-subscription' ? (
                    <select
                      value={provider.model ?? ''}
                      onChange={(e) => updateProvider(index, { model: e.target.value })}
                      style={{ width: '100%', padding: '4px 8px', fontSize: 13 }}
                    >
                      <option value="">Default (Sonnet)</option>
                      <option value="claude-sonnet-4-6">Sonnet — balanced (recommended)</option>
                      <option value="claude-opus-4-8">Opus — most capable</option>
                      <option value="claude-haiku-4-5">Haiku — fastest</option>
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={provider.model ?? ''}
                      onChange={(e) => updateProvider(index, { model: e.target.value })}
                      placeholder="e.g. gpt-4o, llama3"
                      style={{ width: '100%', padding: '4px 8px', fontSize: 13, boxSizing: 'border-box' }}
                    />
                  )}
                </div>
                {provider.type === 'openai-compatible' && (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      <label style={{ display: 'block', fontSize: 12, marginBottom: 3 }}>Base URL</label>
                      <input
                        type="text"
                        value={provider.baseUrl ?? ''}
                        onChange={(e) => updateProvider(index, { baseUrl: e.target.value })}
                        placeholder="http://localhost:11434/v1"
                        style={{ width: '100%', padding: '4px 8px', fontSize: 13, boxSizing: 'border-box' }}
                      />
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <label style={{ display: 'block', fontSize: 12, marginBottom: 3 }}>API Key</label>
                      <input
                        type="password"
                        value={provider.apiKeyInput}
                        onChange={(e) => updateProvider(index, { apiKeyInput: e.target.value })}
                        placeholder={provider.apiKey ? 'Enter new key (leave blank to keep current)' : 'Enter API key'}
                        style={{ width: '100%', padding: '4px 8px', fontSize: 13, boxSizing: 'border-box' }}
                      />
                    </div>
                  </>
                )}
                <button
                  onClick={() => updateProvider(index, { editing: false })}
                  style={{ fontSize: 12, marginTop: 4 }}
                >
                  Done
                </button>
              </div>
            )}
          </div>
        ))}

        <button onClick={addProvider} style={{ fontSize: 13, marginBottom: 20 }}>
          + Add provider
        </button>

        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Active provider</h3>
        <select
          value={activeProvider ?? ''}
          onChange={(e) => setActiveProvider(e.target.value || null)}
          style={{ width: '100%', padding: '4px 8px', fontSize: 13, marginBottom: 20 }}
        >
          <option value="">(none)</option>
          {providers.map((p, i) => (
            <option key={i} value={p.name}>{p.name}</option>
          ))}
        </select>

        {saveError && (
          <div style={{ color: '#991b1b', fontSize: 13, marginBottom: 12, background: '#fef2f2', padding: '8px 10px', borderRadius: 4 }}>
            {saveError}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
          {saveStatus === 'saved' && (
            <span style={{ color: '#059669', fontSize: 13, fontWeight: 600 }}>Saved</span>
          )}
          <button
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            style={{
              padding: '6px 20px',
              background: saveStatus === 'saving' ? '#9ca3af' : '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: saveStatus === 'saving' ? 'not-allowed' : 'pointer',
              fontSize: 14,
            }}
          >
            {saveStatus === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
