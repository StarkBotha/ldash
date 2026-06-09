# Phase 3 Implementation Notes

## MCP write emission (extension beyond spec)

The spec states events are emitted from route handlers. However, Phase 2 introduced MCP tool handlers in `server/src/mcp/tools/` that write directly through the service layer without going through the route handlers. These writes would have silently bypassed the event bus, breaking the core product loop of "Claude Code updates a task → board updates live."

To fix this, the `EventBus` instance is threaded through the MCP stack:

- `routes/mcp.ts` accepts `bus: EventBus` and passes it to `createMcpHandler`
- `mcp/handler.ts` accepts `bus: EventBus` and passes it to `createMcpServer`
- `mcp/server.ts` accepts `bus: EventBus` and passes it to `registerItemTools`, `registerCommentTools`, and `registerFlagTools`
- Each of those tool registration functions accepts `bus: EventBus` and calls `bus.emit(...)` after successful writes

All functions use `bus: EventBus = defaultBus` (default parameter) so existing callers that don't pass a bus still work correctly. The `registerProjectTools` function does not need updating because it only contains a read-only `ldash_list_projects` tool.

## Query key alignment

The spec assumed `['project', entityId]` as the single-project query key, but the actual Phase 1 hook `useProject` uses `['projects', id]` (pluralised, same array as the list key with the id appended). The `invalidateForEvent` function in `useSSE.ts` is aligned to the actual keys: `['projects']` and `['projects', entityId]`.

## Reconnect tracking

The spec calls for `invalidateAll` on reconnect. Because `EventSource.onopen` fires on the initial connection as well as on reconnect, a `isFirstOpen` ref is used to skip the invalidateAll on the very first connection establishment. Only subsequent `onopen` firings (reconnects) trigger the full refetch.

## SSE streaming implementation

Hono's `streamText` helper was used as specified. The `stream.onAbort` callback is used to detect client disconnect and trigger cleanup (unsubscribe from bus, clear heartbeat interval) in the `finally` block of the async handler.

## `heartbeatIntervalMs` injection for tests

The `createSseRouter` function accepts an optional `{ heartbeatIntervalMs?: number }` options parameter (default `30_000`). Tests pass `{ heartbeatIntervalMs: 100 }` to avoid waiting 30 seconds.

## Test strategy for SSE

The spec called for using `@hono/node-server` with a real HTTP server on port 0. This was implemented as specified. The `connectSSE` helper function uses Node's `http.get` to open a raw HTTP connection and accumulates SSE frames. The heartbeat test works by using the 100ms interval configured in beforeEach.

The spec mentions using `vi.useFakeTimers()` as an alternative for the heartbeat test, but the configurable interval approach is simpler and was chosen instead since the spec listed it as a first-class option.

## `@dnd-kit/utilities` package

The spec listed only `@dnd-kit/core` and `@dnd-kit/sortable` as required packages. However, `@dnd-kit/utilities` is needed for `CSS.Transform.toString()` used in Card.tsx per the spec's DnD instructions. This package was added to the ui package.json.
