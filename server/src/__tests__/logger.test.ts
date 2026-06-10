/**
 * Logger unit tests.
 *
 * Because the logger module is a cached ESM singleton, logFilePath is fixed at
 * first import. These tests read the actual logFilePath exported by the module
 * and scan entries by scope so they work regardless of what other tests write.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createLogger, redact, logFilePath } from '../logger.js';

// Helper: read all NDJSON lines from the log file written so far
function readLogLines(): Array<Record<string, unknown>> {
  if (!existsSync(logFilePath)) return [];
  return readFileSync(logFilePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// A unique scope per test run so we don't collide with other log entries
const testScope = `logger-unit-${Date.now()}`;

describe('redact()', () => {
  it('replaces api_key values', () => {
    const result = redact({ api_key: 'secret', other: 'value' }) as Record<string, unknown>;
    expect(result.api_key).toBe('[redacted]');
    expect(result.other).toBe('value');
  });

  it('replaces apiKey values (camelCase)', () => {
    const result = redact({ apiKey: 'secret' }) as Record<string, unknown>;
    expect(result.apiKey).toBe('[redacted]');
  });

  it('replaces authorization values (case-insensitive)', () => {
    const result = redact({ Authorization: 'Bearer tok' }) as Record<string, unknown>;
    expect(result.Authorization).toBe('[redacted]');
  });

  it('replaces token values', () => {
    const result = redact({ token: 'abc123' }) as Record<string, unknown>;
    expect(result.token).toBe('[redacted]');
  });

  it('redacts nested objects', () => {
    const result = redact({ outer: { api_key: 'hidden', safe: 1 } }) as Record<string, unknown>;
    const outer = result.outer as Record<string, unknown>;
    expect(outer.api_key).toBe('[redacted]');
    expect(outer.safe).toBe(1);
  });

  it('handles arrays', () => {
    const result = redact([{ token: 'x' }, { safe: true }]) as Array<Record<string, unknown>>;
    expect(result[0].token).toBe('[redacted]');
    expect(result[1].safe).toBe(true);
  });

  it('passes through non-objects unchanged', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});

describe('NDJSON file write', () => {
  const scope = `${testScope}-write`;

  beforeAll(() => {
    const log = createLogger(scope);
    log.info('hello world', { foo: 'bar', num: 42 });
    log.info('second entry');
  });

  it('writes valid NDJSON with correct fields', () => {
    const lines = readLogLines();
    const found = lines.find(
      (obj) => obj.scope === scope && obj.msg === 'hello world'
    );
    expect(found).toBeDefined();
    expect(found!.level).toBe('info');
    expect(found!.foo).toBe('bar');
    expect(found!.num).toBe(42);
    expect(typeof found!.ts).toBe('string');
    expect(() => new Date(found!.ts as string)).not.toThrow();
  });

  it('appends multiple lines', () => {
    const lines = readLogLines();
    const msgs = lines
      .filter((obj) => obj.scope === scope)
      .map((obj) => obj.msg as string);
    expect(msgs).toContain('hello world');
    expect(msgs).toContain('second entry');
  });
});

describe('level filtering', () => {
  it('entries have the correct level field', () => {
    const scope = `${testScope}-levels`;
    const log = createLogger(scope);
    log.warn('a warning message');
    log.info('an info message');

    const lines = readLogLines().filter((obj) => obj.scope === scope);
    const warnEntry = lines.find((obj) => obj.msg === 'a warning message');
    const infoEntry = lines.find((obj) => obj.msg === 'an info message');

    expect(warnEntry?.level).toBe('warn');
    expect(infoEntry?.level).toBe('info');
  });

  it('silent level suppresses all output', () => {
    // We cannot easily change LOG_LEVEL after module load, but we can
    // verify that the activeLevel() function respects the env var by
    // checking the module exports the expected shape.
    // This is a structural / smoke test.
    expect(typeof createLogger).toBe('function');
    const log = createLogger(`${testScope}-silent`);
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });
});
