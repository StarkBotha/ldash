# ldash — Phase 5 Implementation Spec: Planning Mode + Markdown Export

## Decisions made in this spec

**Apply model: live tool execution.** When the LLM calls a planning tool during a conversation, the tool executes immediately against the service layer. The board updates in realtime via the existing SSE stream. There is no separate "review and apply" step. This decision is made for three reasons: (1) the realtime board is already the audit trail — every action appears in the activity log with `actor_type: 'llm'`, so the user sees exactly what happened; (2) a batch-apply model requires the LLM to produce a complete, parseable "plan object" before anything is written, which adds complexity and makes partial execution of multi-step plans difficult; (3) the undo story for batch-apply is no better than for live execution — if you want to undo you delete the created items either way. The cost of live execution is that the board mutates while the LLM is mid-response; the benefit is that the user watches it happen rather than receiving a blob to review.

**Tool-calling abstraction: a single `callWithTools` interface on the LLM gateway.** Both adapters (Claude Agent SDK and OpenAI-compatible) must implement a `callWithTools` method alongside the existing streaming `call` method. The gateway never exposes provider-specific tool call shapes to callers. The loop is run server-side: the gateway returns either a `TextChunk` or a `ToolCallRequest`, the planning route handler executes the tool call, sends the result back to the gateway, and the gateway continues — this is the tool-calling loop contract. The UI only sees streamed text and tool-call indicator events over SSE; it never participates in the tool loop.

**Planning tools are internal-only; they mirror the service layer, not the MCP endpoint.** The three planning tools (`create_item`, `update_item`, `list_items`) call the service layer directly with `actor_type: 'llm'`. They are not exposed via MCP and are not registered on the MCP server. They exist only inside the planning tool loop in the LLM gateway.

**Planning system prompt injects project context.** On every planning conversation turn, the backend assembles a context block: project name and description, the full column list in order, and a compact summary of existing items (id, type, title, column name, parent title) capped at 200 items. This is injected as a system message. The LLM is instructed to converse first, create items only when the user has signalled agreement, and use the established epic → story → task hierarchy.

**Planning view layout: full-width chat panel with live board below.** The board shrinks to a compact card-list view beneath a full-height chat panel. This is chosen over a side-by-side layout because: (1) planning conversations tend to be text-heavy; (2) the board below gives spatial confirmation that items were created without fighting the chat for horizontal space; (3) it is simpler to implement responsively. The user can close the planning panel to return to the normal board view.

**Markdown export scope: items only.** Conversations and activity are excluded from the export. The export is a snapshot of the planning output — what was decided — not the history of how it was decided. The architecture doc notes this as an open question; items-only is the conservative answer.

**`actor_type` extension: add `'llm'` to the allowed values.** The Phase 1 schema constrains `actor_type` to `'user' | 'claude'`. Phase 5 introduces a third actor: the planning LLM acting autonomously during a planning conversation. This is distinct from Claude Code (`'claude'`) acting as an MCP client. A schema migration adds `'llm'` to the allowed set. The `actor_id` for planning tool calls is `'planning-llm'`.

**No per-conversation model override in this spec.** The architecture doc mentions "per-conversation model override" as part of Phase 5. This spec defers it — it requires a settings UI and conversation metadata that is more cleanly done as a standalone addition. The planning conversation uses whatever provider/model is currently configured in the gateway settings. This is noted so an implementer does not add it.

**Export is always triggered manually.** There is no automatic export on project change. A "Export to Markdown" button on the project board header triggers the export. The backend generates the files synchronously, writes them to `exports/<project-slug>/`, and returns the export directory path to the UI. The UI shows the path in a small toast.

---

## Schema migration

**File path:** `server/src/db/migrations/004_planning_actor.ts`

Add `'llm'` to the `actor_type` check constraint on the `activity` table. SQLite does not support `ALTER COLUMN` with a new constraint, so this requires a table recreation. The migration:

1. Renames `activity` to `activity_old`.
2. Creates a new `activity` table identical to the Phase 1 schema except the check constraint reads `CHECK (actor_type IN ('user', 'claude', 'llm'))`.
3. Copies all rows from `activity_old` to `activity`.
4. Drops `activity_old`.
5. Recreates the three indexes on the new table.

All steps run in a single transaction. The migration runner (introduced in Phase 4 and assumed to exist) executes this on startup before the app starts serving requests.

Update `server/src/types.ts`: change `ActorType = 'user' | 'claude'` to `ActorType = 'user' | 'claude' | 'llm'`.

---

## Project layout additions

All new files. Nothing in the existing tree is deleted or renamed.

```
server/
  src/
    db/
      migrations/
        004_planning_actor.ts     [new] — adds 'llm' to actor_type constraint
    gateway/
      types.ts                    [new] — LLM gateway interface including tool-calling types
      loop.ts                     [new] — tool-calling loop runner
      adapters/
        claude.ts                 [modified] — add callWithTools implementation
        openai.ts                 [modified] — add callWithTools implementation
    planning/
      tools.ts                    [new] — planning tool definitions (create_item, update_item, list_items)
      prompt.ts                   [new] — system prompt builder
      context.ts                  [new] — project context assembler
    routes/
      planning.ts                 [new] — POST /api/projects/:id/planning and streaming endpoint
    export/
      generator.ts                [new] — markdown generation logic
      writer.ts                   [new] — writes generated markdown to disk
    routes/
      export.ts                   [new] — POST /api/projects/:id/export
  test/
    planning/
      loop.test.ts                [new] — tool loop against mocked LLM + temp DB
      tools.test.ts               [new] — individual planning tool execution
    export/
      generator.test.ts           [new] — export output structure

ui/
  src/
    components/
      PlanView.tsx                [new] — planning mode layout (chat + compact board)
      PlanChat.tsx                [new] — planning chat panel with streaming + tool indicators
      CompactBoard.tsx            [new] — read-only compact item list for use below chat
    api/
      planning.ts                 [new] — typed fetch wrappers for planning endpoints
      export.ts                   [new] — typed fetch wrapper for export endpoint
    hooks/
      usePlanningChat.ts          [new] — manages planning conversation state + streaming
```

---

## 1. `server/src/gateway/types.ts`

