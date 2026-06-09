# Phase 5 Implementation Notes

## Ambiguity calls and deviations

### 1. `runToolLoop` — text accumulation into assistant message

The spec says the loop should build an assistant message with `tool_calls` after a tool-call turn, but does not specify whether streamed text tokens in the same turn (before tool calls) should be accumulated into the assistant message's `content`. The spec says to set `content: ''`. The implementation uses empty string, and the text is only delivered to `textSink`. This matches the spec literally.

### 2. `runToolLoop` — maxTurns safety valve timing

The spec says "if `maxTurns` is exhausted without the LLM finishing, stop the loop and append a final `{ role: 'assistant', content: '[Planning loop reached maximum turns]' }` to history." The implementation checks after the loop whether the last message is a tool result (meaning we consumed all turns without the LLM ever finishing without tool calls), and appends the safety message in that case.

### 3. Planning route — SSE vs plain newline-delimited JSON

The spec (section 15, `usePlanningChat`) says "each server-side event is written as a JSON line terminated with `\n`" and confirms this is newline-delimited JSON, not SSE format. The `streamText` Hono helper is used on the server per spec section 8. The route writes `JSON.stringify(event) + '\n'` directly (no `data: ` prefix), and the client hook splits on `\n` and parses each line as JSON. This matches the spec's stated wire format.

### 4. Migration 002 — `BEGIN`/`COMMIT` in `db.exec`

SQLite's `db.exec` can run multiple statements including `BEGIN`/`COMMIT`. The migration wraps all steps in an explicit transaction via SQL `BEGIN`/`COMMIT` inside `db.exec`, since the migration runner itself wraps the call in a `db.transaction()`. This is safe — SQLite allows nested transactions via savepoints, and the outer transaction ensures atomicity.

### 5. `ClaudeAdapter.callWithTools` — beta header

The spec says to use `anthropic-beta: oauth-2023-05-03` for the subscription auth mode. This is used as specified without additional verification, since the spec acknowledges the value "may change" but gives a concrete value to use.

### 6. `buildToolCallLabel` — `args` is raw JSON from the chunk

The spec says `call.args` is the raw JSON string from the flat `GatewayChunk` tool_call. The label builder JSON-parses it. If parsing fails, falls back to a generic label. This is safe and matches spec intent.

### 7. Orphan detection in `generateExport`

The spec says to generate `orphans.md` for "stories or tasks with no matching parent in the fetched items." The implementation treats an item as orphaned if `parent_id` is null (for stories/tasks) OR if `parent_id` is set but the referenced item is not in the fetched items for this project. Epics with `parent_id === null` are not orphans — they are top-level by design.

### 8. UI types — `ChatMessage` added to `ui/src/types.ts`

The spec references `ChatMessage` in the UI hook's import but the delivered `ui/src/types.ts` only had `Message` (the persisted form). A `ChatMessage` interface matching the gateway contract was added to `ui/src/types.ts`. This is additive and does not break existing code.

### 9. `PlanningStreamEvent` — `tool_result` not emitted by server in all paths

The route handler wraps the `toolHandler` call to emit `tool_result` events before returning the result string to the loop. This is done inside the route (not inside `runToolLoop`) because `runToolLoop` is stream-agnostic and the spec says `toolCallSink` is only for `tool_call` chunks (not results).

### 10. No conflict found between phase-5.md and delivered Phase 4 code

The `gateway/types.ts`, `gateway/index.ts`, `services/conversations.ts` all match the Phase 5 spec's documented contract exactly. No authoritative-code deviations needed.
