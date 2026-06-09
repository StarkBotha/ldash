# ldash — Phase 4 Implementation Spec: LLM Chat + Provider Gateway

## Decisions made in this spec

**Gateway package: `@anthropic-ai/claude-agent-sdk`.** The architecture doc specifies this exact package for the Claude subscription adapter. When `ANTHROPIC_API_KEY` is not set in the environment, the SDK authenticates via the user's existing Claude Code subscription (reads `CLAUDE_CODE_OAUTH_TOKEN`, or falls back to the `claude` CLI login on the machine). When subscription auth is selected, the adapter must explicitly ensure `ANTHROPIC_API_KEY` is not passed to the SDK — do not allow an accidentally set env var to switch it to API-key billing. The subscription adapter is always configured with empty `allowedTools` (no file tools, no shell tools) so it behaves as pure chat. Default model for Claude is `claude-sonnet-4-6`.

**OpenAI-compatible adapter: plain `fetch`.** No OpenAI SDK dependency. POST to `{baseUrl}/chat/completions`, parse SSE `data:` lines with the `[DONE]` terminator. Works for OpenAI, OpenRouter, Ollama (`http://localhost:11434/v1`), and LM Studio without any library.

**`callWithTools` on claude-subscription adapter in Phase 4: throws `'not implemented'`.** Phase 5's `loop.ts` requires `callWithTools` on both adapters. Phase 5's own spec confirms it adds the full `callWithTools` implementation to both adapters. In Phase 4, the Claude adapter provides a stub `callWithTools` that throws `new Error('callWithTools not implemented for claude-subscription in Phase 4 — implemented in Phase 5')`. The interface shape defined here is the exact shape Phase 5 expects so no rework is needed. The OpenAI-compatible adapter implements `callWithTools` fully in Phase 4 (streaming tool calls via `tool_calls` deltas) so it can be tested independently.

**Settings stored in the `settings` table (SQLite).** Keeping settings in the same database as board data means one file to back up and no JSON file parsing edge cases. The table stores a single JSON blob under a fixed key. Settings are loaded at startup and re-read on each gateway call so live changes take effect without a server restart.

**API key masking: never returned in full after save.** When `GET /api/settings` is called, the `apiKey` field in any provider entry is returned as `"sk-...XXXX"` (first 3 non-prefix characters followed by masked tail) if longer than 8 characters, or `"***"` if shorter. The raw key is stored in SQLite and never sent to the UI after the initial `PUT`. This is a local single-user tool — no encryption at rest is required, but the key must not leak in normal API responses.

**Migration strategy: same `CREATE TABLE IF NOT EXISTS` pattern as Phase 1.** New tables (`conversations`, `messages`, `settings`) are added to `server/src/db/schema.ts` alongside the Phase 1 tables. This file is `db.exec(sql)` at startup; `IF NOT EXISTS` makes re-runs safe. A migration runner is introduced in Phase 4 to support future structural changes (Phase 5 needs one for the `actor_type` constraint change): a lightweight `server/src/db/migrations/` directory with numbered migration files and a `migrations` table that tracks which have run. For Phase 4, the new tables are created via the existing schema.ts pattern (safe for fresh installs) and a `001_initial_conversations.ts` migration that is a no-op if the tables already exist (for upgraded installs from Phase 3).

**SSE streaming for chat: newline-delimited JSON over `fetch` streaming, consistent with Phase 3.** Phase 3 established `streamText` from Hono for SSE delivery. The chat endpoint uses the same pattern. Each server event is a JSON object written as `data: <JSON>\n\n` so it is a valid SSE stream. The client reads the body with `response.body.getReader()` and decodes newline-delimited JSON events (same pattern recommended by Phase 5's `usePlanningChat.ts` hook — this aligns the two chat surfaces). The event format uses `{ type: 'text', text: string }` | `{ type: 'done' }` | `{ type: 'error', message: string }`.

**Chat context assembly: item + parent + children + last 10 comments + last 20 activity entries.** For item-scoped chats, the backend assembles a system prompt that includes: the item's own fields (title, description, type, status/column name); its direct parent item (title, type, column name) if one exists; its direct children (up to 10, title + type + column name); the last 10 comments on the item (author + body); and the last 20 activity entries for the item (event type + payload + timestamp). The system message is prepended to the message history on every call to the gateway. It is never stored as a persisted message.

**Conversation type `'planning'` supported in Phase 4 schema.** Phase 5 requires a `'planning'` conversation type scoped to a project (item_id is null, type is `'planning'`). The schema and `ConversationService` support this from Phase 4 so Phase 5 has no schema migration for conversations.

**`ConversationService.clearMessages` is included.** Phase 5's planning route calls this method. It must be present in Phase 4's `ConversationService`.

**UI: chat panel as a tab inside `ItemDetailPanel`, not a separate route.** Consistent with Phase 1's design where the detail panel is a slide-in drawer. The chat tab sits alongside the existing Comments and Activity tabs. This is the minimal change to the existing UI surface.

**Provider indicator in UI: a small read-only badge in the chat tab header.** Shows the active provider name and model. Clicking it does not open settings — settings are a separate page/panel.

**Settings UI: a separate settings page accessible via a gear icon in the app header.** This keeps the board UI clean and separates configuration from the planning workflow.

**vitest `include` pattern is extended.** Phase 2's `vitest.config.ts` only includes `src/__tests__/**/*.test.ts`. Phase 4 tests live under `server/test/`. The vitest config must be updated to include `test/**/*.test.ts` as well.

---

## Schema changes

All new tables are added to `server/src/db/schema.ts` using `CREATE TABLE IF NOT EXISTS`. The existing tables are unchanged.

```sql
-- Provider settings. A single JSON blob stored under key 'gateway'.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,   -- JSON string
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Conversations. Scoped to a project; optionally scoped to a single item.
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,           -- nanoid
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id    TEXT REFERENCES items(id) ON DELETE CASCADE,
                                         -- NULL for project-level conversations (type='planning')
  type       TEXT NOT NULL CHECK (type IN ('item', 'planning')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conversations_item    ON conversations(item_id);

-- Messages in a conversation.
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,        -- nanoid
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content         TEXT NOT NULL DEFAULT '',
  tool_calls      TEXT,                    -- JSON string of ToolCallRequest[], NULL when absent
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
```

### Migration runner

**File path:** `server/src/db/migrationRunner.ts`

Introduces a lightweight migration system. The `migrations` table tracks applied migrations:

```sql
CREATE TABLE IF NOT EXISTS migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

**Public interface:**

```ts
export function runMigrations(db: Database): void
```

**Behaviour:**
1. Execute `CREATE TABLE IF NOT EXISTS migrations (...)` to ensure the tracking table exists.
2. Collect all migration modules from `./migrations/` in alphabetical/numeric order.
3. For each migration, check if its name is already recorded in the `migrations` table.
4. If not, call `migration.up(db)` inside a transaction. On success, insert the migration name into `migrations`.
5. If `migration.up(db)` throws, rollback the transaction and re-throw — the server should not start with a partially applied migration.
6. Log each applied migration name to stdout: `[migration] applied: 001_initial_conversations`.

Each migration file exports:

```ts
export const name: string;           // must match the filename stem, e.g. '001_initial_conversations'
export function up(db: Database): void;
```

**File path:** `server/src/db/migrations/001_initial_conversations.ts`

This migration is a no-op guard. `up(db)` runs `CREATE TABLE IF NOT EXISTS conversations (...)` and `CREATE TABLE IF NOT EXISTS messages (...)` — same SQL as schema.ts. This handles the case where a Phase 3 install upgrades to Phase 4 and schema.ts has already been edited but the tables do not yet exist. The `IF NOT EXISTS` makes it idempotent on fresh installs.

**Startup sequence change:** `server/src/index.ts` calls `runMigrations(db)` after `applySchema(db)` and before `seedColumns(db)`.

---

## Project layout additions

All new files. Nothing in the existing tree is deleted or renamed unless explicitly noted.

```
server/
  src/
    db/
      migrationRunner.ts              [new] — migration runner
      migrations/
        001_initial_conversations.ts  [new] — conversations + messages guard migration
    gateway/
      types.ts                        [new] — shared interfaces: ChatMessage, GatewayChunk, ToolDefinition, ToolCallRequest, ChatAdapter, CallOptions
      index.ts                        [new] — getAdapter() factory; reads active settings
      adapters/
        claude.ts                     [new] — Claude Agent SDK adapter
        openai.ts                     [new] — OpenAI-compatible adapter
    services/
      conversations.ts                [new] — ConversationService
      settings.ts                     [new] — SettingsService
    routes/
      conversations.ts                [new] — GET+POST /api/conversations; GET /api/conversations/:id/messages; POST /api/conversations/:id/messages
      settings.ts                     [new] — GET+PUT /api/settings
    types.ts                          [modified] — add Conversation, Message, GatewaySettings, ProviderConfig types; extend Services interface
    index.ts                          [modified] — wire new services and routes; call runMigrations; init settings
  test/
    gateway/
      openai.test.ts                  [new] — OpenAI adapter against mock HTTP server
      claude.test.ts                  [new] — Claude adapter unit test with SDK mocked
    chat/
      context.test.ts                 [new] — context assembly against temp DB
      conversations.test.ts           [new] — ConversationService persistence tests

ui/
  src/
    components/
      ItemDetailPanel.tsx             [modified] — add Chat tab; render ChatPanel
      ChatPanel.tsx                   [new] — streaming chat UI
      SettingsPage.tsx                [new] — provider settings form
    api/
      chat.ts                         [new] — fetch wrappers: getOrCreateConversation, getConversation, sendMessage (streaming)
      settings.ts                     [new] — fetch wrappers: getSettings, updateSettings
    hooks/
      useChat.ts                      [new] — streaming message state management
    types.ts                          [modified] — add Conversation, Message, GatewaySettings, ProviderConfig, StreamEvent types
```

---

## 1. `server/src/gateway/types.ts`

**File path:** `server/src/gateway/types.ts`

**Purpose:** All shared TypeScript interfaces for the LLM gateway — the contract that both adapters and all callers depend on.

**Dependencies:** None (pure types).

**Public interface:**

```ts
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  tool_call_id?: string;        // present when role === 'tool'; the id of the call this is a result for
  tool_calls?: ToolCallRequest[]; // present when role === 'assistant' and the LLM requested tool calls
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object; must have type:'object' and a properties key
}

