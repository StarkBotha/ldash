# ldash — Phase 2 Implementation Spec: MCP Server

## Decisions made in this spec

**Flags are already in the schema.** The Phase 1 schema includes `flagged` (INTEGER 0/1) and `blocked` (INTEGER 0/1, with `blocked_reason`) on the `items` table. No migration is needed. The MCP tool `ldash_flag_item` maps directly to `ItemService.setFlag` and `ldash_block_item` maps to `ItemService.setBlock`. There is no separate "flag" concept distinct from "block" — they are exposed as two separate MCP tools matching the two separate Phase 1 endpoints.

**MCP transport: single Hono route, `StreamableHTTPServerTransport` per request.** The `@modelcontextprotocol/sdk` ships a `StreamableHTTPServerTransport` that handles both POST (tool calls) and GET (SSE upgrade for server-initiated messages). Each incoming HTTP request from a Claude Code client gets its own transport instance wired to a shared `McpServer` instance. This is the standard stateless-per-request pattern in the SDK and naturally handles multiple concurrent clients without any session store.

**MCP mount path: `/mcp`.** Short, unambiguous, does not conflict with `/api/*` or the future SSE path (`/events` reserved for Phase 3). The Hono app mounts a route at `POST /mcp` and `GET /mcp` — both forwarded to the transport handler.

**Actor identity for MCP writes.** Every write tool passes `actor_type: 'claude'` and `actor_id: 'claude-code'` to `ActivityService.append`. This is consistent with the `actor_type` constraint in the Phase 1 schema (`CHECK (actor_type IN ('user', 'claude'))`). If the client sends an `X-Actor-Id` header, that value is used as `actor_id`; otherwise `'claude-code'` is the default. This allows a user to distinguish multiple Claude Code sessions if desired, without requiring it.

**`listItems` filtering is done in the service layer, not in SQL fragmentation.** `ItemService.listByProject` returns all items; a dedicated `ItemService.listFiltered` method accepts optional filter parameters and constructs a parameterised SQL query. This is cleaner than building dynamic SQL in the tool handler.

**No new tables.** Phase 2 adds no schema changes. All MCP writes use the existing service layer methods defined in Phase 1.

**`@modelcontextprotocol/sdk` version pinned to `^1.x`.** This is the first stable major version of the TypeScript SDK and the one that ships `StreamableHTTPServerTransport`. Do not use `^0.x` (pre-release) or any beta channel.

**Tests use an in-process HTTP transport.** Vitest tests spin up the Hono app on a random port with a fresh in-memory (`:memory:`) SQLite database, then connect an `@modelcontextprotocol/sdk` `Client` over HTTP to the `/mcp` endpoint. This tests the full stack — transport, tool routing, service layer, and database — in one process with no external dependencies.

**Column resolution in `ldash_update_item_status`.** The tool accepts either a column name or a column id as the `column_id` argument. If the value does not match any column id directly, the tool looks it up by exact case-insensitive name match. This makes the tool more usable by an LLM that may only know column names. If neither match is found, the tool returns a structured error.

**`ldash_get_item` returns comments and activity inline.** The architecture doc calls for "get one item with comments+activity" as a single operation. Rather than making the LLM call three tools, `ldash_get_item` assembles all three and returns them as a single JSON object. Activity is limited to the 20 most recent entries to keep the response size bounded.

---

## Schema migration

None required. All fields used by Phase 2 (`flagged`, `blocked`, `blocked_reason`, `actor_type`, `actor_id`) exist in the Phase 1 schema.

---

## Package changes (`server/package.json`)

Add to `dependencies`:

```json
"@modelcontextprotocol/sdk": "^1.x"
```

Add to `devDependencies` (tests):

```json
"vitest": "^2.x"
```

Add to `scripts`:

```json
"test": "vitest run"
```

---

## Project layout additions

The following files are added to the existing `server/src/` tree. Nothing in the existing tree is deleted or renamed.

```
server/
  src/
    mcp/
      server.ts        # Creates and configures the McpServer instance with all tools
      tools/
        projects.ts    # ldash_list_projects tool definition
        items.ts       # ldash_list_items, ldash_get_item, ldash_create_item, ldash_update_item_fields, ldash_update_item_status tools
        comments.ts    # ldash_add_comment tool
        flags.ts       # ldash_flag_item, ldash_block_item tools
      handler.ts       # Hono route handler that wires StreamableHTTPServerTransport to the McpServer
    routes/
      mcp.ts           # Hono router that mounts GET /mcp and POST /mcp to the handler
  test/
    mcp/
      setup.ts         # Test helper: starts Hono app on random port with :memory: DB, returns base URL and cleanup fn
      projects.test.ts # Tests for ldash_list_projects
      items.test.ts    # Tests for ldash_list_items, ldash_get_item, ldash_create_item, ldash_update_item_fields, ldash_update_item_status
      comments.test.ts # Tests for ldash_add_comment
      flags.test.ts    # Tests for ldash_flag_item, ldash_block_item
```