**File path:** `server/src/gateway/types.ts`

**Purpose:** Defines the unified LLM gateway interface, including the tool-calling extension.

**Dependencies:** None (pure types).

**Public interface:**

```ts
// Existing types assumed from Phase 4 (do not redefine if already present):
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;   // present when role === 'tool' (tool result)
  tool_calls?: ToolCallRequest[];  // present when role === 'assistant' with pending calls
}

// New types for tool calling:
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema object for the tool's input parameters
}

export interface ToolCallRequest {
  id: string;          // opaque call id, must be echoed back in the tool result message
  name: string;        // which tool the LLM wants to call
  arguments: string;   // JSON string of the arguments
}

export type GatewayChunk =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; call: ToolCallRequest }
  | { type: 'done' };

// The adapter interface (assumed from Phase 4, extended here):
export interface LLMAdapter {
  // Phase 4 streaming method (already exists):
  call(messages: ChatMessage[], options?: CallOptions): AsyncIterable<GatewayChunk>;

  // Phase 5 addition — same streaming contract but accepts tool definitions:
  callWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: CallOptions
  ): AsyncIterable<GatewayChunk>;
}

export interface CallOptions {
  model?: string;
  maxTokens?: number;
}
```

**Behaviour:** Types only; no runtime logic.

**Data contracts:**

`ToolDefinition.parameters` must be a valid JSON Schema object (type `object` with a `properties` key). The `callWithTools` implementer passes this directly to the provider's function/tool calling API.

`GatewayChunk` is a discriminated union. A `tool_call` chunk signals that the LLM has requested a tool invocation. A `text` chunk is a token of streamed response text. A `done` chunk signals the end of one LLM turn (the loop may not be done — there may be further turns after tool results are submitted).

---

## 2. `server/src/gateway/loop.ts`

**File path:** `server/src/gateway/loop.ts`

**Purpose:** Runs the tool-calling loop — submits messages to the adapter, executes any tool calls via registered handlers, feeds results back, and streams text chunks to a caller-supplied sink.

**Dependencies:**
- `./types` — `LLMAdapter`, `ChatMessage`, `ToolDefinition`, `ToolCallRequest`, `GatewayChunk`

**Public interface:**

```ts
export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

export type TextSink = (chunk: string) => void;

export type ToolCallSink = (call: ToolCallRequest) => void;

export async function runToolLoop(
  adapter: LLMAdapter,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  toolHandler: ToolHandler,
  textSink: TextSink,
  toolCallSink: ToolCallSink,
  options?: { maxTurns?: number }
): Promise<ChatMessage[]>
```

**Behaviour of `runToolLoop`:**

1. `maxTurns` defaults to `10`. This prevents runaway loops if the LLM repeatedly calls tools without emitting text.
2. Maintain a mutable `history: ChatMessage[]` initialised as a shallow copy of `messages`.
3. Loop up to `maxTurns` times:
   a. Call `adapter.callWithTools(history, tools, options)` to get a `GatewayChunk` async iterable.
   b. Iterate over chunks:
      - On `{ type: 'text' }`: call `textSink(chunk.content)`.
      - On `{ type: 'tool_call' }`: append the call to a `pendingCalls: ToolCallRequest[]` list; call `toolCallSink(chunk.call)` so the UI can show an indicator.
      - On `{ type: 'done' }`: break the inner iteration.
   c. If `pendingCalls` is empty (no tool calls this turn), break the outer loop — the LLM has finished.
   d. Build the assistant message: `{ role: 'assistant', content: '', tool_calls: pendingCalls }`. Append to `history`.
   e. For each call in `pendingCalls`, in order:
      - Parse `call.arguments` as JSON. If parsing fails, use `{}` as the arguments.
      - Call `await toolHandler(call.name, parsedArgs)`. If the handler throws, the result string is `'Error: ' + error.message`.
      - Append a `{ role: 'tool', content: resultString, tool_call_id: call.id }` message to `history`.
   f. Clear `pendingCalls` and continue the outer loop.
4. Return the final `history` array (all messages including assistant turns and tool results).

**Edge cases:**
- If `maxTurns` is exhausted without the LLM finishing, stop the loop and append a final `{ role: 'assistant', content: '[Planning loop reached maximum turns]' }` to history. This is a safety valve — in practice a well-prompted LLM will not hit it.
- If `adapter.callWithTools` throws, propagate the error. The route handler is responsible for catching and surfacing it to the client.

**Do NOT implement:** The adapter-specific tool call format translation. That lives in `adapters/claude.ts` and `adapters/openai.ts`.

---

## 3. `server/src/gateway/adapters/openai.ts` (modified)

**File path:** `server/src/gateway/adapters/openai.ts`

**Purpose:** OpenAI-compatible adapter extended with `callWithTools`.

**Dependencies:**
- `../types` — `LLMAdapter`, `ChatMessage`, `ToolDefinition`, `GatewayChunk`, `CallOptions`

**Public interface addition:**

```ts
async *callWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options?: CallOptions
): AsyncGenerator<GatewayChunk>
```

**Behaviour:**

1. Map `tools` to the OpenAI `functions` / `tools` format:
   ```json
   {
     "type": "function",
     "function": {
       "name": tool.name,
       "description": tool.description,
       "parameters": tool.parameters
     }
   }
   ```
2. Map `messages` to the OpenAI messages format. Messages with `role: 'tool'` map to OpenAI `role: 'tool'` with `tool_call_id`. Messages with `tool_calls` on an assistant message map to OpenAI's `tool_calls` array format where each element has `type: 'function'`, `id`, and `function: { name, arguments }`.
3. Send a POST to `<baseUrl>/chat/completions` with `stream: true`, `model`, `messages`, `tools`, and `tool_choice: 'auto'`.
4. Parse the SSE stream. For each `data:` line (excluding `[DONE]`):
   - If the delta contains `content`, yield `{ type: 'text', content: delta.content }`.
   - If the delta contains `tool_calls`, accumulate the chunks (tool call arguments arrive in fragments across multiple SSE events) until the finish reason is `tool_calls`. Then yield one `{ type: 'tool_call', call: { id, name, arguments } }` per tool call.
5. After the stream ends, yield `{ type: 'done' }`.