export interface ToolCallRequest {
  id: string;           // opaque call id; must be echoed back in the corresponding tool result message
  name: string;         // tool name the LLM wants to call
  arguments: string;    // JSON string of the arguments object
}

// Discriminated union of streaming chunks from an adapter.
export type GatewayChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: string }  // args is JSON string, may be partial during streaming
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface CallOptions {
  model?: string;       // overrides the adapter's default model for this call
  maxTokens?: number;   // defaults to 4096 if not specified
}

// The interface both adapters implement.
export interface ChatAdapter {
  // Plain streaming chat — no tool calling. Used for item-scoped chat in Phase 4.
  streamChat(
    messages: ChatMessage[],
    opts?: CallOptions
  ): AsyncIterable<GatewayChunk>;

  // Tool-calling variant. Used by the planning loop in Phase 5.
  // Phase 4 decision: Claude adapter throws 'not implemented'; OpenAI adapter implements fully.
  callWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: CallOptions
  ): AsyncIterable<GatewayChunk>;
}
```

**Data contracts:**

- `GatewayChunk` with `type: 'tool_call'` carries `args` as a potentially partial JSON string during streaming. Consumers must buffer tool_call chunks and only treat `args` as complete JSON when `type: 'done'` has been received for the current turn. In practice, Phase 4 only uses `streamChat` which never emits `tool_call` chunks; Phase 5's loop handles the buffering.
- The `done` chunk signals end of one LLM turn, not end of the entire conversation.
- `error` chunks represent a recoverable streaming error (e.g. provider HTTP error mid-stream). The route handler should surface this to the client and stop reading.

**Do NOT implement:** Any runtime logic. Types only.

---

## 2. `server/src/gateway/adapters/claude.ts`

**File path:** `server/src/gateway/adapters/claude.ts`

**Purpose:** Implements `ChatAdapter` using the `@anthropic-ai/claude-agent-sdk` package, authenticating via the user's Claude subscription when no API key is set.

**Dependencies:**
- `@anthropic-ai/claude-agent-sdk` — `query` function and related types
- `../types` — `ChatAdapter`, `ChatMessage`, `GatewayChunk`, `CallOptions`

**Package additions to `server/package.json`:**

```json
"@anthropic-ai/claude-agent-sdk": "^0.x"
```

(Use the latest available `^0.x` or `^1.x` — whichever is current at implementation time. Do not pin to a patch version.)

**Public interface:**

```ts
export interface ClaudeAdapterOptions {
  authMode: 'subscription' | 'api-key';
  apiKey?: string;     // required when authMode === 'api-key'; must be undefined when authMode === 'subscription'
  model?: string;      // defaults to 'claude-sonnet-4-6'
}

export class ClaudeAdapter implements ChatAdapter {
  constructor(options: ClaudeAdapterOptions)

  async *streamChat(
    messages: ChatMessage[],
    opts?: CallOptions
  ): AsyncGenerator<GatewayChunk>

  async *callWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: CallOptions
  ): AsyncGenerator<GatewayChunk>
}
```

**Behaviour of constructor:**

1. Store `options`.
2. If `options.authMode === 'subscription'`, verify that `process.env.ANTHROPIC_API_KEY` is either unset or explicitly cleared. The adapter must call `delete process.env.ANTHROPIC_API_KEY` before invoking the SDK so a stray env var does not accidentally switch to API-key billing. Record this deletion so it only happens once (store a boolean flag).
3. If `options.authMode === 'api-key'`, verify `options.apiKey` is a non-empty string. Throw `new Error('ClaudeAdapter: apiKey is required when authMode is api-key')` if not.
4. Set the effective model: `opts.model ?? options.model ?? 'claude-sonnet-4-6'` (resolved at call time, not construction time, since `callOptions` may override per-call).

**Behaviour of `streamChat`:**

1. Determine the model: `opts?.model ?? this.options.model ?? 'claude-sonnet-4-6'`.
2. Build the prompt string from `messages`. The `query()` function accepts a `prompt` string. Convert the `ChatMessage[]` to a single prompt using this format:
   - System messages: use the `system` parameter of the query options.
   - User/assistant turns: concatenate as `Human: <content>\n\nAssistant: <content>\n\n` pairs.
   - The final message must be from the user role. If the last message is `assistant`, do not append `Assistant:` — the SDK will complete from where it left off.
3. Call `query({ prompt, system: systemMessage, model, allowedTools: [] })`. The `allowedTools: []` array ensures no tools (file access, shell) are available to the model during chat.
4. The `query` function returns an async iterable of result objects. Iterate it:
   - On text content events: yield `{ type: 'text', text: contentText }`.
   - On completion: yield `{ type: 'done' }`.
   - On error events from the SDK: yield `{ type: 'error', message: errorMessage }` and stop iteration.
5. If the SDK throws synchronously or during async iteration setup, yield `{ type: 'error', message: err.message }` and return.

Note for implementer: The exact event shape from `@anthropic-ai/claude-agent-sdk`'s `query()` async iterable is not fully documented at spec time. The implementer must read the SDK's type definitions to find the correct event fields. The `GatewayChunk` output contract does not change regardless of how the SDK surfaces events.

**Behaviour of `callWithTools`:**

Throw `new Error('callWithTools not implemented for claude-subscription in Phase 4 — see Phase 5 spec')` immediately without attempting any SDK call. Phase 5 adds the full implementation.

**Error handling:**

All errors from the SDK that occur during streaming must be caught and yielded as `{ type: 'error', message }` rather than propagated as thrown exceptions. This is so the route handler's stream-writing loop can cleanly close the SSE stream with an error event rather than crashing.

---

## 3. `server/src/gateway/adapters/openai.ts`

**File path:** `server/src/gateway/adapters/openai.ts`

**Purpose:** Implements `ChatAdapter` for any OpenAI-compatible API (OpenAI, OpenRouter, Ollama, LM Studio) using plain `fetch` with SSE streaming.

**Dependencies:**
- `../types` — `ChatAdapter`, `ChatMessage`, `GatewayChunk`, `ToolDefinition`, `CallOptions`, `ToolCallRequest`
- Node built-in `fetch` (available in Node 18+)

**Public interface:**

```ts
export interface OpenAIAdapterOptions {
  baseUrl: string;     // e.g. 'https://api.openai.com/v1' or 'http://localhost:11434/v1'
  apiKey: string;      // Bearer token; may be 'ollama' or any dummy string for local servers
  model: string;       // e.g. 'gpt-4o', 'llama3', 'mistral'
}