---

## `server/src/mcp/server.ts`

**File path:** `server/src/mcp/server.ts`

**Purpose:** Constructs and exports a configured `McpServer` instance with all ldash tools registered.

**Dependencies:**
- `@modelcontextprotocol/sdk/server/mcp.js` — `McpServer`
- `zod` — input schema validation (the SDK accepts Zod schemas directly for tool inputs)
- All five tool registration modules from `./tools/`
- `Services` type from `../types.ts` (a bundle type defined in this phase — see Data Contracts)

**Public interface:**

```ts
export function createMcpServer(services: Services): McpServer
```

**Behaviour:**

1. Instantiate `new McpServer({ name: 'ldash', version: '1.0.0' })`.
2. Call each of the five tool-registration functions, passing both the server instance and the `services` bundle: `registerProjectTools(server, services)`, `registerItemTools(server, services)`, `registerCommentTools(server, services)`, `registerFlagTools(server, services)`.
3. Return the configured server instance.

**Data contracts:**

```ts
// Defined in server/src/types.ts — add to existing types file
export interface Services {
  projects: ProjectService;
  items: ItemService;
  columns: ColumnService;
  comments: CommentService;
  activity: ActivityService;
}
```

**Do NOT implement:** The individual tool handlers — those live in `./tools/` modules.

---

## `server/src/mcp/handler.ts`

**File path:** `server/src/mcp/handler.ts`

**Purpose:** Hono route handler that creates a `StreamableHTTPServerTransport` per request and connects it to the shared `McpServer`.

**Dependencies:**
- `@modelcontextprotocol/sdk/server/streamableHttp.js` — `StreamableHTTPServerTransport`
- `hono` — `Context` type
- `./server.ts` — `createMcpServer`
- `../types.ts` — `Services`

**Public interface:**

```ts
export function createMcpHandler(services: Services): {
  handlePost: (c: Context) => Promise<Response>;
  handleGet: (c: Context) => Promise<Response>;
}
```

**Behaviour:**

`createMcpHandler` is called once at startup (in `index.ts`) and returns two Hono-compatible handler functions. It calls `createMcpServer(services)` once and holds the `McpServer` instance in closure.

`handlePost(c)`:
1. Parse the raw request body as JSON. If parsing fails, return a `400` response with `{ error: 'Invalid JSON' }`.
2. Read the optional `X-Actor-Id` header; store it in a request-scoped variable for use by write tools (see Actor propagation below).
3. Create `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`. Setting `sessionIdGenerator` to `undefined` puts the transport in stateless mode — each POST is self-contained, no session cookie is set.
4. Connect the transport to the McpServer via `await server.connect(transport)`.
5. Call `await transport.handleRequest(c.req.raw, c.res)` — this processes the JSON-RPC request and writes the response.
6. Return `c.res` (the transport writes directly into the Node response).

`handleGet(c)`:
1. Call `await transport.handleRequest(c.req.raw, c.res)` — this handles the SSE upgrade for server-initiated messages (used by the SDK for progress notifications; not required by any tool in Phase 2 but must be present for spec compliance).
2. Return `c.res`.

**Actor propagation:** The `X-Actor-Id` header value must be accessible inside tool handlers. Pass it through a request-scoped context. The simplest approach: attach it to the `AsyncLocalStorage` or pass it as part of the tool call context. Conservative decision: pass it as a string through the `Services` object is not appropriate (Services is stateless). Instead, each write tool handler accepts `actorId` as a parameter; the handler reads it from `c.req.header('X-Actor-Id') ?? 'claude-code'` and passes it to the tool registration functions via a per-request context object. See tool registration section for how this threads through.

Revised approach (simpler, avoids AsyncLocalStorage): The tool handlers always use `actor_id: 'claude-code'` as a fixed string. If the user needs per-session actor ids in the future, that is a Phase 3+ concern. This is the conservative resolution stated in Decisions.

**Do NOT implement:** The MCP tool definitions themselves.

---

## `server/src/routes/mcp.ts`

**File path:** `server/src/routes/mcp.ts`