**Tool call argument accumulation:** OpenAI streams tool call arguments as delta strings across multiple events, each identified by an index. Maintain a `Map<number, { id: string; name: string; argumentsBuffer: string }>`. When the final `finish_reason: 'tool_calls'` or `finish_reason: 'stop'` is received, flush all buffered calls.

---

## 4. `server/src/gateway/adapters/claude.ts` (modified)

**File path:** `server/src/gateway/adapters/claude.ts`

**Purpose:** Claude Agent SDK adapter extended with `callWithTools`.

**Dependencies:**
- `@anthropic-ai/claude-code` (or the Agent SDK package assumed from Phase 4) — the client instance
- `../types` — `LLMAdapter`, `ChatMessage`, `ToolDefinition`, `GatewayChunk`, `CallOptions`

**Public interface addition:**

```ts
async *callWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options?: CallOptions
): AsyncGenerator<GatewayChunk>
```

**Behaviour:**

The Claude Agent SDK uses Anthropic's native tool use format, which differs from OpenAI's. The adapter translates:

1. Map `tools` to Anthropic's `tools` array format:
   ```json
   {
     "name": tool.name,
     "description": tool.description,
     "input_schema": tool.parameters
   }
   ```
2. Map `messages`. `ChatMessage` with `role: 'tool'` maps to Anthropic's `user` message containing a `tool_result` content block:
   ```json
   { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": msg.tool_call_id, "content": msg.content }] }
   ```
   `ChatMessage` with `tool_calls` (assistant pending calls) maps to Anthropic's `assistant` message containing `tool_use` content blocks:
   ```json
   { "role": "assistant", "content": [{ "type": "tool_use", "id": call.id, "name": call.name, "input": JSON.parse(call.arguments) }] }
   ```
3. Call the Claude API with streaming enabled, passing `tools` and `tool_choice: { type: 'auto' }`.
4. Process streaming events. Anthropic's event stream uses `content_block_start`, `content_block_delta`, and `content_block_stop` events:
   - Text block deltas (`input_json_delta` type for tool input, `text_delta` for text): yield `{ type: 'text', content }` for text deltas.
   - `content_block_start` with `type: 'tool_use'`: record the new tool call being constructed.
   - `content_block_delta` with `type: 'input_json_delta'`: accumulate into the current tool call's argument buffer.
   - `content_block_stop` when the current block is a tool call: yield `{ type: 'tool_call', call: { id, name, arguments: accumulatedJson } }`.
   - `message_stop` event: yield `{ type: 'done' }`.

**Conservative decision on SDK version:** This spec assumes the Anthropic SDK exposes streaming messages with tool use via `client.messages.stream(...)` and events accessible via `.on('contentBlockDelta', ...)` or similar. If the Agent SDK wraps this differently (e.g. via an Agent abstraction), the implementer must adapt, but the `GatewayChunk` output contract does not change.

---

## 5. `server/src/planning/tools.ts`

**File path:** `server/src/planning/tools.ts`

**Purpose:** Defines the three planning tools (`create_item`, `update_item`, `list_items`) as `ToolDefinition` objects and provides handlers that execute them against the service layer.

**Dependencies:**
- `../gateway/types` — `ToolDefinition`, `ToolHandler`
- `../types` — `Services`, `ItemType`

**Public interface:**

```ts
export function getPlanningToolDefinitions(): ToolDefinition[]

export function createPlanningToolHandler(
  services: Services,
  projectId: string
): ToolHandler
```

**Behaviour of `getPlanningToolDefinitions`:**

Returns an array of exactly three `ToolDefinition` objects:

---

**Tool: `create_item`**

```ts
{
  name: 'create_item',
  description: 'Create a new item (epic, story, or task) on the project board. Call this when the user has agreed to add a piece of work. Epics represent large themes (weeks of work), stories represent a coherent user-facing feature or component (days), tasks represent a single concrete unit of work (hours). Always place epics in the Backlog column unless the user specifies otherwise.',
  parameters: {
    type: 'object',
    required: ['type', 'title', 'column_id'],
    properties: {
      type: {
        type: 'string',
        enum: ['epic', 'story', 'task'],
        description: 'The item type.'
      },
      title: {
        type: 'string',
        description: 'Short, action-oriented title. For tasks start with a verb (e.g. "Implement login endpoint").'
      },
      description: {
        type: 'string',
        description: 'Longer description of the work. Optional. Use to capture acceptance criteria or technical notes.'
      },
      column_id: {
        type: 'string',
        description: 'The id of the column to place this item in. Use the column id from the project context, not the name.'
      },
      parent_id: {
        type: 'string',
        description: 'The id of the parent item. Required for stories (parent must be an epic) and tasks (parent must be a story or epic). Omit for top-level epics.'
      }
    }
  }
}
```

---

**Tool: `update_item`**

```ts
{
  name: 'update_item',
  description: 'Update the title or description of an existing item. Use this to refine an item you just created, or to improve a pre-existing item based on the planning conversation.',
  parameters: {
    type: 'object',
    required: ['item_id'],
    properties: {
      item_id: {
        type: 'string',
        description: 'The id of the item to update.'
      },
      title: {
        type: 'string',
        description: 'New title. Omit to leave unchanged.'
      },
      description: {
        type: 'string',
        description: 'New description. Omit to leave unchanged.'
      }
    }
  }
}
```

---

**Tool: `list_items`**

```ts
{
  name: 'list_items',
  description: 'List the current items on the board for this project. Use this to check what already exists before creating duplicates, or to find the id of an item you want to update or set as a parent.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['epic', 'story', 'task'],
        description: 'Filter by item type. Omit to list all types.'
      }
    }
  }
}
```

---

**Behaviour of `createPlanningToolHandler`:**

Returns a `ToolHandler` function. The returned handler:

1. Receives `name: string` and `args: Record<string, unknown>`.
2. Dispatches on `name`:

