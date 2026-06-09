import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIAdapter } from '../../src/gateway/adapters/openai.js';

let mockHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end();
};

const server = http.createServer((req, res) => {
  mockHandler(req, res);
});

let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function sseResponse(lines: string[]): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(lines.join('\n'));
  };
}

async function collectChunks(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('OpenAIAdapter', () => {
  it('streamChat yields text chunks from a plain text response', async () => {
    mockHandler = sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: [DONE]',
    ]);

    const adapter = new OpenAIAdapter({ baseUrl, apiKey: 'test-key', model: 'gpt-4o' });
    const chunks = await collectChunks(adapter.streamChat([]));

    expect(chunks).toContainEqual({ type: 'text', text: 'Hello' });
    expect(chunks).toContainEqual({ type: 'text', text: ' world' });
    expect(chunks).toContainEqual({ type: 'done' });
  });

  it('streamChat ignores blank lines and SSE comments', async () => {
    mockHandler = sseResponse([
      '',
      ': this is a comment',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      '',
      ': another comment',
      'data: [DONE]',
    ]);

    const adapter = new OpenAIAdapter({ baseUrl, apiKey: 'test-key', model: 'gpt-4o' });
    const chunks = await collectChunks(adapter.streamChat([]));

    const textChunks = chunks.filter((c: unknown) => (c as { type: string }).type === 'text');
    const errorChunks = chunks.filter((c: unknown) => (c as { type: string }).type === 'error');
    expect(textChunks).toHaveLength(1);
    expect(errorChunks).toHaveLength(0);
    expect(chunks).toContainEqual({ type: 'done' });
  });

  it('streamChat yields error chunk on non-200 response', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    };

    const adapter = new OpenAIAdapter({ baseUrl, apiKey: 'test-key', model: 'gpt-4o' });
    const chunks = await collectChunks(adapter.streamChat([]));

    expect(chunks.some((c: unknown) => (c as { type: string }).type === 'error')).toBe(true);
  });

  it('callWithTools accumulates tool call arguments across multiple delta events', async () => {
    // Use JSON.stringify to produce valid SSE data lines with correct escaping
    const line1 = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'create_item', arguments: '' } }] } }] });
    const line2 = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"type":' } }] } }] });
    const line3 = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"task"}' } }] }, finish_reason: 'tool_calls' }] });

    mockHandler = sseResponse([line1, line2, line3, 'data: [DONE]']);

    const adapter = new OpenAIAdapter({ baseUrl, apiKey: 'test-key', model: 'gpt-4o' });
    const chunks = await collectChunks(adapter.callWithTools([], []));

    expect(chunks).toContainEqual({
      type: 'tool_call',
      id: 'call1',
      name: 'create_item',
      args: '{"type":"task"}',
    });
    expect(chunks).toContainEqual({ type: 'done' });
  });

  it('callWithTools flushes buffer on [DONE] if finish_reason was not set', async () => {
    const line1 = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'create_item', arguments: '' } }] } }] });
    const line2 = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"type":"task"}' } }] } }] });

    mockHandler = sseResponse([line1, line2, 'data: [DONE]']);

    const adapter = new OpenAIAdapter({ baseUrl, apiKey: 'test-key', model: 'gpt-4o' });
    const chunks = await collectChunks(adapter.callWithTools([], []));

    expect(chunks).toContainEqual({
      type: 'tool_call',
      id: 'call1',
      name: 'create_item',
      args: '{"type":"task"}',
    });
    expect(chunks).toContainEqual({ type: 'done' });
  });

  it('streamChat sends correct Authorization header', async () => {
    let receivedAuth = '';
    mockHandler = (req, res) => {
      receivedAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n');
    };

    const adapter = new OpenAIAdapter({ baseUrl, apiKey: 'test-key', model: 'gpt-4o' });
    await collectChunks(adapter.streamChat([]));

    expect(receivedAuth).toBe('Bearer test-key');
  });

  it('streamChat sends correct model and max_tokens in request body', async () => {
    let parsedBody: { model?: string; max_tokens?: number } = {};
    mockHandler = (req, res) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        try { parsedBody = JSON.parse(data); } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n');
      });
    };

    const adapter = new OpenAIAdapter({ baseUrl, apiKey: 'test-key', model: 'gpt-4o' });
    await collectChunks(adapter.streamChat([]));

    expect(parsedBody.model).toBe('gpt-4o');
    expect(parsedBody.max_tokens).toBe(4096);
  });

  it('constructor throws if baseUrl is empty', () => {
    expect(() => new OpenAIAdapter({ baseUrl: '', apiKey: 'x', model: 'x' })).toThrow();
  });
});
