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

---

## Dynamic model selection (added in Phase 5 follow-up)

### Step 0 — SDK investigation

The `@anthropic-ai/claude-agent-sdk` package does not export any model-listing function or `supportedModels` constant. The `ModelInfo` type appears in `sdk.d.ts` (fields: `value`, `displayName`, `description`, `supportsEffort`, etc.) but is only a type definition — there is no runtime API to retrieve available models from the SDK.

The correct path for `claude-subscription` is Anthropic's REST `GET https://api.anthropic.com/v1/models`:
- With `CLAUDE_CODE_OAUTH_TOKEN` set: `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`
- With `ANTHROPIC_API_KEY` set: `x-api-key: <key>` (no beta header needed)
- With neither: return the static fallback list immediately without any network call

### Implementation

**Server — `src/services/modelsService.ts`**

Contains all fetch logic with a 5s timeout, 10-minute in-memory cache keyed by `type|baseUrl`, and `clearModelsCache()` exported for tests. Redaction of API keys in log fields is handled by the existing `redact` helper in the logger (the logger's `REDACT_KEYS` set includes `apikey` and `authorization`). Logs under scope `models`.

**Server — `src/routes/models.ts`**

`POST /api/models` accepts `{ type, baseUrl?, apiKey?, providerName? }`. When `apiKey` is omitted and `providerName` matches a saved provider, the service reads the stored key from `SettingsService.getGatewaySettings()`.

**UI — `src/components/SettingsPage.tsx`**

Model field is now `<input type="text" list={datalistId}>` backed by a `<datalist>`. Free text is always allowed. A per-provider `ModelFetchState` tracks `{ models, source, loading, error }`. Models are fetched on edit open, on type change, and on baseUrl change (600ms debounce for baseUrl). The hint line reads: "N models loaded from provider" / "Couldn't fetch models — type the model id" (openai-compatible failure) / "Showing defaults" (claude fallback).

**UI — `src/api/settings.ts`**

Added `fetchModels(req: FetchModelsRequest): Promise<ModelsResponse>` alongside existing `getSettings`/`updateSettings`.

### Deviations from spec

None. The spec allowed `source: 'fallback'` for both claude-subscription and openai-compatible failure cases. The hint wording "couldn't fetch models — type the model id" is used only for openai-compatible with an error; claude fallback shows "Showing defaults" as specified.

---

## Incremental streaming + PlanChat auto-scroll (2026-06-11)

### Step 0 — SDK investigation findings

`includePartialMessages` is a real `Options` field (confirmed in `sdk.d.ts` line 1596). When `true`, the SDK emits `SDKPartialAssistantMessage` messages with `type: 'stream_event'`. That message carries a `BetaRawMessageStreamEvent` in its `event` field and a per-message `uuid`. The event type of interest is `content_block_delta` with `delta.type === 'text_delta'` and `delta.text: string`. The full assistant message (`type: 'assistant'`) still arrives afterwards with the same `uuid`.

### Fix 1 — Incremental text streaming (server/src/gateway/adapters/claude.ts)

Both `streamChat` and `callWithTools` now set `includePartialMessages: true` in the query options. The message loop handles `type === 'stream_event'` first: if the event is a `content_block_delta / text_delta`, the delta text is yielded immediately and the message uuid is added to a `deltaSeenForUuid` Set. When the complete `assistant` message arrives, it is checked against that Set — if the uuid is present (deltas were seen), the whole-message text blocks are skipped to avoid doubling. The uuid is cleared from the Set after checking. If no deltas arrived for a uuid (old CLI version, or non-text turns) the whole-message text is emitted as before — backwards-compatible fallback. Tool call chunk behavior is unchanged.

### Fix 2 — PlanChat auto-scroll (ui/src/components/PlanChat.tsx)

The original `useEffect` keyed only on `[messages, streamingContent]` with no near-bottom guard. The fix:
- Adds a `scrollRef` `onScroll` handler that updates `isNearBottomRef` (near if within 80px of bottom).
- Replaces the effect dependency array with `[messages.length, streamingContent, toolCallIndicators.length, isStreaming]` so tool indicator appends and streaming-state transitions also trigger it.
- Adds a `wasStreamingRef` to detect when a new response starts (`isStreaming` flips from false to true) and snaps unconditionally to the bottom at that moment, resetting the near-bottom flag — so the user always sees the start of a new response even if they scrolled up mid-prior-run.
- Otherwise only scrolls when `isNearBottomRef.current` is true, so manual scroll-up during a long run is not fought.

The same near-bottom guard (identical pattern) was applied to `ChatPanel.tsx` as specified.

### Tests

5 new tests added to `server/test/gateway/claude.test.ts`:
- `streamChat`: incremental deltas yield in order; whole-message text suppressed when deltas arrived; `includePartialMessages: true` is passed.
- `callWithTools`: incremental deltas yield; whole-message fallback when no deltas; `includePartialMessages: true` confirmed.

The pre-existing `logger.test.ts` suite has 3 failing tests that are unrelated to these changes (NDJSON file-write / level-filter tests that fail due to ESM module-cache ordering of LOG_DIR). All 24 claude adapter tests pass. Server `tsc --noEmit` and UI `tsc --noEmit` + `vite build` are all clean.

### Deviations

None from stated spec. The `uuid` field on `SDKPartialAssistantMessage` is typed as `UUID` (from `crypto`) and is also present on `SDKAssistantMessage` — the deduplication key uses it directly cast via the inline type assertion pattern already used in the file for other untyped SDK fields.