**`create_item` dispatch:**
- Validate `args.type` is one of `'epic' | 'story' | 'task'`. If not, return `'Error: type must be epic, story, or task'`.
- Validate `args.title` is a non-empty string. If not, return `'Error: title is required'`.
- Validate `args.column_id` is a string. If not, return `'Error: column_id is required'`.
- Verify `args.column_id` exists: call `services.columns.get(args.column_id as string)`. If undefined, call `services.columns.list()` and try case-insensitive name match. If still not found, return `'Error: column not found'`.
- If `args.parent_id` is provided, verify `services.items.get(args.parent_id as string)` exists and its `project_id === projectId`. If not, return `'Error: parent item not found in this project'`.
- Call `services.items.create({ project_id: projectId, type, title, description: args.description as string ?? '', column_id: resolvedColumnId, parent_id: args.parent_id as string ?? null })`.
- Call `services.activity.append({ item_id: item.id, project_id: projectId, actor_type: 'llm', actor_id: 'planning-llm', event_type: 'item.created', payload: { title: item.title, type: item.type, column_id: item.column_id } })`.
- Call `eventBus.emit({ type: 'item.created', projectId, entityId: item.id, data: { item } })`.
- Return `JSON.stringify({ success: true, item })`.

**`update_item` dispatch:**
- Validate `args.item_id` is a non-empty string.
- Verify `services.items.get(args.item_id as string)` exists and its `project_id === projectId`. If not, return `'Error: item not found in this project'`.
- Validate that at least one of `args.title` or `args.description` is present. If neither, return `'Error: provide title or description to update'`.
- Capture `oldItem` before update.
- Call `services.items.update(args.item_id as string, { title: args.title as string | undefined, description: args.description as string | undefined })`.
- Build `fields` change payload.
- Call `services.activity.append({ item_id, project_id: projectId, actor_type: 'llm', actor_id: 'planning-llm', event_type: 'item.updated', payload: { fields } })`.
- Call `eventBus.emit({ type: 'item.updated', projectId, entityId: item.id, data: { item: updatedItem } })`.
- Return `JSON.stringify({ success: true, item: updatedItem })`.

**`list_items` dispatch:**
- Call `services.items.listFiltered({ project_id: projectId, type: args.type as ItemType | undefined })`.
- Return a compact JSON string: array of `{ id, type, title, column_id, parent_id }` objects. Omit description to keep the response small.

**Unknown tool name:**
- Return `'Error: unknown tool ' + name`.

**Note on `eventBus`:** `createPlanningToolHandler` must receive the `eventBus` instance. Update the signature:

```ts
export function createPlanningToolHandler(
  services: Services,
  projectId: string,
  bus: EventBus
): ToolHandler
```

---

## 6. `server/src/planning/context.ts`

**File path:** `server/src/planning/context.ts`

**Purpose:** Assembles a structured plain-text project context block to be injected into the planning system prompt on every conversation turn.

**Dependencies:**
- `../types` — `Services`

**Public interface:**

```ts
export function buildProjectContext(
  services: Services,
  projectId: string
): string
```

**Behaviour:**

1. Fetch the project: `services.projects.get(projectId)`. If undefined, throw an `Error('Project not found')`.
2. Fetch columns: `services.columns.list()`. Build a map of `columnId → columnName`.
3. Fetch items: `services.items.listByProject(projectId)`. Take at most 200 items (if more exist, silently truncate — this is a single-developer tool and 200+ items in planning is an edge case).
4. For each item, resolve:
   - `columnName` from the column map.
   - `parentTitle`: if `item.parent_id` is set, look it up in the items array. If found, use its `title`; if not found (orphan), use `null`.
5. Build the context string in this exact format:

```
PROJECT: <project.name>
DESCRIPTION: <project.description or "(no description)">

COLUMNS (in order):
- <position>. <name> [id: <id>]
... one per column ...

EXISTING ITEMS (<count> total):
- [<TYPE>] <title> (id: <id>, column: <columnName><, parent: <parentTitle> if set>)
... one per item, sorted by type then title ...

ITEM HIERARCHY CONVENTION:
- Epic: a large theme of work (multiple stories, weeks of effort). Create epics first.
- Story: a coherent user-facing feature under an epic (days of effort). Set parent_id to the epic.
- Task: a single concrete unit of work under a story or epic (hours). Set parent_id to the story or epic.
```

6. Return the assembled string.

**Edge cases:**
- If the project has no items, the `EXISTING ITEMS` section reads: `EXISTING ITEMS (0 total):\n(none yet)`.
- Column ids must appear in the context so the LLM can pass them directly to `create_item`. Names alone would require the tool to do a name lookup on every call.

---

## 7. `server/src/planning/prompt.ts`

**File path:** `server/src/planning/prompt.ts`

**Purpose:** Constructs the full system prompt for a planning conversation turn.

**Dependencies:**
- `./context` — `buildProjectContext`
- `../types` — `Services`

**Public interface:**

```ts
export function buildPlanningSystemPrompt(
  services: Services,
  projectId: string
): string
```

**Behaviour:**

1. Call `buildProjectContext(services, projectId)` to get the context block.
2. Return the following string (exact wording is load-bearing — do not paraphrase):

```
You are a project planning assistant helping to build out a software project board. You have access to three tools: list_items (to inspect what exists), create_item (to add new epics, stories, and tasks), and update_item (to refine existing items).

RULES:
1. Converse first. Understand what the user wants to build before creating anything. Ask clarifying questions if the scope is unclear.
2. Propose before creating. Describe the plan in words, tell the user what you intend to create, and wait for them to agree before calling create_item.
3. Use the hierarchy. Epics first, then stories under epics, then tasks under stories. Never create a task without a parent story or epic.
4. Use the exact column ids from the project context — do not invent ids.
5. Be concise. Titles should be short and action-oriented. Descriptions should capture acceptance criteria or technical notes when useful, not restate the title.
6. Do not create duplicate items. Call list_items first if you are unsure whether an item already exists.

<project_context>
{{PROJECT_CONTEXT}}
</project_context>
```

Replace `{{PROJECT_CONTEXT}}` with the assembled context string.

---

## 8. `server/src/routes/planning.ts`

**File path:** `server/src/routes/planning.ts`

**Purpose:** HTTP route handlers for the planning conversation: send a message and stream the LLM response with embedded tool-call events.