**Purpose:** Hono router that mounts the MCP handler at `/mcp` for both `POST` and `GET` methods.

**Dependencies:**
- `hono` — `Hono`
- `../mcp/handler.ts` — `createMcpHandler`
- `../types.ts` — `Services`

**Public interface:**

```ts
export function createMcpRouter(services: Services): Hono
```

**Behaviour:**

1. Call `createMcpHandler(services)` to get `{ handlePost, handleGet }`.
2. Create a new `Hono` instance.
3. Register `app.post('/', handlePost)` — handles tool calls.
4. Register `app.get('/', handleGet)` — handles SSE upgrade.
5. Return the router.

The parent app in `index.ts` mounts this router at `/mcp`:
```ts
app.route('/mcp', createMcpRouter(services))
```

---

## `server/src/mcp/tools/projects.ts`

**File path:** `server/src/mcp/tools/projects.ts`

**Purpose:** Registers the `ldash_list_projects` tool on the McpServer.

**Dependencies:**
- `@modelcontextprotocol/sdk/server/mcp.js` — `McpServer`
- `zod`
- `../../types.ts` — `Services`

**Public interface:**

```ts
export function registerProjectTools(server: McpServer, services: Services): void
```

**Behaviour:**

Registers one tool:

### Tool: `ldash_list_projects`

```ts
server.tool(
  'ldash_list_projects',
  'List all projects in the ldash board. Call this first to discover available project IDs before using other tools. Returns id, name, description, and timestamps for each project.',
  {}, // no input parameters
  async () => { ... }
)
```

Handler:
1. Call `services.projects.list()`.
2. Return `{ content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] }`.
3. No activity is written — this is a read.

Return shape (JSON text):
```json
[
  {
    "id": "string",
    "name": "string",
    "description": "string",
    "created_at": "ISO string",
    "updated_at": "ISO string"
  }
]
```

---

## `server/src/mcp/tools/items.ts`

**File path:** `server/src/mcp/tools/items.ts`

**Purpose:** Registers the five item-related tools: `ldash_list_items`, `ldash_get_item`, `ldash_create_item`, `ldash_update_item_fields`, `ldash_update_item_status`.

**Dependencies:**
- `@modelcontextprotocol/sdk/server/mcp.js` — `McpServer`
- `zod`
- `../../types.ts` — `Services`

**Public interface:**

```ts
export function registerItemTools(server: McpServer, services: Services): void
```

**Behaviour:**

Registers five tools:

---

### Tool: `ldash_list_items`

```ts
server.tool(
  'ldash_list_items',
  'List items (epics, stories, tasks) on the board. Use this to find what work is planned and what its current status is. Filter by project_id (required), and optionally by status column name or id, item type, or parent item id. Returns id, title, type, column_id, flagged, blocked, and parent_id for each item.',
  {
    project_id: z.string().describe('The id of the project to list items from. Required.'),
    column_id: z.string().optional().describe('Filter to items in this column. Accepts either a column id or a column name (case-insensitive). Optional.'),
    type: z.enum(['epic', 'story', 'task']).optional().describe('Filter to items of this type. Optional.'),
    parent_id: z.string().optional().describe('Filter to items whose parent_id matches this value. Pass "null" as a string to get top-level items with no parent. Optional.'),
  },
  async (input) => { ... }
)
```

Handler:
1. Verify the project exists via `services.projects.get(input.project_id)`. If not found, return `{ content: [{ type: 'text', text: 'Error: project not found' }], isError: true }`.
2. Call `services.items.listFiltered({ project_id: input.project_id, column_id?: string, type?: ItemType, parent_id?: string | null })`. See `ItemService.listFiltered` below.
3. If `column_id` is supplied and looks like a name (no match in columns list), resolve it: call `services.columns.list()` and find a case-insensitive name match. If still no match, return `{ content: [{ type: 'text', text: 'Error: column not found' }], isError: true }`.
4. Return `{ content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] }`.

---

### Tool: `ldash_get_item`

```ts
server.tool(
  'ldash_get_item',
  'Get full details of a single item including its description, current status, flag and block state, all comments, and the 20 most recent activity entries. Use this before working on a task so you understand its current state and any prior discussion.',
  {
    item_id: z.string().describe('The id of the item to retrieve.'),
  },
  async (input) => { ... }
)
```