export class OpenAIAdapter implements ChatAdapter {
  constructor(options: OpenAIAdapterOptions)

  async *streamChat(
    messages: ChatMessage[],
    opts?: CallOptions
  ): AsyncGenerator<GatewayChunk>

  async *callWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: CallOptions
  ): AsyncGenerator<GatewayChunk>
}
```

**Behaviour of constructor:**

1. Validate `options.baseUrl` is a non-empty string. Throw `new Error('OpenAIAdapter: baseUrl is required')` if not.
2. Validate `options.model` is a non-empty string. Throw `new Error('OpenAIAdapter: model is required')` if not.
3. Store all options.

**Behaviour of `streamChat`:**

1. Determine effective model: `opts?.model ?? this.options.model`.
2. Map `ChatMessage[]` to the OpenAI messages format. Messages with `role: 'system'`, `'user'`, or `'assistant'` map directly. Messages with `role: 'tool'` are omitted in `streamChat` (tool messages are only meaningful in `callWithTools`). Messages with `tool_calls` on an assistant message: include only the `content` field for `streamChat` (strip `tool_calls`).
3. Build the request body:
   ```json
   {
     "model": "<model>",
     "messages": [...],
     "stream": true,
     "max_tokens": <opts.maxTokens ?? 4096>
   }
   ```
4. POST to `${this.options.baseUrl}/chat/completions` with:
   - `Authorization: Bearer ${this.options.apiKey}`
   - `Content-Type: application/json`
5. If the HTTP response is not `2xx`, yield `{ type: 'error', message: 'OpenAI API error: HTTP ${status}' }` and return.
6. Read the response body as a stream. Process each line:
   - Lines that start with `data: ` are SSE data lines. Extract the content after `data: `.
   - If the content is `[DONE]`, yield `{ type: 'done' }` and stop.
   - Otherwise parse the content as JSON. Access `parsed.choices[0].delta.content`. If it is a non-empty string, yield `{ type: 'text', text: content }`.
   - Lines that are blank or start with `:` (SSE comments) are silently skipped.
7. If JSON parsing fails on any line, skip that line (do not throw — malformed lines can appear at the start of some provider streams).
8. If the stream ends without a `[DONE]` line, yield `{ type: 'done' }` anyway.
9. On any `fetch` or stream-reading error, yield `{ type: 'error', message: err.message }` and return.

**Behaviour of `callWithTools`:**

1. Determine effective model: `opts?.model ?? this.options.model`.
2. Map `messages` to OpenAI format. `role: 'tool'` maps to `{ role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content }`. `role: 'assistant'` with `tool_calls` maps to `{ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls.map(tc => ({ type: 'function', id: tc.id, function: { name: tc.name, arguments: tc.arguments } })) }`.
3. Map `tools` to OpenAI format:
   ```json
   [{ "type": "function", "function": { "name": tool.name, "description": tool.description, "parameters": tool.parameters } }]
   ```
4. Build the request body, adding `"tools"` and `"tool_choice": "auto"` to the `streamChat` body shape.
5. POST to the same endpoint with the same headers.
6. Read the SSE stream. Maintain a `toolCallBuffer: Map<number, { id: string; name: string; argumentsBuffer: string }>` keyed by the delta's `index` field.
7. For each SSE data line:
   - If `delta.content` is non-empty, yield `{ type: 'text', text: delta.content }`.
   - If `delta.tool_calls` is present, for each element in the array:
     - Use `element.index` as the buffer key.
     - If the element has `id` and `function.name`, initialise the buffer entry: `{ id: element.id, name: element.function.name, argumentsBuffer: '' }`.
     - Append `element.function.arguments ?? ''` to `toolCallBuffer[element.index].argumentsBuffer`.
   - If `choices[0].finish_reason === 'tool_calls'`: flush the buffer — for each entry in `toolCallBuffer`, yield `{ type: 'tool_call', id: entry.id, name: entry.name, args: entry.argumentsBuffer }`. Clear the buffer.
   - If the line is `[DONE]`: if the buffer is non-empty (some providers send `[DONE]` instead of a `finish_reason`), flush it as above. Yield `{ type: 'done' }` and stop.
8. On any error, yield `{ type: 'error', message: err.message }` and return.

**SSE line reading helper (internal):**

Implement a private `async *readSSELines(body: ReadableStream<Uint8Array>): AsyncGenerator<string>` that:
1. Creates a `TextDecoder`.
2. Reads chunks from the body reader.
3. Buffers partial lines.
4. Yields complete lines (split on `\n`), trimming `\r` from line endings.

This helper is used by both `streamChat` and `callWithTools`.

---

## 4. `server/src/gateway/index.ts`

**File path:** `server/src/gateway/index.ts`

**Purpose:** Factory that reads the active provider configuration from `SettingsService` and returns the correct `ChatAdapter` instance.

**Dependencies:**
- `./adapters/claude` — `ClaudeAdapter`
- `./adapters/openai` — `OpenAIAdapter`
- `./types` — `ChatAdapter`
- `../services/settings` — `SettingsService`

**Public interface:**

```ts
export function getAdapter(settings: SettingsService): ChatAdapter
```

**Behaviour:**

1. Call `settings.getGatewaySettings()` to get the current `GatewaySettings`.
2. If `settings.activeProvider` is `null` or `settings.providers` is empty, throw `new Error('No LLM provider configured. Go to Settings to add a provider.')`.
3. Find the active provider: `settings.providers.find(p => p.name === settings.activeProvider)`. If not found, throw `new Error('Active provider not found in settings. Check your provider configuration.')`.
4. If `provider.type === 'claude-subscription'`: return `new ClaudeAdapter({ authMode: 'subscription', model: provider.model })`.
5. If `provider.type === 'openai-compatible'`: return `new OpenAIAdapter({ baseUrl: provider.baseUrl!, apiKey: provider.apiKey!, model: provider.model })`.
6. Otherwise throw `new Error('Unknown provider type: ' + provider.type)`.

**Note:** `getAdapter` is called per-request, not once at startup. This ensures settings changes take effect immediately without a restart.

---

## 5. `server/src/services/settings.ts`

**File path:** `server/src/services/settings.ts`

**Purpose:** Reads and writes the LLM gateway settings (provider list + active provider) from the `settings` table.

**Dependencies:**
- `better-sqlite3` — `Database`
- `../types` — `GatewaySettings`, `ProviderConfig`

**Public interface:**

```ts
export class SettingsService {
  constructor(db: Database)

  getGatewaySettings(): GatewaySettings
  // Returns the current gateway settings. If the 'gateway' key does not exist in the settings table,
  // returns the default: { providers: [], activeProvider: null }.

  setGatewaySettings(settings: GatewaySettings): GatewaySettings
  // Validates and persists the settings. Returns the saved settings (with API keys masked for return).
  // Note: stores the full unmasked keys in the database; masking is applied by the route layer.

