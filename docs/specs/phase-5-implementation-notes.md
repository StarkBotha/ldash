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

### 12. Bug fixes — assistant text persistence and double tool execution (2026-06-10)

**Bug 1 — assistant text never persisted (internal path).** `runToolLoop` forwarded text chunks to `textSink` but never wrote an assistant message to the returned history on the internal-execution path. The planning route persists only messages from the returned history slice, so a conversational reply with no tool calls persisted nothing and vanished on reload. Fix: on `done` (and before each `tool_call` chunk to preserve ordering), any accumulated text buffer is flushed to history as `{role:'assistant', content: buffer}`.

**Bug 1 — multi-round path same issue.** When the turn ends without tool calls (natural finish), the accumulated `turnText` was never pushed to history. Fix: on exit from a turn with no pending calls, push `{role:'assistant', content: turnText}` if non-empty before breaking.

**Bug 2 — double tool execution on internal path.** `executeTool` (passed to `callWithTools`) called `toolHandler` once (execution #1), and the chunk consumer on receiving a `tool_call` chunk also called `toolHandler` directly (execution #2). The real `ClaudeAdapter` calls `opts.executeTool` from inside the MCP tool handler callback, which meant every planning tool ran twice — duplicate board items. Fix: the chunk consumer no longer executes tools. It pushes the assistant `tool_calls` history entry and calls `toolCallSink` only. Tool execution and the corresponding `role:'tool'` history entry are handled entirely inside `executeTool`, which is only invoked by the adapter's MCP handler.

**Multi-round content field.** Previously the assistant `tool_calls` message had `content: ''` even when the LLM emitted text before calling tools. Fix: `turnText` is now set as the `content` field of that message.

**Tests added (gateway/loop.test.ts, +7 tests):** internal adapter that calls `opts.executeTool`, asserting exactly-once execution; double-execution prevention assertion; text-before-tool flush ordering; multi-round text-on-tool-calls message; multi-round final reply persistence.

**Tests added (gateway/claude.test.ts, +1 test):** mock SDK query that invokes the tool handler mid-stream (closing the gap that hid Bug 2 — prior mocks only called the handler manually after the loop).

**Tests updated (planning/loop.test.ts):** text-only test now asserts an assistant message IS in history (was previously asserting the opposite, which was the bug).

**UI (PlanChat.tsx, ChatPanel.tsx):** history is filtered before rendering to show only user messages and assistant messages with non-empty content, so role:'tool' entries and empty tool_call shells are skipped on reload.

### 11. ClaudeAdapter.callWithTools — refactored to Agent SDK (2026-06-10)

The original `callWithTools` posted directly to `https://api.anthropic.com/v1/messages` with a Bearer OAuth token. This bypassed the sanctioned Claude-subscription path and was auth-unverified. It was replaced so all claude-subscription traffic goes through `@anthropic-ai/claude-agent-sdk`.

Design: `CallOptions` gained `executeTool?: (name, argsJson) => Promise<string>`. `ChatAdapter` gained a readonly `executesToolsInternally?: boolean` capability flag. `ClaudeAdapter` sets `executesToolsInternally = true` and rewrites `callWithTools` to build an in-process MCP server (`createSdkMcpServer` + `tool()`) whose handlers wrap each incoming `ToolDefinition`, then calls `query()` with `mcpServers` and `allowedTools` restricted to those tools only. A small `jsonSchemaToZod` helper converts the flat JSON Schema subset (string/number/boolean/enum, required[]) used by planning tools to Zod. `runToolLoop` in `loop.ts` detects `executesToolsInternally` and takes a single-call path (no multi-round management), forwarding chunks to sinks and appending tool messages to history. The existing multi-round path for the OpenAI adapter is unchanged.