Handler:
1. Call `services.items.get(input.item_id)`. If undefined, return error response with `isError: true` and message `'Error: item not found'`.
2. Call `services.comments.listByItem(input.item_id)`.
3. Call `services.activity.listByItem(input.item_id, { limit: 20 })`.
4. Assemble response object:
```ts
{
  item: Item,
  comments: Comment[],
  recent_activity: ActivityEntry[]
}
```
5. Return `{ content: [{ type: 'text', text: JSON.stringify(assembled, null, 2) }] }`.

No activity is written — this is a read.

---

### Tool: `ldash_create_item`

```ts
server.tool(
  'ldash_create_item',
  'Create a new item (epic, story, or task) on the board. Use this to file follow-up work discovered while completing a task — for example, a bug found while implementing a feature, or a refactor that should happen later. The item is created in the specified column (defaults to the first column if omitted).',
  {
    project_id: z.string().describe('The id of the project this item belongs to.'),
    type: z.enum(['epic', 'story', 'task']).describe('The item type. Use "task" for concrete work items, "story" for grouped work, "epic" for large themes.'),
    title: z.string().min(1).describe('Short title for the item. Required and must not be empty.'),
    description: z.string().optional().describe('Longer description of the work. Markdown is accepted. Optional.'),
    column_id: z.string().optional().describe('The id or name of the column to place the item in. Defaults to the first column (Backlog) if omitted.'),
    parent_id: z.string().optional().describe('The id of a parent item. Optional. Use to nest a task under a story, or a story under an epic.'),
  },
  async (input) => { ... }
)
```

Handler:
1. Verify `services.projects.get(input.project_id)` exists. If not, return error response.
2. Resolve `column_id`: if `input.column_id` is omitted, fetch all columns via `services.columns.list()` and use `columns[0].id` (the column with lowest position). If provided, attempt direct id lookup first, then name match. If no match, return error response.
3. If `input.parent_id` is provided, verify `services.items.get(input.parent_id)` exists and belongs to the same project. If not, return error response with `'Error: parent item not found or belongs to a different project'`.
4. Call `services.items.create({ project_id, parent_id, type, title, description, column_id })`.
5. Call `services.activity.append({ item_id: item.id, project_id: input.project_id, actor_type: 'claude', actor_id: 'claude-code', event_type: 'item.created', payload: { title: item.title, type: item.type, column_id: item.column_id } })`.
6. Return `{ content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] }`.

---

### Tool: `ldash_update_item_fields`

```ts
server.tool(
  'ldash_update_item_fields',
  'Update the title and/or description of an item. Use this to correct a title, add detail to a description, or clarify scope after investigation. Does not change status — use ldash_update_item_status for that.',
  {
    item_id: z.string().describe('The id of the item to update.'),
    title: z.string().min(1).optional().describe('New title. Optional — omit to leave unchanged.'),
    description: z.string().optional().describe('New description. Optional — omit to leave unchanged. Pass an empty string to clear the description.'),
  },
  async (input) => { ... }
)
```

Handler:
1. Verify `services.items.get(input.item_id)` exists. If not, return error response.
2. Validate that at least one of `title` or `description` is present. If neither is provided, return `{ content: [{ type: 'text', text: 'Error: provide at least one field to update' }], isError: true }`.
3. Capture `oldItem` = current item before update.
4. Call `services.items.update(input.item_id, { title: input.title, description: input.description })`.
5. Build `fields` payload: for each field that changed, record `{ old: oldValue, new: newValue }`.
6. Call `services.activity.append({ item_id: input.item_id, project_id: oldItem.project_id, actor_type: 'claude', actor_id: 'claude-code', event_type: 'item.updated', payload: { fields } })`.
7. Return `{ content: [{ type: 'text', text: JSON.stringify(updatedItem, null, 2) }] }`.

---

### Tool: `ldash_update_item_status`

```ts
server.tool(
  'ldash_update_item_status',
  'Move an item to a different status column. Use this to advance work through the board — for example, moving a task from "In Progress" to "Review" after completing the implementation. Accepts either a column id or a column name.',
  {
    item_id: z.string().describe('The id of the item to move.'),
    column_id: z.string().describe('The target column. Accepts either a column id or a column name (case-insensitive match). Examples: "Done", "In Progress", or the raw id.'),
  },
  async (input) => { ... }
)
```