  getMaskedGatewaySettings(): GatewaySettings
  // Same as getGatewaySettings but with all apiKey fields masked. Used by GET /api/settings.
}
```

**Behaviour of `getGatewaySettings`:**

1. Execute `SELECT value FROM settings WHERE key = 'gateway'`.
2. If no row is found, return `{ providers: [], activeProvider: null }`.
3. Parse the `value` JSON string and return it as `GatewaySettings`.
4. If JSON parsing fails (corrupted settings), log `console.error('Settings: failed to parse gateway settings, returning defaults')` and return `{ providers: [], activeProvider: null }`.

**Behaviour of `setGatewaySettings(settings)`:**

1. Validate the input:
   - `settings.providers` must be an array (may be empty).
   - Each provider must have a non-empty `name` (string) and `type` in `['claude-subscription', 'openai-compatible']`.
   - Providers of type `'openai-compatible'` must have a non-empty `baseUrl` and `apiKey` and `model`.
   - Providers of type `'claude-subscription'` must have a `model` (string, may be an alias like `'sonnet'`). `baseUrl` and `apiKey` are ignored and should be stripped before storage.
   - `settings.activeProvider` must be either `null` or a string that matches one of the `provider.name` values. If it does not match and is not null, throw `new Error('activeProvider does not match any provider name')`.
   - Provider names must be unique within the array. Throw `new Error('Provider names must be unique')` if duplicates exist.
2. Serialise `settings` to JSON.
3. Execute `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('gateway', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`.
4. Return the saved settings (full unmasked, as stored).

**Behaviour of `getMaskedGatewaySettings`:**

1. Call `getGatewaySettings()`.
2. For each provider: if `provider.apiKey` is set, replace it with the masked version — see masking algorithm below. If `provider.apiKey` is undefined or empty, leave it as-is.
3. Return the masked copy.

**API key masking algorithm:**

```ts
function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  // Preserve up to the first 7 characters (handles 'sk-....' prefixes), mask the rest
  const visible = key.slice(0, 7);
  return visible + '...' + key.slice(-4).replace(/./g, 'X');
}
```

Example: `'sk-abcdefghijklmnop'` → `'sk-abcd...XXXX'`.

---

## 6. `server/src/services/conversations.ts`

**File path:** `server/src/services/conversations.ts`

**Purpose:** All read/write operations on the `conversations` and `messages` tables.

**Dependencies:**
- `better-sqlite3` — `Database`
- `../types` — `Conversation`, `Message`, `ConversationType`
- `nanoid` (already a dependency from Phase 1)

**Public interface:**

```ts
export class ConversationService {
  constructor(db: Database)

  getOrCreateItemConversation(projectId: string, itemId: string): Conversation
  // Get the existing item-scoped conversation, or create one if none exists.
  // Conversations are identified by (item_id, type='item'). There is at most one per item.

  getOrCreatePlanningConversation(projectId: string): Conversation
  // Get the existing planning conversation for the project, or create one.
  // Identified by (project_id, item_id IS NULL, type='planning'). At most one per project.

  getConversation(conversationId: string): Conversation | undefined

  getMessages(conversationId: string): Message[]
  // Returns all messages for the conversation ordered by created_at ASC.

  appendMessage(conversationId: string, data: {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCallRequest[] | null;
  }): Message
  // Inserts a new message. tool_calls is JSON-serialised if present, NULL otherwise.

  clearMessages(conversationId: string): void
  // Deletes all messages for the conversation. Does NOT delete the conversation itself.
}
```

**Behaviour of `getOrCreateItemConversation(projectId, itemId)`:**

1. Execute `SELECT * FROM conversations WHERE item_id = ? AND type = 'item'` with `itemId`.
2. If a row is found, return it as a `Conversation`.
3. If not found, insert a new row: `INSERT INTO conversations (id, project_id, item_id, type) VALUES (nanoid(), ?, ?, 'item')`.
4. Return the newly created `Conversation`.
5. Do NOT verify that `projectId` or `itemId` exist — the route layer already validated them before calling this.

**Behaviour of `getOrCreatePlanningConversation(projectId)`:**

1. Execute `SELECT * FROM conversations WHERE project_id = ? AND item_id IS NULL AND type = 'planning'` with `projectId`.
2. If found, return it.
3. If not found, insert: `INSERT INTO conversations (id, project_id, item_id, type) VALUES (nanoid(), ?, NULL, 'planning')`.
4. Return the new row.

**Behaviour of `getConversation(conversationId)`:**

Execute `SELECT * FROM conversations WHERE id = ?`. Return the row or `undefined`.

**Behaviour of `getMessages(conversationId)`:**

1. Execute `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`.
2. For each row, parse `tool_calls` from JSON if non-null; otherwise set to `null`.
3. Return the array of `Message` objects.

**Behaviour of `appendMessage(conversationId, data)`:**

1. Generate `id = nanoid()`.
2. Serialise `data.tool_calls` to a JSON string if present; otherwise use SQL `NULL`.
3. Execute `INSERT INTO messages (id, conversation_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)`.
4. Return the inserted row (fetch it back with `SELECT * FROM messages WHERE id = ?`).

**Behaviour of `clearMessages(conversationId)`:**

Execute `DELETE FROM messages WHERE conversation_id = ?`. No return value.

---

## 7. Context assembly — `server/src/gateway/context.ts`

**File path:** `server/src/gateway/context.ts`

**Purpose:** Assembles the system prompt for item-scoped chat conversations.

**Dependencies:**
- `../types` — `Services`, `Item`, `Comment`, `ActivityEntry`

**Public interface:**

```ts
export function buildItemChatContext(services: Services, itemId: string): string
```

**Behaviour:**

1. Fetch `item = services.items.get(itemId)`. If undefined, throw `new Error('Item not found: ' + itemId)`.
2. Fetch `columns = services.columns.list()`. Build `columnMap: Map<string, string>` of `id → name`. Look up `columnName = columnMap.get(item.column_id) ?? item.column_id`.
3. Fetch parent item: if `item.parent_id` is non-null, call `services.items.get(item.parent_id)`. Resolve parent's column name the same way.
4. Fetch children: call `services.items.listFiltered({ project_id: item.project_id, parent_id: itemId })`. Take the first 10 results (sort is already `column_id ASC, position ASC` from Phase 2's `listFiltered`). Resolve each child's column name.
5. Fetch comments: call `services.comments.listByItem(itemId)`. Take the last 10 entries (the list is ordered `created_at ASC`, so take the slice `comments.slice(-10)`).
6. Fetch activity: call `services.activity.listByItem(itemId, { limit: 20 })`. This returns entries in `created_at DESC` order; reverse them so they are chronological for the context.
7. Build the context string in this exact format:

```
You are a helpful assistant for a software project planning board. You are currently helping with a specific item. Below is the context for that item.

ITEM:
  Title: <item.title>
  Type: <item.type>
  Status: <columnName>
  Description: <item.description if non-empty, else '(no description)'>
  Flagged: <'Yes' if item.flagged else 'No'>
  Blocked: <'Yes — <item.blocked_reason>' if item.blocked else 'No'>

<if item.parent_id is non-null:>
PARENT ITEM:
  Title: <parent.title>
  Type: <parent.type>
  Status: <parentColumnName>

<if children.length > 0:>
CHILD ITEMS (<count>):
<for each child:>
  - [<child.type>] <child.title> (status: <childColumnName>)

<if comments.length > 0:>
RECENT COMMENTS (last <count>):
<for each comment:>
  [<comment.author> at <comment.created_at>] <comment.body>

<if activity.length > 0:>
RECENT ACTIVITY (last <count> entries):
<for each activity entry (chronological, oldest first):>
  [<entry.created_at>] <entry.event_type> — <JSON.stringify(entry.payload)>

INSTRUCTIONS:
- Answer questions about this item, its context, and what work it involves.
- You may suggest approaches, identify risks, or help break down the work.
- Do not create, delete, or modify board items — you are in read-only chat mode.
- Keep responses concise and actionable.
```

8. Return the assembled string.

**Edge cases:**
- If the item has no parent, omit the `PARENT ITEM:` section entirely.
- If no children, omit `CHILD ITEMS` section.
- If no comments, omit `RECENT COMMENTS` section.
- If no activity, omit `RECENT ACTIVITY` section.
- The `INSTRUCTIONS` block is always present.

---

## 8. `server/src/routes/conversations.ts`

**File path:** `server/src/routes/conversations.ts`

**Purpose:** HTTP routes for getting/creating conversations and for posting messages with streaming responses.

**Dependencies:**
- `hono` — `Hono`, `streamText`
- `../types` — `Services`
- `../services/conversations` — `ConversationService`
- `../services/settings` — `SettingsService`
- `../gateway/index` — `getAdapter`
- `../gateway/context` — `buildItemChatContext`

**Public interface:**

```ts
export function createConversationsRouter(
  services: Services,
  conversations: ConversationService,
  settings: SettingsService
): Hono
```

---

### `POST /api/conversations`

Get-or-create a conversation for the given item or project.

**Request body:**
```ts
{
  projectId: string;    // required
  itemId?: string;      // if present, type='item'; if absent, type='planning'
}
```

**Response `200`:** `Conversation` object.

**Errors:** `400` if `projectId` is missing. `404` if `projectId` does not reference an existing project. `404` if `itemId` is provided but does not reference an existing item in that project.

**Behaviour:**
1. Validate `projectId`. Call `services.projects.get(projectId)`. If not found, return `404`.
2. If `itemId` is provided: call `services.items.get(itemId)`. If not found or `item.project_id !== projectId`, return `404` with message `'Item not found in this project'`.
3. If `itemId` is provided: call `conversations.getOrCreateItemConversation(projectId, itemId)`. Return the `Conversation`.
4. If `itemId` is absent: call `conversations.getOrCreatePlanningConversation(projectId)`. Return the `Conversation`.

---

### `GET /api/conversations/:id`

Get a conversation and all its messages.

**Response `200`:**
```ts
{
  conversation: Conversation;
  messages: Message[];
}
```

**Errors:** `404` if the conversation does not exist.

**Behaviour:**
1. Call `conversations.getConversation(id)`. If undefined, return `404`.
2. Call `conversations.getMessages(id)`.
3. Return `{ conversation, messages }`.

---

### `POST /api/conversations/:id/messages`

Persist the user message and stream the assistant response.

**Request body:**
```ts
{ content: string }   // required; must be non-empty
```

**Response:** `text/event-stream`. Each line is a JSON-encoded `ChatStreamEvent` followed by `\n`.

```ts
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

