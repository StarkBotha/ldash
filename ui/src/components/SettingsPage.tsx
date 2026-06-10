import { useState, useEffect, useRef } from 'react';
import { getSettings, updateSettings, fetchModels } from '../api/settings';
import type { ModelEntry } from '../api/settings';
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

// Per-provider model fetch state
interface ModelFetchState {
  models: ModelEntry[];
  source: 'provider' | 'fallback' | null;
  error?: string;
  loading: boolean;
}

function emptyModelFetch(): ModelFetchState {
  return { models: [], source: null, loading: false };
}

export function SettingsPage({ onClose }: SettingsPageProps) {
  const [providers, setProviders] = useState<ExtendedProvider[]>([]);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Model fetch state per provider index
  const [modelFetch, setModelFetch] = useState<ModelFetchState[]>([]);
  // Debounce timers per provider index
  const debounceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    getSettings().then((s: GatewaySettings) => {
      const loaded = s.providers.map((p) => ({ ...p, editing: false, apiKeyInput: '' }));
      setProviders(loaded);
      setActiveProvider(s.activeProvider);
      setModelFetch(loaded.map(() => emptyModelFetch()));
    }).catch(() => {
      // Start with empty state on error
    });
  }, []);

  function updateProvider(index: number, updates: Partial<ExtendedProvider>) {
    setProviders((prev) => prev.map((p, i) => (i === index ? { ...p, ...updates } : p)));
  }

  // Trigger a model fetch for a provider at the given index (debounced for baseUrl changes)
  function scheduleFetch(index: number, provider: ExtendedProvider, immediate = false) {
    if (debounceTimers.current[index]) {
      clearTimeout(debounceTimers.current[index]);
    }

    const doFetch = async () => {
      setModelFetch((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], loading: true };
        return next;
      });

      try {
        let result;
        if (provider.type === 'claude-subscription') {
          result = await fetchModels({ type: 'claude-subscription' });
        } else {
          if (!provider.baseUrl || provider.baseUrl.trim() === '') {
            setModelFetch((prev) => {
              const next = [...prev];
              next[index] = emptyModelFetch();
              return next;
            });
            return;
          }
          result = await fetchModels({
            type: 'openai-compatible',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKeyInput || undefined,
            providerName: provider.name || undefined,
          });
        }
        setModelFetch((prev) => {
          const next = [...prev];
          next[index] = { models: result.models, source: result.source, error: result.error, loading: false };
          return next;
        });
      } catch {
        setModelFetch((prev) => {
          const next = [...prev];
          next[index] = { models: [], source: 'fallback', error: 'Failed to fetch models', loading: false };
          return next;
        });
      }
    };

    if (immediate) {
      void doFetch();
    } else {
      debounceTimers.current[index] = setTimeout(() => void doFetch(), 600);
    }
  }

  function addProvider() {
    const newProvider = emptyProvider();
    setProviders((prev) => [...prev, newProvider]);
    setModelFetch((prev) => [...prev, emptyModelFetch()]);
    // Fetch claude fallback models immediately for new claude-subscription providers
    if (newProvider.type === 'claude-subscription') {
      const newIndex = providers.length;
      scheduleFetch(newIndex, newProvider, true);
    }
  }

  function removeProvider(index: number) {
    const removed = providers[index];
    setProviders((prev) => prev.filter((_, i) => i !== index));
    setModelFetch((prev) => prev.filter((_, i) => i !== index));
    if (activeProvider === removed.name) {
      setActiveProvider(null);
    }
  }

  // When a provider is opened for editing, fetch its models
  function openEdit(index: number) {
    const provider = providers[index];
    updateProvider(index, { editing: true });
    scheduleFetch(index, provider, true);
  }

  // When type or baseUrl changes in the edit form, re-fetch
  function handleTypeChange(index: number, newType: ProviderType) {
    const updates: Partial<ExtendedProvider> = { type: newType };
    if (newType === 'claude-subscription') {
      updates.model = '';
    }
    updateProvider(index, updates);
    const updated = { ...providers[index], ...updates };
    scheduleFetch(index, updated, newType === 'claude-subscription');
  }

  function handleBaseUrlChange(index: number, newBaseUrl: string) {
    updateProvider(index, { baseUrl: newBaseUrl });
    const updated = { ...providers[index], baseUrl: newBaseUrl };
    scheduleFetch(index, updated, false);
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

        {providers.map((provider, index) => {
          const mf = modelFetch[index] ?? emptyModelFetch();
          const datalistId = `model-list-${index}`;

          // Build the hint line text
          let modelHint: string | null = null;
          if (provider.editing) {
            if (mf.loading) {
              modelHint = 'Loading models…';
            } else if (mf.source === 'provider') {
              modelHint = `${mf.models.length} model${mf.models.length !== 1 ? 's' : ''} loaded from provider`;
            } else if (mf.source === 'fallback') {
              if (provider.type === 'openai-compatible' && mf.error) {
                modelHint = "Couldn't fetch models — type the model id";
              } else {
                modelHint = 'Showing defaults';
              }
            }
          }

          return (
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
                    <button onClick={() => openEdit(index)} style={{ fontSize: 12 }}>Edit</button>
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
                      onChange={(e) => handleTypeChange(index, e.target.value as ProviderType)}
                      style={{ width: '100%', padding: '4px 8px', fontSize: 13 }}
                    >
                      <option value="claude-subscription">claude-subscription</option>
                      <option value="openai-compatible">openai-compatible</option>
                    </select>
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'block', fontSize: 12, marginBottom: 3 }}>
                      Model
                      {provider.type === 'claude-subscription' && (
                        <span style={{ color: '#9ca3af', fontWeight: 'normal' }}> (empty = Default / Sonnet)</span>
                      )}
                    </label>
                    {/* datalist for autocomplete — free text always allowed */}
                    <datalist id={datalistId}>
                      {provider.type === 'claude-subscription' && (
                        <option value="">Default (Sonnet)</option>
                      )}
                      {mf.models.map((m) => (
                        <option key={m.id} value={m.id} label={m.label} />
                      ))}
                    </datalist>
                    <input
                      type="text"
                      list={datalistId}
                      value={provider.model ?? ''}
                      onChange={(e) => updateProvider(index, { model: e.target.value })}
                      placeholder={provider.type === 'claude-subscription' ? 'Default (Sonnet)' : 'e.g. gpt-4o, llama3'}
                      style={{ width: '100%', padding: '4px 8px', fontSize: 13, boxSizing: 'border-box' }}
                    />
                    {modelHint && (
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>{modelHint}</div>
                    )}
                  </div>
                  {provider.type === 'openai-compatible' && (
                    <>
                      <div style={{ marginBottom: 8 }}>
                        <label style={{ display: 'block', fontSize: 12, marginBottom: 3 }}>Base URL</label>
                        <input
                          type="text"
                          value={provider.baseUrl ?? ''}
                          onChange={(e) => handleBaseUrlChange(index, e.target.value)}
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
          );
        })}

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