**Dependencies:**
- `hono` — `Hono`, `streamText`
- `../types` — `Services`
- `../events/bus` — `EventBus`
- `../planning/tools` — `getPlanningToolDefinitions`, `createPlanningToolHandler`
- `../planning/prompt` — `buildPlanningSystemPrompt`
- `../gateway/loop` — `runToolLoop`
- Phase 4 gateway singleton (assumed: `import { getGateway } from '../gateway/index'` or similar — do not implement, flag as Phase 4 dependency)
- Phase 4 `ConversationService` (assumed: provides `getOrCreatePlanningConversation`, `appendMessage`, `getMessages` — do not implement)

**Public interface:**

```ts
export function createPlanningRouter(services: Services, bus: EventBus): Hono
```

**Endpoints:**

---

### `POST /api/projects/:projectId/planning/messages`

Creates a user message, runs the planning tool loop, streams the response.

**Request body:**
```ts
{ "content": string }  // the user's message text
```

**Response:** `text/event-stream` (SSE). Each event is a JSON-encoded `PlanningStreamEvent`.

```ts
export type PlanningStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolName: string; label: string }
  | { type: 'tool_result'; toolName: string; success: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

**Behaviour:**

1. Validate `projectId` param. Call `services.projects.get(projectId)`. If not found, return `404`.
2. Validate request body: `content` must be a non-empty string. If invalid, return `400`.
3. Get or create the planning conversation for this project via Phase 4's `ConversationService`. The conversation type is `'planning'` scoped to the project. The Phase 4 spec guarantees such a conversation type exists.
4. Append the user message to the conversation via `ConversationService.appendMessage({ role: 'user', content })`.
5. Fetch the full message history for this conversation via `ConversationService.getMessages(conversationId)`. Map to `ChatMessage[]`.
6. Build the system prompt: `buildPlanningSystemPrompt(services, projectId)`. Prepend it as `{ role: 'system', content: systemPrompt }` to the message array.
7. Get the LLM gateway via Phase 4's gateway accessor.
8. Build the planning tools: `getPlanningToolDefinitions()`.
9. Build the tool handler: `createPlanningToolHandler(services, projectId, bus)`.
10. Set response headers for SSE: `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
11. Use Hono's `streamText` to open an SSE stream.
12. Call `runToolLoop(adapter, messages, tools, toolHandler, textSink, toolCallSink)`:
    - `textSink`: write `PlanningStreamEvent { type: 'text', content }` to the stream.
    - `toolCallSink`: write `PlanningStreamEvent { type: 'tool_call', toolName: call.name, label: buildToolCallLabel(call.name, call.arguments) }` to the stream. (See label builder below.)
13. When `runToolLoop` resolves, write `PlanningStreamEvent { type: 'done' }`.
14. Persist the assistant's final text response and all tool turns from the returned history to the conversation via `ConversationService.appendMessage` for each new message in the returned history that is not already persisted.
15. On any error during the loop: write `PlanningStreamEvent { type: 'error', message: err.message }` and close the stream.

**`buildToolCallLabel(toolName, argumentsJson)` — internal helper:**

- `create_item`: parse args, return `'Creating <type>: "<title>"'`.
- `update_item`: return `'Updating item <item_id>'`.
- `list_items`: return `'Listing items'`.
- Fallback: return `'Calling ' + toolName`.

---

### `GET /api/projects/:projectId/planning/messages`

Returns the planning conversation history for the project.

**Response `200`:**
```ts
{
  conversationId: string;
  messages: ChatMessage[];
}
```

**Errors:** `404` if project not found.

**Behaviour:**
1. Validate project exists.
2. Get the planning conversation via `ConversationService.getOrCreatePlanningConversation(projectId)`.
3. Fetch messages via `ConversationService.getMessages(conversationId)`.
4. Return `{ conversationId, messages }`.

---

### `DELETE /api/projects/:projectId/planning/messages`

Clears the planning conversation history (resets it). Allows the user to start fresh.

**Response `204`:** empty body.

**Errors:** `404` if project not found.

**Behaviour:**
1. Validate project exists.
2. Get the conversation id from `ConversationService`.
3. Call `ConversationService.clearMessages(conversationId)`.

**Do NOT implement:** `ConversationService` methods — those are Phase 4. Flag as external dependency.

---

## 9. `server/src/export/generator.ts`

**File path:** `server/src/export/generator.ts`

**Purpose:** Pure function that takes project data and returns an in-memory representation of the markdown export tree — no disk writes.

**Dependencies:**
- `../types` — `Services`, `Item`, `Project`, `Column`, `Comment`

**Public interface:**

```ts
export interface ExportFile {
  relativePath: string;  // e.g. 'README.md' or 'epic-user-auth/README.md'
  content: string;       // full markdown content
}

export function generateExport(
  services: Services,
  projectId: string
): ExportFile[]
```

**Behaviour of `generateExport`:**

1. Fetch `project = services.projects.get(projectId)`. If undefined, throw `Error('Project not found')`.
2. Fetch `columns = services.columns.list()`. Build a `columnMap: Map<string, string>` of `id → name`.
3. Fetch `items = services.items.listByProject(projectId)`.
4. Separate items into `epics` (type === 'epic'), `stories` (type === 'story'), `tasks` (type === 'task').
5. Build a `slugify(text: string): string` local helper: lowercase the text, replace spaces and non-alphanumeric characters with hyphens, collapse consecutive hyphens, trim hyphens from start/end. Maximum 50 characters. Example: `'User Authentication'` → `'user-authentication'`.
6. Build `README.md` (project overview file):

```markdown
# <project.name>

<project.description or "(No description.)">

## Epics

<for each epic, ordered by position:>
- [<columnName>] [<title>](./epic-<slug>/README.md)

## Export info

Generated: <ISO timestamp>
Total items: <count>
```

7. For each epic, build `epic-<slug>/README.md`:

```markdown
# <epic.title>

**Status:** <columnName>

<epic.description or "_No description._">

## Stories

<for each story whose parent_id === epic.id, ordered by position:>

### <story.title>

**Status:** <columnName>

<story.description or "_No description._">

#### Tasks

<for each task whose parent_id === story.id, ordered by position:>
- [<columnName>] **<task.title>**
  <task.description if non-empty, indented with two spaces>

---
```

Stories with no tasks omit the `#### Tasks` section. If an epic has no stories, the `## Stories` section reads `_No stories yet._`.