**Errors (pre-stream):** `404` if conversation not found. `400` if `content` is missing or empty. `500` with JSON body if no provider is configured (before the stream opens).

**Behaviour:**
1. Validate conversation exists via `conversations.getConversation(id)`. If not found, return `404`.
2. Validate `content`. If empty/missing, return `400`.
3. Attempt to get the adapter: call `getAdapter(settings)`. If this throws (no provider configured), return `500 { "error": err.message }` before opening the stream.
4. Persist the user message: call `conversations.appendMessage(id, { role: 'user', content })`.
5. Fetch the full message history: call `conversations.getMessages(id)`. This includes the just-saved user message.
6. Map `Message[]` to `ChatMessage[]`: `{ role: message.role, content: message.content, tool_calls: message.tool_calls ?? undefined }`.
7. If the conversation type is `'item'` and `conversation.item_id` is non-null: build a system prompt via `buildItemChatContext(services, conversation.item_id)`. Prepend `{ role: 'system', content: systemPrompt }` to the message array.
8. Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
9. Use Hono's `streamText` to open the SSE stream.
10. Iterate `adapter.streamChat(messages)`:
    - On `{ type: 'text', text }`: accumulate into `assistantBuffer` (a local string); write `data: ${JSON.stringify({ type: 'text', text })}\n\n` to the stream.
    - On `{ type: 'done' }`: write `data: ${JSON.stringify({ type: 'done' })}\n\n`. Break.
    - On `{ type: 'error', message }`: write `data: ${JSON.stringify({ type: 'error', message })}\n\n`. Break without persisting.
    - On `{ type: 'tool_call', ... }`: skip silently — `streamChat` should not emit these, but be defensive.
11. After the stream ends normally (after `done`): persist the assistant message with the accumulated `assistantBuffer` via `conversations.appendMessage(id, { role: 'assistant', content: assistantBuffer })`.
12. On any unexpected error during stream iteration: write `data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted' })}\n\n` and stop.

---

## 9. `server/src/routes/settings.ts`

**File path:** `server/src/routes/settings.ts`

**Purpose:** HTTP routes to read and update gateway settings.

**Dependencies:**
- `hono` — `Hono`
- `../services/settings` — `SettingsService`
- `../types` — `GatewaySettings`

**Public interface:**

```ts
export function createSettingsRouter(settings: SettingsService): Hono
```

---

### `GET /api/settings`

Returns the current gateway settings with API keys masked.

**Response `200`:** `GatewaySettings` with all `apiKey` fields masked.

**Behaviour:**
1. Call `settings.getMaskedGatewaySettings()`.
2. Return `200` with the masked settings object.

---

### `PUT /api/settings`

Replaces the entire gateway settings object.

**Request body:** `GatewaySettings`

```ts
{
  providers: ProviderConfig[];
  activeProvider: string | null;
}
```

**Response `200`:** The saved settings with API keys masked (same shape as `GET`).

**Errors:** `400` if the body is missing required fields or fails validation (propagate the error message from `SettingsService.setGatewaySettings`).

**Behaviour:**
1. Parse the request body.
2. Validate: `providers` must be an array; `activeProvider` must be a string or null. If either is missing or wrong type, return `400 { "error": "Invalid settings body" }`.
3. Call `settings.setGatewaySettings(body)`. If it throws a validation error, return `400 { "error": err.message }`.
4. Return `200` with `settings.getMaskedGatewaySettings()`.

---

## 10. TypeScript types (`server/src/types.ts` additions)

Add the following to the existing `server/src/types.ts`. Do not modify existing types.

```ts
export type ConversationType = 'item' | 'planning';

export interface Conversation {
  id: string;
  project_id: string;
  item_id: string | null;
  type: ConversationType;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: ToolCallRequest[] | null;   // ToolCallRequest imported from gateway/types — re-export it here
  created_at: string;
}

export type ProviderType = 'claude-subscription' | 'openai-compatible';

export interface ProviderConfig {
  name: string;         // user-chosen label, e.g. 'My Claude', 'OpenRouter GPT-4o'
  type: ProviderType;
  model: string;        // model id or alias
  baseUrl?: string;     // openai-compatible only
  apiKey?: string;      // openai-compatible only; stored full, returned masked
}

export interface GatewaySettings {
  providers: ProviderConfig[];
  activeProvider: string | null;  // matches a provider.name, or null if none selected
}

// Extend the existing Services interface (defined in Phase 2):
// Add conversations: ConversationService and settings: SettingsService
// The full Services interface after Phase 4:
export interface Services {
  projects: ProjectService;
  items: ItemService;
  columns: ColumnService;
  comments: CommentService;
  activity: ActivityService;
  conversations: ConversationService;
  settings: SettingsService;
}
```

Also re-export `ToolCallRequest` from `./gateway/types` so callers of `types.ts` do not need to import from the gateway module:

```ts
export type { ToolCallRequest } from './gateway/types.js';
```

---

## 11. `server/src/index.ts` changes

**File path:** `server/src/index.ts` (modified)

