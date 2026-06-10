import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { runSchema } from '../../src/db/schema.js';
import { seedColumns } from '../../src/db/seed.js';
import { SettingsService } from '../../src/services/settings.js';
import { clearModelsCache } from '../../src/services/modelsService.js';
import { createModelsRouter } from '../../src/routes/models.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  seedColumns(db);
  return db;
}

async function request(
  app: Hono,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  const ct = res.headers.get('content-type') ?? '';
  const parsed = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Mini HTTP server that acts as a fake OpenAI-compatible /models endpoint
// ---------------------------------------------------------------------------

interface FakeServer {
  baseUrl: string;
  hitCount: () => number;
  close: () => Promise<void>;
}

function startFakeModelsServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<FakeServer> {
  return new Promise((resolve) => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hitCount: () => hits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let db: Database.Database;
let settings: SettingsService;
let app: Hono;

beforeEach(() => {
  clearModelsCache();
  // Ensure claude credential env vars are absent for deterministic fallback tests
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;

  db = makeDb();
  settings = new SettingsService(db);
  app = new Hono();
  app.route('/', createModelsRouter(settings));
});

afterEach(() => {
  clearModelsCache();
});

// ---------------------------------------------------------------------------
// claude-subscription – fallback (no credentials)
// ---------------------------------------------------------------------------

describe('POST /api/models – claude-subscription fallback', () => {
  it('returns the static fallback list and source=fallback when no credentials are set', async () => {
    const { status, body } = await request(app, 'POST', '/api/models', { type: 'claude-subscription' });
    expect(status).toBe(200);
    const b = body as { models: { id: string }[]; source: string };
    expect(b.source).toBe('fallback');
    expect(b.models.length).toBeGreaterThan(0);
    const ids = b.models.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-fable-5');
    expect(ids).toContain('claude-haiku-4-5');
  });

  it('fallback models each have a label field', async () => {
    const { body } = await request(app, 'POST', '/api/models', { type: 'claude-subscription' });
    const b = body as { models: { id: string; label?: string }[] };
    for (const m of b.models) {
      expect(typeof m.label).toBe('string');
      expect(m.label!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// openai-compatible – success
// ---------------------------------------------------------------------------

describe('POST /api/models – openai-compatible success', () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeModelsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'gpt-4o' },
          { id: 'gpt-3.5-turbo' },
          { id: 'gpt-4-turbo' },
        ],
      }));
    });
  });

  afterEach(async () => {
    await fake.close();
  });

  it('returns sorted model ids and source=provider', async () => {
    const { status, body } = await request(app, 'POST', '/api/models', {
      type: 'openai-compatible',
      baseUrl: fake.baseUrl,
    });
    expect(status).toBe(200);
    const b = body as { models: { id: string }[]; source: string };
    expect(b.source).toBe('provider');
    const ids = b.models.map((m) => m.id);
    // sorted alphabetically
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain('gpt-4o');
  });

  it('does not include Authorization header when no apiKey is provided (Ollama style)', async () => {
    let receivedAuth: string | undefined;
    const ollamaFake = await startFakeModelsServer((req, res) => {
      receivedAuth = req.headers['authorization'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'llama3' }] }));
    });

    try {
      await request(app, 'POST', '/api/models', {
        type: 'openai-compatible',
        baseUrl: ollamaFake.baseUrl,
      });
      expect(receivedAuth).toBeUndefined();
    } finally {
      await ollamaFake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// openai-compatible – failure → fallback
// ---------------------------------------------------------------------------

describe('POST /api/models – openai-compatible failure', () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeModelsServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
    });
  });

  afterEach(async () => {
    await fake.close();
  });

  it('returns source=fallback with empty models and an error field', async () => {
    const { status, body } = await request(app, 'POST', '/api/models', {
      type: 'openai-compatible',
      baseUrl: fake.baseUrl,
    });
    expect(status).toBe(200);
    const b = body as { models: unknown[]; source: string; error?: string };
    expect(b.source).toBe('fallback');
    expect(b.models).toEqual([]);
    expect(typeof b.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// openai-compatible – missing baseUrl
// ---------------------------------------------------------------------------

describe('POST /api/models – openai-compatible missing baseUrl', () => {
  it('returns source=fallback with error when baseUrl is empty', async () => {
    const { status, body } = await request(app, 'POST', '/api/models', {
      type: 'openai-compatible',
      baseUrl: '',
    });
    expect(status).toBe(200);
    const b = body as { source: string; error?: string };
    expect(b.source).toBe('fallback');
    expect(typeof b.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Stored key lookup by providerName
// ---------------------------------------------------------------------------

describe('POST /api/models – stored key lookup by providerName', () => {
  let fake: FakeServer;
  let receivedAuth: string | undefined;

  beforeEach(async () => {
    // Save a provider to the DB with a known API key
    settings.setGatewaySettings({
      providers: [
        {
          name: 'MyOpenAI',
          type: 'openai-compatible',
          baseUrl: 'http://placeholder',
          apiKey: 'sk-stored-test-key',
          model: 'gpt-4o',
        },
      ],
      activeProvider: 'MyOpenAI',
    });

    fake = await startFakeModelsServer((req, res) => {
      receivedAuth = req.headers['authorization'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
    });
  });

  afterEach(async () => {
    await fake.close();
  });

  it('uses stored apiKey when apiKey is omitted but providerName matches a saved provider', async () => {
    const { body } = await request(app, 'POST', '/api/models', {
      type: 'openai-compatible',
      baseUrl: fake.baseUrl,
      providerName: 'MyOpenAI',
      // apiKey deliberately omitted
    });
    const b = body as { source: string };
    expect(b.source).toBe('provider');
    expect(receivedAuth).toBe('Bearer sk-stored-test-key');
  });
});

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

describe('POST /api/models – cache', () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeModelsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
    });
  });

  afterEach(async () => {
    await fake.close();
  });

  it('second call returns cached result without re-hitting the mock server', async () => {
    // First call
    await request(app, 'POST', '/api/models', {
      type: 'openai-compatible',
      baseUrl: fake.baseUrl,
    });
    expect(fake.hitCount()).toBe(1);

    // Second call — same baseUrl, should use cache
    await request(app, 'POST', '/api/models', {
      type: 'openai-compatible',
      baseUrl: fake.baseUrl,
    });
    expect(fake.hitCount()).toBe(1); // still 1
  });
});

// ---------------------------------------------------------------------------
// Bad request handling
// ---------------------------------------------------------------------------

describe('POST /api/models – bad request', () => {
  it('returns 400 for invalid body', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown provider type', async () => {
    const { status } = await request(app, 'POST', '/api/models', { type: 'unknown-provider' });
    expect(status).toBe(400);
  });
});