8. Build one additional file `orphans.md` only if there are stories or tasks with no matching parent in the fetched items:

```markdown
# Orphaned Items

These items have a parent_id that does not match any item in this project.

<list each orphan with type, title, status>
```

If no orphans exist, do not generate this file.

9. Return the array of `ExportFile` objects.

**Data contracts:**

`ExportFile[]` — every element has a `relativePath` (forward-slash separated, no leading slash, suitable for joining with the export directory path) and a `content` string.

**Do NOT implement:** Disk writing. That is in `writer.ts`.

---

## 10. `server/src/export/writer.ts`

**File path:** `server/src/export/writer.ts`

**Purpose:** Writes an array of `ExportFile` objects to a directory on disk.

**Dependencies:**
- `node:fs/promises` — `mkdir`, `writeFile`
- `node:path` — `join`, `dirname`
- `./generator` — `ExportFile`

**Public interface:**

```ts
export async function writeExport(
  files: ExportFile[],
  outputDir: string
): Promise<void>
```

**Behaviour:**

1. For each `file` in `files`:
   a. Compute the absolute path: `join(outputDir, file.relativePath)`.
   b. Compute the parent directory: `dirname(absolutePath)`.
   c. Call `mkdir(parentDir, { recursive: true })` to ensure the directory exists.
   d. Call `writeFile(absolutePath, file.content, 'utf-8')`.
2. All writes run sequentially (not in parallel) to avoid race conditions on shared parent directories.

**Error handling:** Propagate `fs` errors as-is. The route handler catches them.

---

## 11. `server/src/routes/export.ts`

**File path:** `server/src/routes/export.ts`

**Purpose:** HTTP route handler for triggering a markdown export.

**Dependencies:**
- `hono` — `Hono`
- `../types` — `Services`
- `../export/generator` — `generateExport`
- `../export/writer` — `writeExport`
- `node:path` — `join`, `resolve`
- `node:process` — `cwd`

**Public interface:**

```ts
export function createExportRouter(services: Services): Hono
```

**Endpoint:**

### `POST /api/projects/:projectId/export`

**Request body:** empty (no body required).

**Response `200`:**
```ts
{
  "outputDir": string,      // absolute path to the export directory
  "fileCount": number
}
```

**Errors:** `404` if project not found. `500` on filesystem errors.

**Behaviour:**

1. Validate `projectId`. Call `services.projects.get(projectId)`. If not found, return `404`.
2. Compute `outputDir`:
   - Fetch the project to get its name.
   - Slugify the project name using the same `slugify` logic as the generator (implement it as a shared utility in `server/src/utils/slugify.ts` — see below).
   - `outputDir = resolve(cwd(), 'exports', slugifiedName)`.
3. Call `generateExport(services, projectId)` to get the `ExportFile[]`.
4. Call `await writeExport(files, outputDir)`.
5. Return `{ outputDir, fileCount: files.length }`.

---

## 12. `server/src/utils/slugify.ts`

**File path:** `server/src/utils/slugify.ts`

**Purpose:** Shared slug utility used by both the export generator and the export route.

**Public interface:**

```ts
export function slugify(text: string): string
```

**Behaviour:**
1. Lowercase `text`.
2. Replace any character that is not `a-z`, `0-9`, or `-` with `-`.
3. Replace runs of two or more consecutive `-` with a single `-`.
4. Trim leading and trailing `-`.
5. Truncate to 50 characters.
6. If the result is empty (e.g. input was all punctuation), return `'untitled'`.

---

## 13. `server/src/index.ts` changes

**File path:** `server/src/index.ts` (modified)

Add two new route registrations in the startup sequence, after the existing route registrations:

```ts
import { createPlanningRouter } from './routes/planning.js';
import { createExportRouter } from './routes/export.js';

app.route('/', createPlanningRouter(services, eventBus));
app.route('/', createExportRouter(services));
```

No other changes to `index.ts`.

---

## 14. UI: `ui/src/components/PlanView.tsx`

**File path:** `ui/src/components/PlanView.tsx`

**Purpose:** Top-level layout component for planning mode — renders the chat panel above the compact board.

**Dependencies:**
- `react`
- `./PlanChat` — `PlanChat`
- `./CompactBoard` — `CompactBoard`

**Public interface:**

```ts
interface PlanViewProps {
  projectId: string;
  onClose: () => void;  // called when the user clicks "Close planning mode"
}

export function PlanView({ projectId, onClose }: PlanViewProps): JSX.Element
```

**Behaviour:**

Renders two stacked sections:
1. A top section (approximately 60% of the viewport height) containing `<PlanChat projectId={projectId} />`.
2. A bottom section (approximately 40%) containing `<CompactBoard projectId={projectId} />`.
3. A small "Close planning mode" button in the top-right corner that calls `onClose`.

The `PlanView` is rendered by `Board.tsx` when the user clicks a "Plan" button in the board header. When active, `PlanView` replaces the normal `Board` layout (not layered on top of it).

**Layout:** Use CSS flexbox with `flex-direction: column` and `height: 100vh`. The top section uses `flex: 3`, the bottom uses `flex: 2`, so their ratio is 3:2. No pixels hardcoded.

---

## 15. `ui/src/hooks/usePlanningChat.ts`

**File path:** `ui/src/hooks/usePlanningChat.ts`

**Purpose:** Manages the full state of a planning conversation including history, streaming state, and tool-call indicators.

**Dependencies:**
- `react` — `useState`, `useEffect`, `useRef`, `useCallback`
- `../api/planning` — `sendPlanningMessage`, `fetchPlanningHistory`, `clearPlanningHistory`
- `../types` — `ChatMessage`, `PlanningStreamEvent`

**Public interface:**

```ts
export interface ToolCallIndicator {
  toolName: string;
  label: string;
  status: 'pending' | 'done' | 'error';
}

export interface UsePlanningChatReturn {
  messages: ChatMessage[];
  streamingContent: string;          // partial text of the in-progress assistant message
  toolCallIndicators: ToolCallIndicator[];  // tool calls in the current turn
  isStreaming: boolean;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  clearHistory: () => Promise<void>;
}

export function usePlanningChat(projectId: string): UsePlanningChatReturn
```

