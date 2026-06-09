# Phase 2 Implementation Notes

## Deviations from spec

### `WebStandardStreamableHTTPServerTransport` used instead of `StreamableHTTPServerTransport`

The spec names `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js` as the transport. That class wraps `WebStandardStreamableHTTPServerTransport` for Node.js HTTP compatibility (it takes `IncomingMessage` and `ServerResponse`).

Hono operates on Web-standard `Request`/`Response` objects, so `WebStandardStreamableHTTPServerTransport` (from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`) integrates cleanly: its `handleRequest` takes a Web-standard `Request` and returns a `Response`. Using the Node.js wrapper would have required extracting the raw `IncomingMessage`/`ServerResponse` from the Hono context via `c.env.incoming`/`c.env.outgoing` (`HttpBindings`), which is error-prone and unnecessary. Both are backed by the same underlying implementation; stateless behaviour is identical.

### Stateless mode: new `McpServer` instance per request

The spec says `createMcpHandler` calls `createMcpServer(services)` once and holds the instance in closure. In practice, `McpServer.connect()` throws "Already connected to a transport" if called on an instance that already has a transport attached — even after the previous request completes — because the SDK does not automatically detach closed transports from the server. Creating a new `McpServer` per request is the correct stateless pattern; all state lives in the `services` bundle (backed by the in-memory/file DB), not in the server object.

### `Services` interface imports in `types.ts`

The spec says to add `Services` to `server/src/types.ts`. The interface references the five service classes, which required adding import statements to `types.ts`. This creates forward references but avoids introducing a separate `services/index.ts` barrel module. The imports are type-only so there is no runtime circular dependency.

### `zod` version: v4 installed

`pnpm add zod` resolved to zod v4 (the latest stable release). The MCP SDK v1 ships a `zod-compat` layer and accepts both zod v3 and v4 shapes transparently. All tool schemas use zod v4 and work without issue.

### `vitest.config.ts` updated to include `test/**`

The existing config only included `src/__tests__/**/*.test.ts`. Added `test/**/*.test.ts` to pick up the new `test/mcp/` files. The `test/` directory is excluded from the `tsc` build (which has `rootDir: src`) so there are no build errors from the test files.
