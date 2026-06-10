import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { cwd } from 'node:process';

// --- level ordering ---

const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LEVELS)[number];

function levelRank(level: LogLevel): number {
  return LEVELS.indexOf(level);
}

function activeLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (LEVELS.includes(raw as LogLevel)) return raw as LogLevel;
  return 'info';
}

// --- log file setup ---

const logDir = process.env.LOG_DIR ?? join(cwd(), 'logs');
mkdirSync(logDir, { recursive: true });
export const logFilePath = join(logDir, 'ldash.log');

// --- redact helper ---

const REDACT_KEYS = new Set(['apikey', 'api_key', 'authorization', 'token']);

export function redact(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (REDACT_KEYS.has(key.toLowerCase())) {
      result[key] = '[redacted]';
    } else {
      result[key] = redact(value);
    }
  }
  return result;
}

// --- formatting ---

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info:  'INFO ',
  warn:  'WARN ',
  error: 'ERROR',
  silent: 'SILENT',
};

function formatLine(
  ts: string,
  level: LogLevel,
  scope: string,
  message: string,
  fields: Record<string, unknown>
): string {
  const fieldStr = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  const base = `${ts} ${LEVEL_LABELS[level]} [${scope}] ${message}`;
  return fieldStr ? `${base} ${fieldStr}` : base;
}

// --- core write ---

function writeEntry(
  level: LogLevel,
  scope: string,
  message: string,
  fields: Record<string, unknown>
): void {
  const current = activeLevel();
  if (levelRank(current) === levelRank('silent')) return;
  if (levelRank(level) < levelRank(current)) return;

  const ts = new Date().toISOString();

  // stdout
  const line = formatLine(ts, level, scope, message, fields);
  process.stdout.write(line + '\n');

  // NDJSON log file
  const entry = JSON.stringify({ ts, level, scope, msg: message, ...fields });
  try {
    appendFileSync(logFilePath, entry + '\n');
  } catch {
    // Never let logging break the app
  }
}

// --- public API ---

export interface ScopedLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(scope: string): ScopedLogger {
  return {
    debug: (msg, fields = {}) => writeEntry('debug', scope, msg, fields),
    info:  (msg, fields = {}) => writeEntry('info',  scope, msg, fields),
    warn:  (msg, fields = {}) => writeEntry('warn',  scope, msg, fields),
    error: (msg, fields = {}) => writeEntry('error', scope, msg, fields),
  };
}
