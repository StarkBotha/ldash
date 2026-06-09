# Phase 4 Implementation Notes

## Ambiguities and decisions

### 1. `@anthropic-ai/claude-agent-sdk` query API

The spec says: "Note for implementer: The exact event shape from `@anthropic-ai/claude-agent-sdk`'s `query()` async iterable is not fully documented at spec time."

After reading the SDK's type definitions (`sdk.d.ts`), the `query()` function returns a `Query` (extends `AsyncGenerator<SDKMessage>`). The relevant message types are:

- `SDKAssistantMessage` (type: `'assistant'`) — has a `message: BetaMessage` field. Text content is in `message.content` as an array of blocks; we iterate blocks and yield `{ type: 'text', text: block.text }` for `block.type === 'text'`.
- `SDKResultSuccess` (type: `'result'`, subtype: `'success'`) — signals end of turn. We yield `{ type: 'done' }` here.
- `SDKResultError` (type: `'result'`, subtype: various error codes) — we yield `{ type: 'error', message }`.

The `query()` function signature is: `query({ prompt: string, options?: Options }): Query`. The `Options` type has `allowedTools?: string[]`, `model?: string`, and `systemPrompt?: string`.

The spec's description of building a "Human: ... \n\nAssistant: ..." prompt format is used. The system prompt is passed via `options.systemPrompt`.

### 2. `vitest.config.ts` already included `test/**/*.test.ts`

The spec says to add `test/**/*.test.ts` to the include pattern. On inspection, the existing vitest config already had both patterns (from Phase 3's MCP tests). No change was needed.

### 3. Test data escaping for tool_call SSE lines

The spec's test data for `callWithTools` used JavaScript string literals with `\\"` to represent JSON-escaped double quotes. This produces invalid JSON when the raw bytes hit the HTTP layer because the escaping isn't right for the JSON-within-JSON case. The implementation uses `JSON.stringify()` to build the SSE test lines, which guarantees valid JSON in the stream.

### 4. Activity test with tied timestamps

The spec's test #6 for `context.test.ts` ("includes last 20 activity entries in chronological order") inserts 25 entries and expects to see entries 6-25 (the most recent 20). SQLite's `ORDER BY created_at DESC LIMIT 20` is not deterministic when all timestamps are identical (which happens in fast in-memory tests). The implementation directly inserts activity rows with distinct timestamps (`2025-01-01T00:00:01.000Z` through `2025-01-01T00:00:25.000Z`) using raw SQL to guarantee ordering. The test then verifies: (a) exactly 20 `seq.event` entries appear, (b) the seq numbers are in ascending order (chronological), (c) the first is seq=6 and the last is seq=25.

### 5. `services.ts` type update breaks MCP test setup

The spec notes "The only such caller [of the Services object constructor] is `server/src/index.ts`." In practice, `server/test/mcp/setup.ts` also constructs a full `Services` object. It was updated to include `conversations` and `settings` fields. The existing `src/__tests__/helpers.ts` returns individual services without using the `Services` type annotation, so it did not need changes.

### 6. SSE streaming import in conversations route

Hono's `streamText` is exported from `hono/streaming`, not `hono` itself. The import was corrected accordingly.

### 7. `ChatPanel` and `SettingsPage` return type

The spec specifies `): JSX.Element` as the return type. The UI project's tsconfig uses `"jsx": "react-jsx"` but does not have a JSX namespace in scope, so `JSX.Element` causes a compile error. The return type annotation was omitted (TypeScript infers it). All other UI components in the codebase use the same pattern (no explicit return type annotation).

### 8. `listFiltered` with `parent_id` parameter

The spec calls `services.items.listFiltered({ project_id: ..., parent_id: itemId })`. The Phase 2 `listFiltered` implementation checks `if (opts.parent_id === 'null')` for null filtering and otherwise uses the string value directly as a parameter. Passing a real item ID string works correctly for fetching children.

### 9. Settings API key preservation on edit

The spec requires that when a PUT body omits `apiKey` for an existing openai-compatible provider, the stored key is preserved. Implemented in `SettingsService.setGatewaySettings` by loading the existing settings and copying `apiKey` from the stored provider when the incoming provider's `apiKey` is absent or empty. The UI's `SettingsPage` sends `apiKey: undefined` (by not setting the field) when the user leaves the API key input blank on an edit.

### 10. Context assembly - `item.parent_id` as `null` vs `undefined`

`listFiltered` with `parent_id: itemId` passes the itemId string as a parameter, which SQLite matches against `parent_id = ?`. SQLite's `parent_id IS NULL` branch in `listFiltered` is only triggered when `opts.parent_id === 'null'` (string). This is correct behavior.