**Behaviour:**

On mount: call `fetchPlanningHistory(projectId)` and populate `messages`.

`sendMessage(content)`:
1. Set `isStreaming = true`, `streamingContent = ''`, `toolCallIndicators = []`.
2. Append an optimistic `{ role: 'user', content }` message to `messages`.
3. Open a `fetch` request to `POST /api/projects/:projectId/planning/messages` with `{ content }`.
4. Read the response body as a stream using `response.body.getReader()`.
5. Decode chunks and parse newline-delimited JSON events (each line is a `PlanningStreamEvent` JSON string followed by `\n`).
6. On `{ type: 'text' }`: append `content` to `streamingContent`.
7. On `{ type: 'tool_call' }`: append `{ toolName, label, status: 'pending' }` to `toolCallIndicators`.
8. On `{ type: 'tool_result' }`: find the most recent `pending` indicator with matching `toolName` and update its `status` to `success ? 'done' : 'error'`.
9. On `{ type: 'done' }`: append a final `{ role: 'assistant', content: streamingContent }` message to `messages`. Set `streamingContent = ''`. Set `isStreaming = false`.
10. On `{ type: 'error' }`: set `error = event.message`. Set `isStreaming = false`.
11. On network error: set `error = 'Network error'`. Set `isStreaming = false`.

**Note on SSE vs plain streaming:** The planning endpoint uses SSE format (newline-delimited JSON), not the browser's `EventSource` API, because the user initiates each turn with a `POST`. A `fetch`-based stream reader is correct here. Each server-side event is written as a JSON line terminated with `\n`.

`clearHistory()`:
1. Call `clearPlanningHistory(projectId)`.
2. Reset `messages = []`, `streamingContent = ''`, `toolCallIndicators = []`, `error = null`.

---

## 16. `ui/src/components/PlanChat.tsx`

**File path:** `ui/src/components/PlanChat.tsx`

**Purpose:** The visible chat panel — message history, streaming response, tool-call indicators, and an input box.

**Dependencies:**
- `react` — `useState`, `useRef`, `useEffect`
- `../hooks/usePlanningChat` — `usePlanningChat`

**Public interface:**

```ts
interface PlanChatProps {
  projectId: string;
}

export function PlanChat({ projectId }: PlanChatProps): JSX.Element
```

**Behaviour:**

1. Call `usePlanningChat(projectId)`.
2. Render a scrollable message list. Each message in `messages` renders as a chat bubble (left-aligned for `assistant`, right-aligned for `user`).
3. If `isStreaming` is true, render a partial bubble at the bottom with `streamingContent` (may be empty if only tool calls have fired so far) and a blinking cursor.
4. For each `ToolCallIndicator` in `toolCallIndicators`, render a small line below the streaming bubble: `label` text, with a spinner if `status === 'pending'` and a checkmark if `status === 'done'` and an X if `status === 'error'`.
5. At the bottom: a textarea input and a "Send" button. The textarea is disabled while `isStreaming`. On submit (button click or Enter without Shift), call `sendMessage(inputValue)` and clear the input.
6. A "Clear history" button that calls `clearHistory()` after a `window.confirm('Clear the planning conversation?')`.
7. Auto-scroll the message list to the bottom when `messages` changes or `streamingContent` changes. Use a `useEffect` with a `ref` on the scroll container and `scrollIntoView` or `scrollTop = scrollHeight`.
8. If `error` is non-null, render a red error banner above the input with the error text and a dismiss button.

---

## 17. `ui/src/components/CompactBoard.tsx`

**File path:** `ui/src/components/CompactBoard.tsx`

**Purpose:** A compact, read-only view of the project board items grouped by column, rendered below the planning chat.

**Dependencies:**
- `react`
- `@tanstack/react-query` — `useQuery`
- `../api/client` — `fetchItems`, `fetchColumns`
- `../types` — `Item`, `Column`

**Public interface:**

```ts
interface CompactBoardProps {
  projectId: string;
}

export function CompactBoard({ projectId }: CompactBoardProps): JSX.Element
```

**Behaviour:**

1. Fetch items and columns via `useQuery` (reuses the same query keys as `Board` so SSE invalidations update this view too).
2. Group items by `column_id`. Display columns in order.
3. Each column: a small heading with the column name and item count.
4. Each item: a single line showing a type badge and title. Truncate titles longer than 60 characters with ellipsis. Show a small flag icon if `flagged` or a red dot if `blocked`.
5. No clicking, no detail panel, no drag-and-drop. This is purely informational.
6. If loading, show a single "Loading board..." text. If error, show "Failed to load board".

---

## 18. `ui/src/components/Board.tsx` (modified)

**File path:** `ui/src/components/Board.tsx`

**Purpose addition:** Add the "Plan" button in the board header that opens `PlanView`.

**Changes required:**

1. Add state: `isPlanningMode: boolean`, initially `false`.
2. When `isPlanningMode` is `true`, render `<PlanView projectId={projectId} onClose={() => setIsPlanningMode(false)} />` instead of the normal board layout.
3. In the board header, add a "Plan" button that sets `isPlanningMode = true`.
4. Add an "Export" button in the board header (next to "Plan") that calls `POST /api/projects/:projectId/export` and shows the returned `outputDir` in a `window.alert('Exported to: ' + outputDir)`. This is minimal — no toast system.

No other changes to `Board.tsx`.

---

## 19. Tests

### `server/test/planning/loop.test.ts`

**File path:** `server/test/planning/loop.test.ts`

**Purpose:** Verifies the tool-calling loop against a mocked LLM adapter and a real in-memory SQLite database.

**Dependencies:**
- `vitest` — `describe`, `it`, `expect`, `vi`
- `better-sqlite3` — in-memory db
- `../../src/db/schema`, `../../src/db/seed` — schema and seed functions
- All five services
- `../../src/events/bus` — `EventBus` (class)
- `../../src/planning/tools` — `getPlanningToolDefinitions`, `createPlanningToolHandler`
- `../../src/gateway/loop` — `runToolLoop`
- `../../src/gateway/types` — `LLMAdapter`, `GatewayChunk`

**Setup:** Each test opens a fresh `:memory:` database, runs schema and seed, creates a project via `ProjectService.create`, and creates a fresh `EventBus`.