Handler:
1. Verify `services.items.get(input.item_id)` exists. If not, return error response.
2. Capture `oldItem` for payload.
3. Resolve `column_id`: try direct id match via `services.columns.get(input.column_id)`. If undefined, try name match: call `services.columns.list()` and find case-insensitive match on `name`. If still not found, return `{ content: [{ type: 'text', text: 'Error: column not found. Available columns: <comma-separated names>' }], isError: true }` (including the list of column names helps the LLM self-correct).
4. Call `services.items.move(input.item_id, { column_id: resolvedColumnId })`.
5. Look up `fromColumnName` and `toColumnName` from `services.columns.list()`.
6. Call `services.activity.append({ item_id: input.item_id, project_id: oldItem.project_id, actor_type: 'claude', actor_id: 'claude-code', event_type: 'item.moved', payload: { from_column_id: oldItem.column_id, to_column_id: resolvedColumnId, from_column_name: fromColumnName, to_column_name: toColumnName } })`.
7. Return `{ content: [{ type: 'text', text: JSON.stringify(movedItem, null, 2) }] }`.

---

## `server/src/mcp/tools/comments.ts`

**File path:** `server/src/mcp/tools/comments.ts`

**Purpose:** Registers the `ldash_add_comment` tool.

**Dependencies:**
- `@modelcontextprotocol/sdk/server/mcp.js` — `McpServer`
- `zod`
- `../../types.ts` — `Services`

**Public interface:**

```ts
export function registerCommentTools(server: McpServer, services: Services): void
```

**Behaviour:**

### Tool: `ldash_add_comment`

```ts
server.tool(
  'ldash_add_comment',
  'Post a comment on an item. Use this to leave notes about implementation decisions, blockers encountered, questions for the human reviewer, or a summary of what was done. Comments are visible to the user in the item detail panel.',
  {
    item_id: z.string().describe('The id of the item to comment on.'),
    body: z.string().min(1).describe('The comment text. Markdown is accepted. Must not be empty.'),
  },
  async (input) => { ... }
)
```

Handler:
1. Verify `services.items.get(input.item_id)` exists. If not, return error response.
2. Call `services.comments.create({ item_id: input.item_id, body: input.body, author: 'claude-code' })`.
3. Retrieve `item` via `services.items.get(input.item_id)` to get `project_id`.
4. Call `services.activity.append({ item_id: input.item_id, project_id: item.project_id, actor_type: 'claude', actor_id: 'claude-code', event_type: 'comment.created', payload: { comment_id: comment.id, author: 'claude-code' } })`.
5. Return `{ content: [{ type: 'text', text: JSON.stringify(comment, null, 2) }] }`.

---

## `server/src/mcp/tools/flags.ts`

**File path:** `server/src/mcp/tools/flags.ts`

**Purpose:** Registers `ldash_flag_item` and `ldash_block_item` tools.

**Dependencies:**
- `@modelcontextprotocol/sdk/server/mcp.js` — `McpServer`
- `zod`
- `../../types.ts` — `Services`

**Public interface:**

```ts
export function registerFlagTools(server: McpServer, services: Services): void
```

**Behaviour:**

### Tool: `ldash_flag_item`

```ts
server.tool(
  'ldash_flag_item',
  'Set or clear the flag on an item. Flagging is a general attention marker — use it to highlight items that need human review, have unresolved questions, or were touched in a way that warrants a second look. The flag state is visible on the board card.',
  {
    item_id: z.string().describe('The id of the item to flag or unflag.'),
    flagged: z.boolean().describe('true to set the flag, false to clear it.'),
  },
  async (input) => { ... }
)
```

Handler:
1. Verify `services.items.get(input.item_id)` exists. If not, return error response.
2. Retrieve current item for `project_id`.
3. Call `services.items.setFlag(input.item_id, input.flagged)`.
4. Call `services.activity.append({ item_id: input.item_id, project_id: item.project_id, actor_type: 'claude', actor_id: 'claude-code', event_type: input.flagged ? 'item.flagged' : 'item.unflagged', payload: { flagged: input.flagged } })`.
5. Return `{ content: [{ type: 'text', text: JSON.stringify(updatedItem, null, 2) }] }`.

---

### Tool: `ldash_block_item`

```ts
server.tool(
  'ldash_block_item',
  'Mark an item as blocked (or unblocked). Use this when you cannot proceed because of an external dependency, a missing decision, or a prerequisite that is not yet done. Blocked items are highlighted on the board. A reason is required when blocking.',
  {
    item_id: z.string().describe('The id of the item to block or unblock.'),
    blocked: z.boolean().describe('true to mark as blocked, false to clear the block.'),
    reason: z.string().optional().describe('Required when blocked is true. Describe what is blocking this item — for example "Waiting for design decision on modal layout". Ignored when blocked is false.'),
  },
  async (input) => { ... }
)
```