Changes to the startup sequence (numbered additions to Phase 1's steps):

After step 2 (run schema.ts), add:
- 2a. Call `runMigrations(db)`.

After step 4 (instantiate services), add:
- 4a. Instantiate `settingsService = new SettingsService(db)`.
- 4b. Instantiate `conversationService = new ConversationService(db)`.
- 4c. Extend the `services` object: `{ ...existingServices, conversations: conversationService, settings: settingsService }`.

In step 6 (register routes), add:
```ts
import { createConversationsRouter } from './routes/conversations.js';
import { createSettingsRouter } from './routes/settings.js';

app.route('/', createConversationsRouter(services, conversationService, settingsService));
app.route('/', createSettingsRouter(settingsService));
```

Add to `server/package.json` dependencies:
```json
"@anthropic-ai/claude-agent-sdk": "^0.x"
```

No other changes.

---

## 12. `server/vitest.config.ts` change

**File path:** `server/vitest.config.ts` (modified)

Change the `include` pattern from `['src/__tests__/**/*.test.ts']` to:

```ts
include: ['src/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
```

This makes Phase 4 tests (under `server/test/`) discoverable by vitest.

---

## 13. UI types (`ui/src/types.ts` additions)

Add to `ui/src/types.ts`:

```ts
export type ConversationType = 'item' | 'planning';

export interface Conversation {
  id: string;
  project_id: string;
  item_id: string | null;
  type: ConversationType;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: unknown[] | null;
  created_at: string;
}

export type ProviderType = 'claude-subscription' | 'openai-compatible';

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  model: string;
  baseUrl?: string;
  apiKey?: string;   // on GET this is masked; on PUT this is the real key the user types
}

export interface GatewaySettings {
  providers: ProviderConfig[];
  activeProvider: string | null;
}

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

---

## 14. `ui/src/api/chat.ts`

**File path:** `ui/src/api/chat.ts`

**Purpose:** Typed fetch wrappers for conversation and message endpoints.

**Dependencies:** `../types` — `Conversation`, `Message`, `ChatStreamEvent`

**Public interface:**

```ts
export async function getOrCreateConversation(
  projectId: string,
  itemId?: string
): Promise<Conversation>
// POST /api/conversations with { projectId, itemId? }

export async function getConversation(
  conversationId: string
): Promise<{ conversation: Conversation; messages: Message[] }>
// GET /api/conversations/:id

export async function streamMessage(
  conversationId: string,
  content: string,
  onChunk: (event: ChatStreamEvent) => void
): Promise<void>
// POST /api/conversations/:id/messages
// Reads the response body as a stream, parses newline-delimited JSON events,
// and calls onChunk for each event.
// Resolves when the 'done' event is received or the stream ends.
// Rejects on network error or if an 'error' event is received.
```

**Behaviour of `streamMessage`:**

1. POST to `/api/conversations/${conversationId}/messages` with `{ content }` and `Accept: text/event-stream`.
2. If the response is not `2xx`, throw `new Error('HTTP ' + response.status)`.
3. Read `response.body` using `getReader()`.
4. Decode chunks with `TextDecoder`. Buffer partial lines.
5. For each complete line (terminated by `\n`):
   - If blank, skip.
   - If starts with `data: `, parse the remainder as JSON into a `ChatStreamEvent`.
   - Call `onChunk(event)`.
   - If `event.type === 'done'`, close the reader and return.
   - If `event.type === 'error'`, close the reader and throw `new Error(event.message)`.
6. If the stream ends without a `done` event, call `onChunk({ type: 'done' })` and return.

---

## 15. `ui/src/api/settings.ts`

**File path:** `ui/src/api/settings.ts`

**Purpose:** Typed fetch wrappers for the settings endpoints.

**Dependencies:** `../types` — `GatewaySettings`

**Public interface:**

```ts
export async function getSettings(): Promise<GatewaySettings>
// GET /api/settings — returns masked settings

export async function updateSettings(settings: GatewaySettings): Promise<GatewaySettings>
// PUT /api/settings — returns masked settings
// Throws on HTTP 4xx/5xx with the error message from the response body
```

**Behaviour of `updateSettings`:**

1. PUT to `/api/settings` with `Content-Type: application/json` and the settings object as the body.
2. If response is not `2xx`, read the response JSON and throw `new Error(json.error ?? 'Failed to save settings')`.
3. Return the response JSON as `GatewaySettings`.

---

## 16. `ui/src/hooks/useChat.ts`

**File path:** `ui/src/hooks/useChat.ts`

**Purpose:** Manages the state of a single chat conversation: history, current streaming text, and streaming status.

**Dependencies:**
- `react` — `useState`, `useEffect`, `useCallback`
- `../api/chat` — `getOrCreateConversation`, `getConversation`, `streamMessage`
- `../types` — `Conversation`, `Message`, `ChatStreamEvent`

**Public interface:**

```ts
export interface UseChatReturn {
  conversation: Conversation | null;
  messages: Message[];
  streamingText: string;    // partial text of the in-progress assistant response
  isStreaming: boolean;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  dismissError: () => void;
}

export function useChat(projectId: string, itemId: string): UseChatReturn
```

**Behaviour:**

On mount (when `projectId` and `itemId` are both non-empty):
1. Call `getOrCreateConversation(projectId, itemId)` to get or create the conversation.
2. Call `getConversation(conversationId)` to load the existing message history.
3. Set `conversation` and `messages` state.
4. If any call fails, set `error` with the error message.

`sendMessage(content)`:
1. If `isStreaming` is true, return early (no-op).
2. Set `isStreaming = true`, `streamingText = ''`, `error = null`.
3. Optimistically append `{ id: 'temp-user', conversation_id, role: 'user', content, tool_calls: null, created_at: new Date().toISOString() }` to `messages`.
4. Call `streamMessage(conversation.id, content, (event) => { ... })` with:
   - `text` event: append `event.text` to `streamingText`.
   - `done` event: append a final assistant `Message` (with `id: 'temp-assistant'`, `content: streamingText`, `role: 'assistant'`, `tool_calls: null`) to `messages`. Set `streamingText = ''`. Set `isStreaming = false`. Then refresh the real messages from the server: call `getConversation(conversation.id)` and replace the `messages` state with the server's version (which has real nanoid `id` values).
   - `error` event: set `error = event.message`. Set `isStreaming = false`. Remove the optimistic user message.
5. If `streamMessage` rejects (network error), set `error = err.message`, set `isStreaming = false`, remove the optimistic user message.

`dismissError()`: set `error = null`.

---

## 17. `ui/src/components/ChatPanel.tsx`

**File path:** `ui/src/components/ChatPanel.tsx`

**Purpose:** The visible chat interface — message history, streaming response, text input.

**Dependencies:**
- `react` — `useState`, `useRef`, `useEffect`
- `../hooks/useChat` — `useChat`
- `../types` — `Message`

**Public interface:**

```ts
interface ChatPanelProps {
  projectId: string;
  itemId: string;
  providerLabel: string;   // e.g. 'Claude (sonnet)' or 'OpenRouter / gpt-4o' — shown as a badge
}

export function ChatPanel({ projectId, itemId, providerLabel }: ChatPanelProps): JSX.Element
```

**Behaviour:**

1. Call `useChat(projectId, itemId)`.
2. Render a small badge at the top showing `providerLabel`. If `providerLabel` is empty or not configured, show `'No provider configured'` in amber.
3. Render a scrollable message list. User messages right-aligned, assistant messages left-aligned. Each message shows the `content` text and a relative timestamp.
4. If `isStreaming` is true, render a partial message bubble at the bottom with `streamingText` and a blinking cursor (CSS animation: a `|` character that fades in and out).
5. At the bottom: a `<textarea>` and a "Send" button. Disabled while `isStreaming`. On submit (button click or `Enter` without `Shift`), call `sendMessage(inputValue)` and clear the textarea.
6. If `error` is non-null, render a red banner above the input with the error text and a dismiss button that calls `dismissError()`.
7. Auto-scroll the message list to the bottom when `messages.length` changes or `streamingText` changes. Use a `useRef` on the bottom of the list and `scrollIntoView({ behavior: 'smooth' })`.
8. If the conversation is still loading (no `conversation` in state yet), render a single "Loading..." placeholder.

**Do NOT implement:** Provider selection or settings navigation — those belong in `SettingsPage`. This component is read-only about the provider, displaying only the `providerLabel` passed as a prop.

---

## 18. `ui/src/components/SettingsPage.tsx`

**File path:** `ui/src/components/SettingsPage.tsx`

**Purpose:** A settings panel/page where the user configures LLM providers and selects the active provider.

**Dependencies:**
- `react` — `useState`, `useEffect`
- `../api/settings` — `getSettings`, `updateSettings`
- `../types` — `GatewaySettings`, `ProviderConfig`, `ProviderType`

**Public interface:**

```ts
interface SettingsPageProps {
  onClose: () => void;
}

export function SettingsPage({ onClose }: SettingsPageProps): JSX.Element
```

**Behaviour:**

On mount: call `getSettings()` and populate form state.

Renders:
1. A heading "LLM Settings" and a close button (calls `onClose`).
2. A section "Providers" with a list of configured providers. Each provider shows: its `name`, `type`, `model`, and (for openai-compatible) `baseUrl`. The `apiKey` field shows the masked value (received from the server). An "Edit" button opens an inline form for that provider. A "Delete" button removes it from the list.
3. An "Add provider" button that appends a blank provider form to the list.
4. The provider form fields:
   - `name`: text input (required).
   - `type`: a select with options `'claude-subscription'` and `'openai-compatible'`.
   - `model`: text input (required). Placeholder text: `'e.g. claude-sonnet-4-6, gpt-4o, llama3'`.
   - If `type === 'openai-compatible'`: also show `baseUrl` (text input, placeholder `'http://localhost:11434/v1'`) and `apiKey` (password input, placeholder `'Enter new API key (leave blank to keep current)'`). If the user leaves the `apiKey` field blank when editing, send the existing masked value as-is — the server must handle receiving a masked value by NOT overwriting the stored key. Note for implementer: implement this by sending `undefined` for `apiKey` when the field is blank during an edit, and having the server preserve the stored key when `apiKey` is absent from a provider record.
   - If `type === 'claude-subscription'`: `baseUrl` and `apiKey` fields are hidden.
5. A section "Active provider": a select populated with all provider names (plus a `'(none)'` option). Changing it updates `settings.activeProvider` in local state.
6. A "Save" button that calls `updateSettings(localSettings)`. On success, show a brief "Saved" indicator (set state, auto-clear after 2 seconds). On failure, show the error message.

**Note for implementer on the API key blank-field handling:** When the user opens an existing provider for editing and leaves the `apiKey` field empty, the component should NOT send the masked string from the server — it should omit `apiKey` from that provider in the PUT body. The server's `SettingsService.setGatewaySettings` must preserve the stored `apiKey` for a provider whose entry in the incoming settings lacks the `apiKey` field. Implement this by: (a) in `SettingsService.setGatewaySettings`, for each incoming provider, if `provider.apiKey` is `undefined`, look up the existing provider by name in the currently stored settings and copy its `apiKey` over. (b) In the UI, send `undefined` (not `''`) for `apiKey` when the field is left blank.

---

## 19. `ui/src/components/ItemDetailPanel.tsx` modifications

**File path:** `ui/src/components/ItemDetailPanel.tsx` (modified)

Add a "Chat" tab to the existing tabs (or introduce tabs if Phase 1 had no tab structure — if Phase 1 used a single scrolling panel, add a simple tab switcher at the top of the panel with tabs: "Details", "Comments / Activity", "Chat").

When the "Chat" tab is active:
1. Render `<ChatPanel projectId={item.project_id} itemId={item.id} providerLabel={providerLabel} />`.
2. `providerLabel` is derived from `GET /api/settings` — fetch it once and display the active provider's `name + ' / ' + model`. Use a `useQuery` call keyed on `['settings']` with `queryFn: getSettings`. If settings load fails or no provider is active, pass `providerLabel=""`.

The "Details" tab contains the existing content (title, type, status dropdown, flag/block toggles, description edit). The "Comments / Activity" tab contains `CommentBox` and `ActivityFeed`.

No other logic changes to `ItemDetailPanel`.

---

## 20. App header gear icon

**File path:** `ui/src/App.tsx` (modified) or the component that renders the top-level app shell.

Add a gear icon button in the app header. When clicked, it renders `<SettingsPage onClose={() => setShowSettings(false)} />` as a modal overlay (fixed full-screen backdrop with a centered card). State: `showSettings: boolean`, initially `false`.

The gear icon is always visible regardless of which view is active (project list or board).

---

## Tests

### `server/test/gateway/openai.test.ts`

**File path:** `server/test/gateway/openai.test.ts`

**Purpose:** Verifies the OpenAI adapter's streaming behaviour against a mock HTTP server.

**Dependencies:**
- `vitest` — `describe`, `it`, `expect`, `beforeAll`, `afterAll`
- `node:http` — to create a minimal mock server
- `../../src/gateway/adapters/openai` — `OpenAIAdapter`

**Setup:** `beforeAll` creates a Node `http.createServer` on a random port (`port 0`). The mock server handles `POST /chat/completions` by responding with a preset SSE stream. `afterAll` closes the server.

The mock server must be configurable per test. Use a module-level `let mockHandler: (req, res) => void` variable. Each test sets `mockHandler` before calling the adapter.

**Helper function `sseResponse(lines: string[])`:** Returns a mock server handler that writes `Content-Type: text/event-stream` and the given lines joined by `\n`, then ends the response.

**Required test cases:**

1. `streamChat yields text chunks from a plain text response` — mock server sends:
   ```
   data: {"choices":[{"delta":{"content":"Hello"}}]}
   data: {"choices":[{"delta":{"content":" world"}}]}
   data: [DONE]
   ```
   Collect all chunks from the adapter. Assert chunks include `{ type: 'text', text: 'Hello' }` and `{ type: 'text', text: ' world' }` and a final `{ type: 'done' }`.

2. `streamChat ignores blank lines and SSE comments` — mock server sends lines with blank lines and `: comment` mixed in. Assert only text and done chunks are yielded; no extras.

3. `streamChat yields error chunk on non-200 response` — mock server responds with HTTP 401. Assert the collected chunks contain one `{ type: 'error' }` chunk.

4. `callWithTools accumulates tool call arguments across multiple delta events` — mock server sends:
   ```
   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"create_item","arguments":""}}]}}]}
   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"type\":"}}]}}]}
   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"task\"}"}}]},"finish_reason":"tool_calls"}]}
   data: [DONE]
   ```
   Assert the chunks include one `{ type: 'tool_call', id: 'call1', name: 'create_item', args: '{"type":"task"}' }` and a `{ type: 'done' }`.

5. `callWithTools flushes buffer on [DONE] if finish_reason was not set` — same scenario as test 4 but without the `finish_reason: 'tool_calls'` in the stream (some providers omit it). Assert the tool_call chunk is still yielded.

6. `streamChat sends correct Authorization header` — mock server records received headers. Assert `Authorization` header is `'Bearer test-key'`.

7. `streamChat sends correct model and max_tokens in request body` — mock server reads the request body. Assert `body.model === 'gpt-4o'` and `body.max_tokens === 4096`.

8. `constructor throws if baseUrl is empty` — assert `new OpenAIAdapter({ baseUrl: '', apiKey: 'x', model: 'x' })` throws.

---

### `server/test/gateway/claude.test.ts`

**File path:** `server/test/gateway/claude.test.ts`

**Purpose:** Unit tests for the Claude adapter with the SDK mocked. Real subscription calls are excluded from CI.

**Dependencies:**
- `vitest` — `describe`, `it`, `expect`, `vi`
- `../../src/gateway/adapters/claude` — `ClaudeAdapter`

**Mocking strategy:** Use `vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))`. Before each test, configure `query` as a mock that returns a predefined async iterable.

**Required test cases:**

1. `streamChat yields text chunks from SDK response` — mock `query` to yield `[{ type: 'text', text: 'Hello' }, { type: 'done' }]` (adjust to match actual SDK event shape after the implementer reads the SDK types). Assert the adapter yields `{ type: 'text', text: 'Hello' }` and `{ type: 'done' }`.

2. `streamChat calls query with allowedTools: []` — assert `query` was called with an argument containing `allowedTools: []`.

3. `streamChat does not set ANTHROPIC_API_KEY when authMode is subscription` — set `process.env.ANTHROPIC_API_KEY = 'should-be-deleted'` before constructing the adapter. After construction, assert `process.env.ANTHROPIC_API_KEY` is undefined.

4. `callWithTools throws not-implemented error` — call `callWithTools([], [], {})` on the adapter. Use `for await ... of` and assert it throws (or catches) with a message containing `'not implemented'`.

5. `constructor throws if authMode is api-key and apiKey is missing` — assert `new ClaudeAdapter({ authMode: 'api-key' })` throws.

**CI note — record in the test file as a comment:**

```ts
// NOTE: Tests in this file use a mocked SDK. No real Anthropic API calls are made.
// Real subscription authentication is manually verified by running the server locally
// with ANTHROPIC_API_KEY unset and an active Claude Code subscription.
// Do not add tests that make real network calls — they will fail in CI.
```

---

### `server/test/chat/context.test.ts`

**File path:** `server/test/chat/context.test.ts`

**Purpose:** Verifies that `buildItemChatContext` assembles the correct system prompt from a real in-memory database.

**Dependencies:**
- `vitest` — `describe`, `it`, `expect`, `beforeEach`
- `better-sqlite3`
- Schema, seed, and all services
- `../../src/gateway/context` — `buildItemChatContext`

**Setup:** Each test opens a fresh `:memory:` database, applies schema and seed, creates a project, at least one column, and items with various relationships.

**Required test cases:**

1. `includes item title, type, and column name` — create a task in the "In Progress" column. Assert the output contains the task's title and `'In Progress'`.

2. `includes parent item when parent_id is set` — create an epic, then a story under it. Call `buildItemChatContext` for the story. Assert the output contains the epic's title under a `PARENT ITEM` section.

3. `omits parent section when item has no parent` — call `buildItemChatContext` for a top-level epic. Assert the string does not contain `'PARENT ITEM'`.

4. `includes children up to 10` — create 12 tasks under a story. Assert the `CHILD ITEMS` section lists 10 items (not 12).

5. `includes last 10 comments` — add 12 comments to an item. Assert the context includes 10 comments, and they are the 12th, 11th, ... 3rd comments (the most recent 10).

6. `includes last 20 activity entries in chronological order` — append 25 activity entries to an item. Assert the context includes 20 entries and the first listed is older than the last listed.

7. `omits children section when item has no children` — call `buildItemChatContext` for a leaf task. Assert the string does not contain `'CHILD ITEMS'`.

8. `includes flagged and blocked status` — create a blocked item with reason `"Waiting for API"`. Assert the output contains `'Blocked: Yes'` and `'Waiting for API'`.

---

### `server/test/chat/conversations.test.ts`

**File path:** `server/test/chat/conversations.test.ts`

**Purpose:** Verifies `ConversationService` persistence behaviour against an in-memory database.

**Dependencies:**
- `vitest` — `describe`, `it`, `expect`, `beforeEach`
- `better-sqlite3`
- Schema, seed, and `ProjectService`, `ItemService`, `ColumnService`
- `../../src/services/conversations` — `ConversationService`

**Setup:** Each test opens a fresh `:memory:` database, applies schema and seed, creates a project and an item via the service layer.

**Required test cases:**

1. `getOrCreateItemConversation creates a new conversation when none exists` — assert the returned conversation has `type === 'item'` and `item_id === itemId`.

2. `getOrCreateItemConversation returns the same conversation on repeated calls` — call it twice with the same arguments. Assert both calls return the same `id`.

3. `getOrCreatePlanningConversation creates a planning conversation with null item_id` — assert `type === 'planning'` and `item_id === null`.

4. `appendMessage persists a user message` — append a user message. Call `getMessages`. Assert the array contains one entry with `role === 'user'` and the correct `content`.

5. `appendMessage persists tool_calls as JSON` — append an assistant message with `tool_calls: [{ id: 'c1', name: 'test', arguments: '{}' }]`. Call `getMessages`. Assert `messages[0].tool_calls[0].id === 'c1'`.

6. `getMessages returns messages in created_at ASC order` — append three messages. Assert they are returned in insertion order.

7. `clearMessages removes all messages but not the conversation` — append two messages, call `clearMessages`, call `getMessages`. Assert `messages` is empty. Call `getConversation` and assert the conversation still exists.

8. `two items in the same project each get their own conversation` — create two items, call `getOrCreateItemConversation` for each. Assert the returned `id` values differ.

---

## Acceptance criteria checklist

The following behaviours must be verifiable after running `pnpm dev`:

### Settings

1. `GET /api/settings` returns `200` with `{ providers: [], activeProvider: null }` on a fresh database.
2. `PUT /api/settings` with a valid Claude subscription provider sets the active provider. A subsequent `GET /api/settings` returns the provider with `apiKey` absent (subscription has no key).
3. `PUT /api/settings` with an OpenAI-compatible provider including an `apiKey` stores it. `GET /api/settings` returns the `apiKey` masked (not the full key).
4. `PUT /api/settings` with `activeProvider` referencing a non-existent provider name returns `400`.
5. `PUT /api/settings` with an OpenAI-compatible provider missing `apiKey` returns `400`.
6. Settings page renders in the UI when the gear icon is clicked.
7. Adding a provider and saving updates the `GET /api/settings` response.
8. The API key field on the settings page shows the masked value after save, not the raw key.

### Conversations and messages

9. `POST /api/conversations` with `{ projectId }` (no `itemId`) creates a `type: 'planning'` conversation.
10. `POST /api/conversations` with `{ projectId, itemId }` creates a `type: 'item'` conversation.
11. Calling `POST /api/conversations` with the same `itemId` a second time returns the same conversation `id`.
12. `GET /api/conversations/:id` returns the conversation with an empty `messages` array on a fresh conversation.
13. `GET /api/conversations/:nonexistent` returns `404`.
14. `POST /api/conversations/:id/messages` with no provider configured returns `500` with a human-readable error message (before any streaming starts).

### Item chat streaming

15. With a provider configured, `POST /api/conversations/:id/messages` with `{ content: "Hello" }` responds with `Content-Type: text/event-stream` and streams `text` events followed by a `done` event.
16. After a successful chat turn, `GET /api/conversations/:id` returns the user message and the assistant message both persisted.
17. The item detail panel in the UI shows a "Chat" tab alongside the existing tabs.
18. Typing a message and clicking "Send" streams the response token by token.
19. The "Send" button is disabled while streaming.
20. The provider badge in the chat panel shows the active provider name and model.

### Context assembly

21. For an item that has a parent, the assistant's first response demonstrates awareness of the parent (a manual check: the LLM's system prompt includes parent context, so asking "what is this item's parent?" should yield the parent's name).
22. For an item with comments, the system prompt includes those comments (verifiable by inspecting the request payload in network tools or server logs).

### Automated tests

23. `pnpm --filter server test` exits with code 0.
24. `openai.test.ts` — all 8 tests pass.
25. `claude.test.ts` — all 5 tests pass.
26. `context.test.ts` — all 8 tests pass.
27. `conversations.test.ts` — all 8 tests pass.

---

## Phase 5 contracts delivered by this spec

Phase 5 requires the following from Phase 4, explicitly:

- `conversations` table with `type IN ('item', 'planning')` — delivered by schema.ts additions.
- `messages` table with `tool_calls` JSON column — delivered by schema.ts additions.
- `ConversationService` with `getOrCreatePlanningConversation(projectId)`, `appendMessage(conversationId, data)`, `getMessages(conversationId)`, `clearMessages(conversationId)` — delivered by `server/src/services/conversations.ts`.
- A gateway accessor returning the configured `ChatAdapter` — delivered by `server/src/gateway/index.ts`'s `getAdapter(settings)` function. Phase 5 should call this as `getAdapter(settingsService)`.
- `ChatAdapter` interface with `streamChat` and `callWithTools` matching the exact signatures in `server/src/gateway/types.ts` — delivered. Phase 5 fills in the `callWithTools` implementations; the interface shape is locked.
- `ToolDefinition` and `ToolCallRequest` types in `server/src/gateway/types.ts` — delivered.
- `GatewayChunk` discriminated union with `text`, `tool_call`, `done`, `error` variants — delivered. Note: Phase 5's spec uses `{ type: 'text', content: string }` but this spec defines `{ type: 'text', text: string }` (matching `text` not `content`). **Decision: use `text` as the field name throughout, consistent with this spec.** Phase 5's implementer must use `chunk.text` not `chunk.content` when reading text chunks.
- `EventBus` instance accessible to planning route handlers — Phase 5's `createPlanningToolHandler` needs the bus. The Phase 3 `eventBus` singleton is already exported from `server/src/events/bus.ts`. Phase 5 imports it directly.
- Migration runner infrastructure — delivered by `server/src/db/migrationRunner.ts`. Phase 5's `004_planning_actor.ts` migration drops in alongside Phase 4's `001_initial_conversations.ts`.

---

## Decisions made in this spec

1. **`GatewayChunk.text` field named `text` not `content`.** Phase 5's spec draft used `content`, but using `text` is more consistent with "text chunk" and avoids confusion with `ChatMessage.content`. Phase 5 implementers must use `chunk.text`.

2. **`callWithTools` on Claude adapter throws in Phase 4.** Phase 5 requires it but Phase 5's own spec says it adds the implementation. The stub ensures the interface compiles and the route can be wired before Phase 5 without crashing items-chat (which uses `streamChat` only).

3. **Settings stored in SQLite, not a JSON file.** Single backup file, no file parsing edge cases, consistent with the rest of the data model.

4. **API key blank-field preservation on edit.** When editing a provider, a blank `apiKey` field means "keep the stored key", not "clear the key". The server copies the existing stored key when the incoming provider record lacks `apiKey`. This is safer than accidentally blanking a key.

5. **`getAdapter` is called per-request.** Settings changes are reflected immediately without a restart.

6. **Context limits: 10 comments, 10 children, 20 activity entries.** Conservative limits that keep the system prompt under ~2000 tokens for typical items. These limits are hard-coded in `buildItemChatContext`; they are not configurable in Phase 4.

7. **Chat stream format: `data: <JSON>\n\n` per line (SSE format).** Consistent with Phase 3's SSE stream and Phase 5's `usePlanningChat.ts` hook which uses the same parsing approach.

8. **`Services` interface extended in Phase 4 to include `conversations` and `settings`.** Phase 2 defined `Services`; Phase 4 adds two new fields. This is a breaking change to the type — all callers that construct a `Services` object must add the new fields. The only such caller is `server/src/index.ts`.

9. **`ToolCallRequest` re-exported from `server/src/types.ts`.** So that `Message.tool_calls` has a typed element shape without requiring consumers to import from the gateway module directly.

10. **UI settings are a modal overlay, not a separate route.** Keeping all navigation state in React component state (not the URL) is consistent with Phase 1's decision to use a single piece of state for the selected project.