**Mocked adapter factory:**

```ts
function mockAdapter(chunks: GatewayChunk[]): LLMAdapter {
  return {
    call: async function*() {},
    callWithTools: async function*() { yield* chunks; }
  };
}
```

**Required test cases:**

1. `text-only response emits text chunks and returns history` — adapter yields `[{ type: 'text', content: 'Hello' }, { type: 'done' }]`. Call `runToolLoop`. Assert `textSink` called once with `'Hello'`. Assert returned history has an assistant message with `content === 'Hello'`.

2. `create_item tool call creates an item in the database` — adapter yields `[{ type: 'tool_call', call: { id: '1', name: 'create_item', arguments: JSON.stringify({ type: 'task', title: 'Test task', column_id: '<backlogColumnId>' }) } }, { type: 'done' }]`, then on the second turn yields `[{ type: 'text', content: 'Done' }, { type: 'done' }]`. Call `runToolLoop`. Assert `ItemService.listByProject(projectId)` returns one item with `title === 'Test task'`.

3. `update_item tool call updates an existing item` — create an item in setup, then run loop with `update_item` call. Assert item title is updated.

4. `list_items tool call returns existing items` — create two items, run loop with `list_items` call that returns a result, then text response. Assert `toolHandler` was called and returned a JSON string containing both item ids.

5. `unknown tool returns error string without throwing` — adapter yields a `tool_call` with `name: 'nonexistent_tool'`. Assert the loop completes without throwing, and the tool result message in the returned history contains `'Error: unknown tool'`.

6. `maxTurns exceeded appends safety message` — adapter always yields a `tool_call` then `done` (never terminates naturally). Pass `maxTurns: 3`. Assert loop terminates after 3 turns and the final assistant message contains `'maximum turns'`.

7. `activity entry is written with actor_type llm` — run loop with a `create_item` call. After the loop, query `ActivityService.listByItem(createdItemId, { limit: 1 })`. Assert the entry has `actor_type === 'llm'` and `actor_id === 'planning-llm'`.

8. `eventBus emits item.created on create_item tool call` — subscribe to a fresh `EventBus`. Run loop with `create_item` call. Assert the bus emitted one `BoardEvent` with `type === 'item.created'`.

---

### `server/test/export/generator.test.ts`

**File path:** `server/test/export/generator.test.ts`

**Purpose:** Verifies the export output structure against a known database state.

**Setup:** In-memory database with seeded columns. Creates one project, two epics, two stories (one per epic), three tasks (two under story one, one under story two).

**Required test cases:**

1. `returns a README.md file` — assert `files.find(f => f.relativePath === 'README.md')` is defined. Assert the content includes the project name and at least one epic link.

2. `returns one file per epic` — assert `files.filter(f => f.relativePath.endsWith('/README.md') && f.relativePath !== 'README.md').length === 2`.

3. `epic file contains its stories and tasks` — find the export file for epic one. Assert it contains story one's title and both task titles nested under it.

4. `items with no parent epic are not listed in the project README` — create a story with `parent_id === null`. Assert it does not appear in `README.md` epic list. Assert an `orphans.md` file is returned.

5. `orphans.md is not generated when there are no orphans` — assert `files.find(f => f.relativePath === 'orphans.md')` is undefined when all items have valid parents.

6. `slugify produces filesystem-safe paths` — create an epic named `"User Auth & Session Management!"`. Assert the corresponding file path is `epic-user-auth-session-management/README.md` or similar (no `&` or `!`).

7. `items with flagged === true are not excluded` — flagged items are exported normally (flagging is a board state, not a filter for export).

8. `column status appears in item output` — create an item in the `Done` column. Assert the epic's export file includes the word `Done` next to that item.

---

## Acceptance criteria checklist

The following behaviours must be verifiable after running `pnpm dev`:

### Planning mode

1. Clicking "Plan" on a project board replaces the board layout with the planning view (chat on top, compact board below).
2. Clicking "Close planning mode" returns to the normal board view.
3. Sending a message in the planning chat receives a streaming response visible in the UI as tokens arrive.
4. When the LLM calls `create_item` during a planning response, a tool-call indicator appears in the chat (e.g. `Creating task: "Implement login endpoint"`) and the item appears in the compact board below within 2 seconds (via SSE).
5. After planning, the items created appear on the normal board when the user closes planning mode.
6. The activity feed for a created item shows `actor_type: 'llm'` and `actor_id: 'planning-llm'` for items created during planning.
7. Clearing the planning conversation removes all messages from the chat. The board items previously created are NOT removed.
8. Sending a message while `isStreaming === true` is disabled (the send button and textarea are disabled).
9. If the LLM gateway is not configured (no provider set), the planning endpoint returns a clear error and the UI displays it in the error banner.

### Export

10. Clicking "Export" on the project board header triggers the export and shows the output directory path.
11. The `exports/<project-slug>/` directory is created on the filesystem.
12. The directory contains a `README.md` with the project overview.
13. There is one subdirectory per epic, each containing a `README.md`.
14. Each epic's `README.md` contains its stories and their tasks, with status labels.
15. Running the export a second time overwrites the existing files (no duplication or conflict).
16. If the project has no items, the export still produces a valid `README.md` with zero epics listed.

### Automated tests

17. `pnpm --filter server test` exits with code 0.
18. `loop.test.ts` — all 8 tests pass, including the `create_item` test confirming the item exists in the database after the loop.
19. `generator.test.ts` — all 8 tests pass.

---

## Phase 4 dependencies (do not implement)

These are items this spec assumes Phase 4 has delivered. If any of these are missing, Phase 5 cannot be built without resolving them first.

- `ConversationService` with methods: `getOrCreatePlanningConversation(projectId)`, `appendMessage(conversationId, message)`, `getMessages(conversationId)`, `clearMessages(conversationId)`. The planning conversation type is `'planning'` and is scoped to a project (not an item).
- A gateway accessor (`getGateway()` or similar) that returns the configured `LLMAdapter` instance.
- The `conversations` and `messages` tables in SQLite (with the `type` field on `conversations` supporting `'planning'`).
- The `LLMAdapter` interface with its Phase 4 `call` method already implemented on both adapters.