Handler:
1. Verify `services.items.get(input.item_id)` exists. If not, return error response.
2. If `input.blocked === true` and `(input.reason === undefined || input.reason.trim() === '')`, return `{ content: [{ type: 'text', text: 'Error: reason is required when blocking an item' }], isError: true }`.
3. Retrieve current item for `project_id`.
4. Call `services.items.setBlock(input.item_id, input.blocked, input.blocked ? input.reason!.trim() : '')`.
5. Call `services.activity.append({ item_id: input.item_id, project_id: item.project_id, actor_type: 'claude', actor_id: 'claude-code', event_type: input.blocked ? 'item.blocked' : 'item.unblocked', payload: input.blocked ? { blocked: true, reason: input.reason } : { blocked: false } })`.
6. Return `{ content: [{ type: 'text', text: JSON.stringify(updatedItem, null, 2) }] }`.

---

## `ItemService` additions

**File path:** `server/src/services/items.ts` (existing file — add one method)

Add `listFiltered` to `ItemService`:

```ts
listFiltered(opts: {
  project_id: string;
  column_id?: string;
  type?: ItemType;
  parent_id?: string | null;
}): Item[]
```

Behaviour:
1. Build a SQL query starting with `SELECT * FROM items WHERE project_id = ?`.
2. If `opts.column_id` is provided, append `AND column_id = ?` with the value.
3. If `opts.type` is provided, append `AND type = ?`.
4. If `opts.parent_id` is provided: if the value is the string `'null'`, append `AND parent_id IS NULL`; otherwise append `AND parent_id = ?` with the value.
5. Append `ORDER BY column_id ASC, position ASC`.
6. Execute with the collected params. Map integer booleans to JS booleans. Return the array.

Note: the string `'null'` as a filter value is a deliberate convention for MCP callers who cannot pass `null` directly in a JSON schema `z.string()` field. The tool description documents this.

---

## `server/src/index.ts` changes

**File path:** `server/src/index.ts` (existing file — add MCP router mount)

After registering all existing API routes, add:

```ts
import { createMcpRouter } from './routes/mcp.js'

// ...existing route registrations...

app.route('/mcp', createMcpRouter(services))
```

The `services` bundle is constructed by collecting already-instantiated service instances:

```ts
const services: Services = { projects, items, columns, comments, activity }
```

This `Services` object is passed to `createMcpRouter`. No other changes to `index.ts`.

---

## How to connect Claude Code

After starting the ldash server (`pnpm dev`), add the MCP server to Claude Code from within your project repo:

```sh
claude mcp add ldash --transport http http://127.0.0.1:3000/mcp
```

This registers ldash as an HTTP (Streamable HTTP) MCP server under the name `ldash`. Claude Code will connect to `http://127.0.0.1:3000/mcp` and discover the available tools on the next session start.

To verify the connection:

```sh
claude mcp list
```

The `ldash` entry should appear with status connected.

---

## Acceptance criteria

A verifier can check each item using either a raw JSON-RPC HTTP call or the `@modelcontextprotocol/sdk` client. The base URL is `http://127.0.0.1:3000/mcp`.

### MCP session initialisation

1. `POST /mcp` with JSON-RPC `initialize` request (`{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "test", "version": "1.0" } } }`) returns `200` with a result containing `serverInfo.name === "ldash"`.
2. `POST /mcp` with `tools/list` request returns a result with a `tools` array containing exactly 8 entries: `ldash_list_projects`, `ldash_list_items`, `ldash_get_item`, `ldash_create_item`, `ldash_update_item_fields`, `ldash_update_item_status`, `ldash_add_comment`, `ldash_flag_item`, `ldash_block_item`. (9 tools — count includes both flag tools.)

### `ldash_list_projects`

3. Calling `ldash_list_projects` with no arguments returns a JSON array. On a fresh database the array is empty. After creating a project via `POST /api/projects`, the array contains that project.

### `ldash_list_items`

4. Calling `ldash_list_items` with a nonexistent `project_id` returns a response with `isError: true` and the word "not found" in the text.
5. Calling `ldash_list_items` with a valid `project_id` returns the items for that project.
6. Calling `ldash_list_items` with `type: "task"` returns only tasks.
7. Calling `ldash_list_items` with `column_id` set to a column name (e.g. `"Backlog"`) returns only items in that column.
8. Calling `ldash_list_items` with `parent_id: "null"` (string) returns only top-level items with no parent.

### `ldash_get_item`

