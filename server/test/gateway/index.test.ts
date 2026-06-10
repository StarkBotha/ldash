import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeClaudeModel } from '../../src/gateway/index.js';

// ---------------------------------------------------------------------------
// normalizeClaudeModel unit tests
// ---------------------------------------------------------------------------

describe('normalizeClaudeModel', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeClaudeModel(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(normalizeClaudeModel('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(normalizeClaudeModel('   ')).toBeUndefined();
  });

  it('maps "sonnet" to claude-sonnet-4-6', () => {
    expect(normalizeClaudeModel('sonnet')).toBe('claude-sonnet-4-6');
  });

  it('maps "opus" to claude-opus-4-8', () => {
    expect(normalizeClaudeModel('opus')).toBe('claude-opus-4-8');
  });

  it('maps "haiku" to claude-haiku-4-5', () => {
    expect(normalizeClaudeModel('haiku')).toBe('claude-haiku-4-5');
  });

  it('alias matching is case-insensitive', () => {
    expect(normalizeClaudeModel('SONNET')).toBe('claude-sonnet-4-6');
    expect(normalizeClaudeModel('Opus')).toBe('claude-opus-4-8');
    expect(normalizeClaudeModel('HAIKU')).toBe('claude-haiku-4-5');
  });

  it('passes through a full model id unchanged', () => {
    expect(normalizeClaudeModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeClaudeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('passes through an unknown string unchanged', () => {
    expect(normalizeClaudeModel('some-future-model')).toBe('some-future-model');
  });

  it('trims surrounding whitespace from non-alias values', () => {
    expect(normalizeClaudeModel('  claude-sonnet-4-6  ')).toBe('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// getAdapter integration: claude-subscription with alias model 'opus'
// ---------------------------------------------------------------------------

vi.mock('../../src/gateway/adapters/claude.js', () => {
  return {
    ClaudeAdapter: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('../../src/gateway/adapters/openai.js', () => {
  return {
    OpenAIAdapter: vi.fn().mockImplementation(() => ({})),
  };
});

import { ClaudeAdapter } from '../../src/gateway/adapters/claude.js';
import { getAdapter } from '../../src/gateway/index.js';

const MockClaudeAdapter = ClaudeAdapter as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAdapter – claude-subscription alias normalisation', () => {
  function makeSettings(model: string | undefined) {
    return {
      getGatewaySettings: () => ({
        providers: [{ name: 'Claude', type: 'claude-subscription' as const, model }],
        activeProvider: 'Claude',
      }),
    };
  }

  it('constructs ClaudeAdapter with claude-opus-4-8 when model is "opus"', () => {
    getAdapter(makeSettings('opus') as never);
    expect(MockClaudeAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-8' })
    );
  });

  it('constructs ClaudeAdapter with undefined model when model is empty (uses adapter default)', () => {
    getAdapter(makeSettings(undefined) as never);
    expect(MockClaudeAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined })
    );
  });

  it('constructs ClaudeAdapter with claude-sonnet-4-6 when model is "sonnet"', () => {
    getAdapter(makeSettings('sonnet') as never);
    expect(MockClaudeAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' })
    );
  });
});