9. Calling `ldash_get_item` with a nonexistent `item_id` returns `isError: true`.
10. Calling `ldash_get_item` with a valid `item_id` returns an object with keys `item`, `comments`, and `recent_activity`.
11. After adding a comment via `ldash_add_comment`, `ldash_get_item` on the same item includes that comment in `comments`.
12. After moving an item via `ldash_update_item_status`, `ldash_get_item` shows the activity entry in `recent_activity`.

### `ldash_create_item`

13. Calling `ldash_create_item` with `project_id`, `type: "task"`, and `title` creates an item; `ldash_list_items` subsequently returns it.
14. Calling `ldash_create_item` with no `column_id` places the item in the Backlog column.
15. Calling `ldash_create_item` with a column name (e.g. `"In Progress"`) places the item in that column.
16. Calling `ldash_create_item` writes an `item.created` activity entry with `actor_type === "claude"` and `actor_id === "claude-code"` — verifiable via `GET /api/items/:id/activity`.
17. Calling `ldash_create_item` with a nonexistent `project_id` returns `isError: true`.

### `ldash_update_item_fields`

18. Calling `ldash_update_item_fields` with a new `title` updates the item's title. `ldash_get_item` confirms the change.
19. Calling `ldash_update_item_fields` with neither `title` nor `description` returns `isError: true`.
20. Calling `ldash_update_item_fields` writes an `item.updated` activity entry with `actor_type === "claude"`.

### `ldash_update_item_status`

21. Calling `ldash_update_item_status` with `column_id: "Done"` moves the item to the Done column. `ldash_get_item` confirms `item.column_id` is the Done column id.
22. Calling `ldash_update_item_status` with a raw column id also works.
23. Calling `ldash_update_item_status` with a nonexistent column name returns `isError: true` and the response text includes the list of available column names.
24. Calling `ldash_update_item_status` writes an `item.moved` activity entry with `actor_type === "claude"`.

### `ldash_add_comment`

25. Calling `ldash_add_comment` creates a comment with `author === "claude-code"`. `GET /api/items/:itemId/comments` returns it.
26. Calling `ldash_add_comment` writes a `comment.created` activity entry with `actor_type === "claude"`.
27. Calling `ldash_add_comment` with an empty `body` returns `isError: true` (Zod validation failure).
28. Calling `ldash_add_comment` with a nonexistent `item_id` returns `isError: true`.

### `ldash_flag_item`

29. Calling `ldash_flag_item` with `flagged: true` sets the item's `flagged` field to `true`. `GET /api/items/:id` confirms.
30. Calling `ldash_flag_item` with `flagged: false` clears it.
31. Both operations write an activity entry (`item.flagged` or `item.unflagged`) with `actor_type === "claude"`.

### `ldash_block_item`

32. Calling `ldash_block_item` with `blocked: true, reason: "Waiting for API keys"` sets `blocked: true` and `blocked_reason: "Waiting for API keys"`. `GET /api/items/:id` confirms.
33. Calling `ldash_block_item` with `blocked: true` and no `reason` returns `isError: true`.
34. Calling `ldash_block_item` with `blocked: false` clears the block and sets `blocked_reason` to `""`.
35. Both operations write an activity entry with `actor_type === "claude"`.

### Concurrent clients

36. Two simultaneous `POST /mcp` requests (e.g. two `ldash_list_projects` calls sent concurrently) both return `200` with valid responses. The server does not crash or hang.

---

## Tests

**Framework:** Vitest. All test files live under `server/test/mcp/`.

### `server/test/mcp/setup.ts`

**Purpose:** Shared test setup that starts a real Hono HTTP server on a random port with a fresh `:memory:` SQLite database, returns a base URL and an SDK `Client` instance, and provides a `teardown()` function.

**Exports:**

```ts
export interface TestContext {
  baseUrl: string;
  client: Client;                 // @modelcontextprotocol/sdk Client
  teardown: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext>
```

**Behaviour of `createTestContext`:**

1. Open a `better-sqlite3` database at `':memory:'`.
2. Run the schema (`schema.ts` exported sql) and seed (`seed.ts` logic) against it.
3. Instantiate all five services with the in-memory db.
4. Build the Hono app and register all routes (including the MCP router).
5. Start the server on port `0` (OS assigns a free port) using `@hono/node-server`.
6. Read the assigned port from the server's address.
7. Create an `@modelcontextprotocol/sdk` `Client` instance configured to connect to `http://127.0.0.1:<port>/mcp` using the SDK's `StreamableHTTPClientTransport`.
8. Call `await client.connect(transport)` (sends the `initialize` handshake).
9. Return `{ baseUrl: 'http://127.0.0.1:<port>', client, teardown: async () => { await client.close(); server.close(); } }`.

**Note for implementer:** `schema.ts` and `seed.ts` must export their logic as callable functions (not just side effects on import) so the test setup can call them with the in-memory db instance. If Phase 1 implemented them as side-effects, refactor the export — this is a required change for testability.

---

### `server/test/mcp/projects.test.ts`

Tests for `ldash_list_projects`.

Required test cases:
- Returns an empty array when no projects exist.
- Returns a project after creating one via `ProjectService.create` directly on the test db's service instance.
- The returned JSON is valid and the project fields match.

---

### `server/test/mcp/items.test.ts`

Tests for `ldash_list_items`, `ldash_get_item`, `ldash_create_item`, `ldash_update_item_fields`, `ldash_update_item_status`.

Each test should set up a project and at least one item using the service layer directly (not via MCP) so that MCP tool tests start from a known state.

Required test cases:
- `ldash_list_items` returns all items for a project.
- `ldash_list_items` with `type` filter returns only matching items.
- `ldash_list_items` with `column_id` as a name resolves correctly.
- `ldash_list_items` with nonexistent project returns isError response.
- `ldash_get_item` returns item, empty comments array, and activity array.
- `ldash_get_item` with nonexistent id returns isError response.
- `ldash_create_item` creates an item that appears in `ldash_list_items`.
- `ldash_create_item` without `column_id` places item in Backlog.
- `ldash_create_item` writes activity with `actor_type === 'claude'`.
- `ldash_update_item_fields` changes the title; `ldash_get_item` reflects it.
- `ldash_update_item_fields` with no fields returns isError.
- `ldash_update_item_fields` writes activity with `actor_type === 'claude'`.
- `ldash_update_item_status` moves item by column name.
- `ldash_update_item_status` moves item by column id.
- `ldash_update_item_status` with unknown column returns isError with available columns listed.
- `ldash_update_item_status` writes `item.moved` activity with `actor_type === 'claude'`.

---

### `server/test/mcp/comments.test.ts`

Tests for `ldash_add_comment`.

Required test cases:
- Creates a comment with `author === 'claude-code'`.
- Comment appears in `GET /api/items/:itemId/comments` (HTTP call to the test server).
- Empty body returns isError.
- Nonexistent item_id returns isError.
- Writes `comment.created` activity with `actor_type === 'claude'`.

---

### `server/test/mcp/flags.test.ts`

Tests for `ldash_flag_item` and `ldash_block_item`.

Required test cases:
- `ldash_flag_item` with `true` sets flagged; with `false` clears it.
- Both write correct activity event type.
- `ldash_block_item` with `blocked: true, reason` sets blocked and reason.
- `ldash_block_item` with `blocked: true` and no reason returns isError.
- `ldash_block_item` with `blocked: false` clears blocked and clears reason.
- Both write correct activity event type with `actor_type === 'claude'`.

---

## Data contracts

All tool responses follow the MCP `CallToolResult` shape:

```ts
interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
```

When `isError` is `true`, `content[0].text` starts with `'Error: '` followed by a human-readable description.

When successful, `content[0].text` is a JSON string. The JSON shapes for each tool's success response are the TypeScript types defined in Phase 1 (`Item`, `Project`, `Comment`, `ActivityEntry`), serialised with `JSON.stringify(value, null, 2)`.

The `ldash_get_item` success response JSON shape:

```ts
{
  item: Item;
  comments: Comment[];
  recent_activity: ActivityEntry[];
}
```

---

## File paths summary

New files:
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/mcp/server.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/mcp/handler.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/mcp/tools/projects.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/mcp/tools/items.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/mcp/tools/comments.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/mcp/tools/flags.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/routes/mcp.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/test/mcp/setup.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/test/mcp/projects.test.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/test/mcp/items.test.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/test/mcp/comments.test.ts`
- `/home/stark-botha/dev/fsystems/projects/ldash/server/test/mcp/flags.test.ts`

Modified files:
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/index.ts` — add MCP router mount and `Services` bundle construction
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/services/items.ts` — add `listFiltered` method
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/types.ts` — add `Services` interface
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/db/schema.ts` — export schema sql as a string or callable function (for test setup)
- `/home/stark-botha/dev/fsystems/projects/ldash/server/src/db/seed.ts` — export seed logic as a callable function (for test setup)
- `/home/stark-botha/dev/fsystems/projects/ldash/server/package.json` — add `@modelcontextprotocol/sdk` dependency and `vitest` dev dependency
