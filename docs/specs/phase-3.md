# ldash — Phase 3 Implementation Spec: Realtime Board Updates + Drag-and-Drop

## Decisions made in this spec

**Event bus: a simple in-process EventEmitter wrapper, not a library.** Node's built-in `EventEmitter` is sufficient. A thin typed wrapper keeps event payloads enforced at compile time. No external pub/sub library (Redis, etc.) is needed — the architecture doc is explicit that everything is one process.

**SSE reconnection: client refetches on reconnect, no event replay.** The architecture doc says "the SSE stream relays it and the UI patches the affected card." It does not mandate event history or gap recovery. Implementing a cursor-based replay system would add significant complexity (storing events, tracking client positions) for a single-user local tool where reconnects are rare. On reconnect, the `EventSource` client invalidates all board queries and lets TanStack Query refetch fresh data. This is explicitly the chosen approach.

**SSE endpoint scoped to project: one connection per open board.** The query param `?projectId=` scopes events to a single project. This keeps the client-side filter trivial — every event received is relevant to the open board.

**Drag-and-drop library: @dnd-kit/core + @dnd-kit/sortable.** It is the current standard for accessible, headless DnD in React. It has no implicit DOM structure opinions and works naturally with existing column/card component trees. HTML5 native DnD is rejected because its drag image and touch support are poor and it requires significant boilerplate to get right. `react-beautiful-dnd` is archived/unmaintained. `@dnd-kit` is the safest pick.

**Optimistic updates on drag: local state only, not TanStack Query cache surgery.** When a drag ends, the UI immediately renders the card in the new column via a local `dragOverride` state, fires the move API call, then on success invalidates the board query. On failure it clears the override and the board snaps back. This avoids mutating TanStack Query's cache directly, which is error-prone for a list-of-lists structure.

**Heartbeat interval: 30 seconds.** This keeps proxies and load balancers (even if only nginx is ever in the way locally) from closing idle connections, without generating meaningless traffic.

**SSE endpoint lives in a new route file `server/src/routes/sse.ts`.** It is registered in `index.ts` at startup alongside the existing routes. The event bus instance is shared via the same dependency-injection pattern the service layer uses (passed as a constructor/factory argument).

**Event bus is emitted from route handlers, not the service layer.** The Phase 1 spec explicitly states "The service layer is designed so Phase 3 can add an event bus hook here with no route changes: the route handler calls the service, then emits an event." This spec follows that contract. Route handlers call `eventBus.emit(...)` after a successful service call.

**Connection indicator: a single fixed element in the UI, outside the board.** It shows only when the connection is not in the normal "connected" state — i.e. it appears on `reconnecting` or `error` and is hidden on `connected`. No library needed; a single `useSSE` hook drives it.

**Tests: Vitest for event bus and SSE endpoint.** The event bus tests are pure unit tests. The SSE endpoint tests use the existing `@hono/node-server` in-process with a real temp SQLite database — this proves the full path (mutation → event bus → SSE stream). UI drag-and-drop tests are excluded from automated testing; DnD interaction testing with jsdom is unreliable and the interaction is already covered by the integration acceptance criteria.

---

## Affected files and new files

Phase 3 touches or creates the following files. Files marked `[new]` do not exist yet. Files marked `[modified]` exist from Phase 1 and require additions.

```
server/
  src/
    events/
      bus.ts             [new] — typed event bus
      types.ts           [new] — BoardEvent union type and payload shapes
    routes/
      sse.ts             [new] — SSE endpoint
    index.ts             [modified] — wire event bus; register SSE route
    routes/
      projects.ts        [modified] — emit events after mutations
      items.ts           [modified] — emit events after mutations
      columns.ts         [modified] — emit events after mutations
      comments.ts        [modified] — emit events after mutations
  package.json           [modified] — no new runtime deps; add vitest + @types for tests
  vitest.config.ts       [new]

ui/
  src/
    hooks/
      useSSE.ts          [new] — EventSource lifecycle + TanStack Query invalidation
    components/
      ConnectionIndicator.tsx  [new] — visible only when disconnected/reconnecting
      Board.tsx          [modified] — wrap with DndContext; add drag handlers
      Column.tsx         [modified] — wrap with SortableContext (droppable)
      Card.tsx           [modified] — wrap with useSortable (draggable)
    types.ts             [modified] — add SSEEvent type (mirrors server BoardEvent)
  package.json           [modified] — add @dnd-kit/core @dnd-kit/sortable

server/
  src/
    __tests__/
      eventBus.test.ts   [new] — unit tests for event bus
      sse.test.ts        [new] — integration tests for SSE endpoint
```

---

## 1. `server/src/events/types.ts`

**File path:** `server/src/events/types.ts`

**Purpose:** Defines the `BoardEvent` discriminated union and all payload shapes that the event bus carries.

**Dependencies:** `../types` (imports `Item`, `Comment`, `ActivityEntry`, `Column`, `Project`)

**Public interface:**

```ts
export type BoardEventType =
  | 'item.created'
  | 'item.updated'
  | 'item.moved'
  | 'item.deleted'
  | 'item.flagged'
  | 'item.unflagged'
  | 'item.blocked'
  | 'item.unblocked'
  | 'comment.created'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'column.created'
  | 'column.updated'
  | 'column.reordered';

export interface BoardEvent {
  type: BoardEventType;
  projectId: string;           // always present; for project-level events this is the project's own id
  entityId: string;            // id of the primary entity (item id, comment id, project id, column id)
  data: Record<string, unknown>; // the changed record or minimal delta — see per-event contract below
}
```

**Behaviour:**

This file is types only — no runtime logic.

**Per-event `data` contract:**

Each event carries the minimum payload needed for the UI to act on it. The rule is: if the entire record is cheap to include (it is — records are small), include it. This saves the UI from issuing a follow-up fetch for the common case.

| `type` | `projectId` | `entityId` | `data` |
|---|---|---|---|
| `item.created` | item's project_id | item.id | `{ item: Item }` |
| `item.updated` | item's project_id | item.id | `{ item: Item }` |
| `item.moved` | item's project_id | item.id | `{ item: Item, fromColumnId: string, toColumnId: string }` |
| `item.deleted` | item's project_id | item.id | `{ itemId: string, title: string, type: string }` |
| `item.flagged` | item's project_id | item.id | `{ item: Item }` |
| `item.unflagged` | item's project_id | item.id | `{ item: Item }` |
| `item.blocked` | item's project_id | item.id | `{ item: Item }` |
| `item.unblocked` | item's project_id | item.id | `{ item: Item }` |
| `comment.created` | item's project_id | comment.id | `{ comment: Comment }` |
| `project.created` | project.id | project.id | `{ project: Project }` |
| `project.updated` | project.id | project.id | `{ project: Project }` |
| `project.deleted` | project.id | project.id | `{ projectId: string, name: string }` |
| `column.created` | `''` (no project scope) | column.id | `{ column: Column }` |
| `column.updated` | `''` | column.id | `{ column: Column }` |
| `column.reordered` | `''` | `''` | `{ columns: Column[] }` |

**Decisions on ambiguous cases:**

- `column.*` events are not scoped to a project (columns are global). `projectId` is set to `''`. The SSE endpoint does NOT filter these out for project-scoped connections — it sends them unconditionally because they affect the board layout of every project.
- `project.deleted` cannot include the full `Project` record because the record will have been deleted by the time the event is processed by late subscribers. The `name` is captured into the event payload before deletion.

---

## 2. `server/src/events/bus.ts`

**File path:** `server/src/events/bus.ts`

**Purpose:** A singleton typed event emitter that the route handlers call after every successful mutation.

**Dependencies:** Node `EventEmitter` (built-in), `./types` (imports `BoardEvent`)

**Public interface:**

```ts
export class EventBus {
  emit(event: BoardEvent): void
  subscribe(listener: (event: BoardEvent) => void): () => void
}

export const eventBus: EventBus  // singleton exported for use by routes and SSE handler
```

**Behaviour:**

`EventBus` wraps a Node `EventEmitter` instance. All events are emitted under a single channel name — the string `'board'`. This keeps the implementation trivial.

`emit(event)`: calls the internal `EventEmitter`'s `emit('board', event)`.

`subscribe(listener)`: calls `emitter.on('board', listener)` and returns an unsubscribe function that calls `emitter.off('board', listener)`. The return value is critical — SSE connections must call it on close to prevent memory leaks.

The module exports a pre-constructed singleton `eventBus`. All consumers import this singleton. Do not construct additional instances.

`EventEmitter`'s default max-listener warning fires at 11 listeners. Call `emitter.setMaxListeners(100)` in the constructor so that many concurrent SSE connections do not spam the console.

**Error handling:** No error handling. Listeners are trusted internal code. If a listener throws, Node's default uncaught exception behavior applies. Do not add try/catch wrappers in `emit` — that would silently swallow bugs.

---

## 3. `server/src/routes/sse.ts`

**File path:** `server/src/routes/sse.ts`

**Purpose:** Hono route handler for the SSE endpoint that streams `BoardEvent` objects to the UI as named Server-Sent Events.

**Dependencies:**
- `hono` — `Hono`, streaming response utilities
- `../events/bus` — `eventBus` singleton
- `../events/types` — `BoardEvent`

**Public interface:**

```ts
export function createSseRouter(bus: EventBus): Hono
```

Returns a Hono router with one route registered: `GET /api/sse`.

**Endpoint contract:**

- **Path:** `GET /api/sse`
- **Query parameter:** `projectId` (string, required). If absent or empty the endpoint returns `400 { "error": "projectId query param required" }`.
- **Response content-type:** `text/event-stream; charset=utf-8`
- **Response headers:** `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` (disables nginx buffering if nginx is ever in front).

**SSE event format:**

Each event is a named SSE event. The format on the wire follows the SSE spec: `event:` line, then `data:` line, then blank line.

```
event: board
data: {"type":"item.moved","projectId":"proj_abc","entityId":"item_xyz","data":{...}}

```

The `event` field is always the literal string `board`. The `data` field is the JSON-serialised `BoardEvent`. Using a named event (rather than anonymous `data:` only) lets the client attach a specific listener with `eventSource.addEventListener('board', handler)` instead of `onmessage`.

Heartbeat events use the SSE comment syntax (a line starting with `:`):

```
: heartbeat

```

This is invisible to `addEventListener` listeners — it only keeps the connection alive.

**Behaviour — connection lifecycle:**

1. Parse `projectId` from query params. Return `400` if missing or empty string.
2. Set the SSE response headers listed above.
3. Write the initial comment `: connected\n\n` immediately on connect. This flushes headers to the client and confirms the stream is live.
4. Subscribe to `eventBus` via `eventBus.subscribe(listener)`. Store the returned unsubscribe function.
5. Start a heartbeat interval: every 30 seconds, write `: heartbeat\n\n` to the stream.
6. In the listener: for each `BoardEvent` received, apply the project filter — pass the event if `event.projectId === projectId` OR `event.projectId === ''` (column events). Serialise the matching event as `event: board\ndata: <JSON>\n\n` and write it to the stream.
7. On stream close (client disconnects): call the unsubscribe function and clear the heartbeat interval. Hono's streaming API calls an `onAbort` or `close` callback — use whichever the framework exposes. Failing to unsubscribe causes the `EventBus` subscriber list to grow permanently.

**Hono streaming pattern:**

Use Hono's `streamText` (or `stream`) helper to get a writable stream. The exact API in Hono 4.x is:

```ts
return streamText(c, async (stream) => {
  // write initial comment
  // subscribe to bus
  // set heartbeat interval
  // await a never-resolving promise to keep stream open
  // cleanup in finally block
});
```

The `finally` block runs when the client disconnects, ensuring cleanup. Do not use `c.res` directly — use the Hono stream helper to avoid response-already-sent errors.

**Data contracts:**

- Input: `c.req.query('projectId')` — string
- Output: UTF-8 text stream per SSE spec

**Do NOT implement:** The SSE route does not write to the database, call any service, or read from SQLite. It is a pure fan-out of in-memory events.

---

## 4. Modifications to `server/src/index.ts`

**File path:** `server/src/index.ts` (modified)

**Purpose:** Wire the event bus and SSE route into the startup sequence.

**Changes required:**

After step 4 (instantiate services) and before step 5 (create Hono app), import `eventBus` from `./events/bus` — no instantiation needed, the singleton is created at module load.

In step 6 (register routes), add:

```ts
import { createSseRouter } from './routes/sse';
app.route('/', createSseRouter(eventBus));
```

The event bus singleton does not need to be passed to service or activity constructors — the route handlers receive it and call `eventBus.emit(...)` directly after calling the service.

No other startup changes.

---

## 5. Modifications to route handlers (emit events after mutations)

**Files:** `server/src/routes/projects.ts`, `server/src/routes/items.ts`, `server/src/routes/columns.ts`, `server/src/routes/comments.ts`

**Pattern for every mutation route:**

After the service call succeeds and the activity entry is written, add one `eventBus.emit(...)` call. The route handler imports `eventBus` from `../events/bus`. Nothing else in the route handler changes.

Example for `POST /api/items`:

```ts
const item = itemService.create(data);
activityService.append({ ... });
eventBus.emit({
  type: 'item.created',
  projectId: item.project_id,
  entityId: item.id,
  data: { item }
});
return c.json(item, 201);
```

**Complete list of emission points and their payloads** (the `data` field matches the per-event contract in `types.ts`):

| Route | Event emitted |
|---|---|
| `POST /api/projects` | `project.created` — `{ project }` |
| `PATCH /api/projects/:id` | `project.updated` — `{ project }` (the post-update record) |
| `DELETE /api/projects/:id` | `project.deleted` — `{ projectId, name }` (captured before deletion) |
| `POST /api/items` | `item.created` — `{ item }` |
| `PATCH /api/items/:id` | `item.updated` — `{ item }` |
| `PATCH /api/items/:id/move` | `item.moved` — `{ item, fromColumnId, toColumnId }` |
| `PATCH /api/items/:id/flag` (flagged=true) | `item.flagged` — `{ item }` |
| `PATCH /api/items/:id/flag` (flagged=false) | `item.unflagged` — `{ item }` |
| `PATCH /api/items/:id/block` (blocked=true) | `item.blocked` — `{ item }` |
| `PATCH /api/items/:id/block` (blocked=false) | `item.unblocked` — `{ item }` |
| `DELETE /api/items/:id` | `item.deleted` — `{ itemId, title, type }` (captured before deletion) |
| `POST /api/comments` | `comment.created` — `{ comment }` |
| `POST /api/columns` | `column.created` — `{ column }` |
| `PATCH /api/columns/:id` | `column.updated` — `{ column }` |
| `POST /api/columns/reorder` | `column.reordered` — `{ columns }` |
| `DELETE /api/columns/:id` | no event (Phase 1 spec: columns are infrastructure; same reasoning applies) |
| `DELETE /api/comments/:id` | no event (Phase 1 spec: comment deletion is not a plan state change) |

**projectId for column events:** Columns are global (not per-project). Set `projectId: ''` and `entityId: column.id`. For `column.reordered`, set `entityId: ''`.

---

## 6. `ui/src/hooks/useSSE.ts`

**File path:** `ui/src/hooks/useSSE.ts`

**Purpose:** React hook that opens an `EventSource` connection to the SSE endpoint for the given project, listens for `board` events, and invalidates the appropriate TanStack Query cache keys on each event.

**Dependencies:**
- `react` — `useEffect`, `useRef`, `useState`
- `@tanstack/react-query` — `useQueryClient`
- `../types` — `BoardEvent`, `BoardEventType`

**Public interface:**

```ts
export type SSEStatus = 'connected' | 'reconnecting' | 'error';

export function useSSE(projectId: string | null): { status: SSEStatus }
```

**Behaviour:**

1. If `projectId` is `null`, do nothing — return `{ status: 'reconnecting' }` and skip the effect. (Board is not mounted without a project.)
2. Open an `EventSource` at `/api/sse?projectId=${projectId}`.
3. Set `status` to `'connected'` in `EventSource.onopen`.
4. Attach `eventSource.addEventListener('board', handler)` where `handler` parses `event.data` as JSON into a `BoardEvent` and calls `invalidateForEvent(queryClient, projectId, boardEvent)`.
5. Set `status` to `'reconnecting'` in `EventSource.onerror`. `EventSource` auto-reconnects natively — no manual reconnect logic needed. When it reconnects and `onopen` fires again, set status back to `'connected'` and call `invalidateAll(queryClient, projectId)` to refetch everything, since events may have been missed during the gap.
6. On cleanup (effect teardown), call `eventSource.close()`.

**`invalidateForEvent(queryClient, projectId, event)` — internal helper:**

This function maps event types to TanStack Query key invalidations. Keep it as a plain function inside the hook file (not exported). The query keys must match exactly what Phase 1's hooks use — see Phase 1 spec hooks section for key conventions. The assumed key conventions are:

- Items list: `['items', projectId]`
- Columns list: `['columns']`
- Single item: `['item', entityId]`
- Comments for item: `['comments', entityId]` (entityId is item_id for comment events)
- Activity for item: `['activity', 'item', entityId]`
- Activity for project: `['activity', 'project', projectId]`
- Projects list: `['projects']`
- Single project: `['project', projectId]`

Invalidation rules per event type:

| Event type | Keys to invalidate |
|---|---|
| `item.created` | `['items', projectId]` |
| `item.updated` | `['items', projectId]`, `['item', entityId]` |
| `item.moved` | `['items', projectId]`, `['item', entityId]`, `['activity', 'item', entityId]` |
| `item.deleted` | `['items', projectId]`, `['activity', 'project', projectId]` |
| `item.flagged` / `item.unflagged` | `['items', projectId]`, `['item', entityId]` |
| `item.blocked` / `item.unblocked` | `['items', projectId]`, `['item', entityId]` |
| `comment.created` | `['comments', data.comment.item_id]`, `['activity', 'item', data.comment.item_id]` |
| `project.created` / `project.updated` | `['projects']`, `['project', entityId]` |
| `project.deleted` | `['projects']` |
| `column.created` / `column.updated` / `column.reordered` | `['columns']` |

**`invalidateAll(queryClient, projectId)` — internal helper (called on reconnect):**

Invalidates `['items', projectId]`, `['columns']`, and `['activity', 'project', projectId]`. This is the "refetch everything for this board" path used when the client reconnects after a gap.

**Note on query key alignment:** If the Phase 1 hooks use different key shapes, the implementer must align `invalidateForEvent` to match. The keys listed above are conservative assumptions from standard TanStack Query usage; verify against the actual hook implementations before finalising.

---

## 7. `ui/src/components/ConnectionIndicator.tsx`

**File path:** `ui/src/components/ConnectionIndicator.tsx`

**Purpose:** A single small UI element that displays an amber "Reconnecting..." badge when the SSE connection is not `connected`, and renders nothing when connected.

**Dependencies:**
- `react`
- `../hooks/useSSE` — `SSEStatus` type (imported as a type, not the hook — the hook is called in a parent)

**Public interface:**

```ts
interface ConnectionIndicatorProps {
  status: SSEStatus;
}

export function ConnectionIndicator({ status }: ConnectionIndicatorProps): JSX.Element | null
```

**Behaviour:**

If `status === 'connected'`, return `null` (renders nothing).

Otherwise render a fixed-position element in the bottom-right corner of the viewport with amber/orange background colour and white text. Text content: `'Reconnecting…'` when `status === 'reconnecting'`, `'Connection error'` when `status === 'error'`.

No animations, no transitions. Inline styles or a single CSS class — keep it minimal. The element must not interfere with board interaction (use `pointer-events: none` or position it outside the main content area).

---

## 8. Drag-and-drop: `Board.tsx`, `Column.tsx`, `Card.tsx`

### Library and installation

Add to `ui/package.json`:

```json
"@dnd-kit/core": "^6.x",
"@dnd-kit/sortable": "^8.x"
```

No other DnD packages are needed.

### Interaction model

Dragging a card to a different column calls `PATCH /api/items/:id/move` with the target `column_id` and no `position` (item is placed at the end of the target column). Dragging a card within the same column to a new position also calls `PATCH /api/items/:id/move` with the same `column_id` and a computed `position`.

Position within a column after drop: take the items currently rendered in the target column (after the optimistic state is applied), find the index of the dropped item's new position, and use that index as the `position` value. This is a soft sort key and gaps are acceptable per the Phase 1 spec.

### Modified `Board.tsx`

**Additional imports:** `DndContext`, `DragEndEvent`, `DragOverEvent` from `@dnd-kit/core`; `useSSE` from `../hooks/useSSE`; `ConnectionIndicator` from `./ConnectionIndicator`.

**New state:** `dragOverride: { itemId: string; toColumnId: string } | null` — set on `onDragEnd` while the API call is in flight, cleared on API response (success or failure).

**`useSSE` call:** Call `useSSE(projectId)` in `Board` and pass the returned `status` to `ConnectionIndicator`. This is the single location where the SSE hook is instantiated for the board.

**Rendering change:** Wrap the column grid in `<DndContext onDragEnd={handleDragEnd}>`. Render `<ConnectionIndicator status={status} />` outside (below or above) the DndContext — placement in the DOM is unimportant.

**Item distribution to columns:** Currently items are passed to each column by filtering `items` on `column_id`. With drag-and-drop, apply the `dragOverride` before distributing: if `dragOverride` is set, move the item with `dragOverride.itemId` to `dragOverride.toColumnId` in the distributed list. This gives the instant visual feedback.

**`handleDragEnd(event: DragEndEvent)`:**

1. Extract `active.id` (the dragged item's id) and `over.id` (the drop target — either a column id or another item's id; see Column section below).
2. Determine `toColumnId`: if `over.id` is a column id, use it directly. If `over.id` is an item id, look up that item's `column_id` from the board items list.
3. Determine `toPosition`: count items in the target column (after applying the override), find where the item landed.
4. Set `dragOverride = { itemId: active.id, toColumnId }`.
5. Call the move API: `await api.moveItem(itemId, { column_id: toColumnId, position: toPosition })`.
6. On success: clear `dragOverride` and invalidate `['items', projectId]`.
7. On failure: clear `dragOverride` (board snaps back to server state) and show a brief error — a simple `console.error` is acceptable; no toast system required in Phase 3.

### Modified `Column.tsx`

**Additional imports:** `SortableContext`, `verticalListSortingStrategy` from `@dnd-kit/sortable`; `useDroppable` from `@dnd-kit/core`.

**Change:** Wrap the list of `Card` components in `<SortableContext items={itemIds} strategy={verticalListSortingStrategy}>` where `itemIds` is the array of item ids in this column. Use `useDroppable({ id: column.id })` on the column container so that dragging to an empty column still registers a valid drop target.

No other logic changes in Column.

### Modified `Card.tsx`

**Additional imports:** `useSortable` from `@dnd-kit/sortable`; `CSS` from `@dnd-kit/utilities`.

**Change:** Call `useSortable({ id: item.id })` at the top of the component. Apply `attributes`, `listeners`, and `setNodeRef` to the card's root element. Apply `style={{ transform: CSS.Transform.toString(transform), transition }}` to give the drag animation. When `isDragging` is true, lower the card's opacity to 0.4 so the drag overlay (if configured) looks intentional.

No other logic changes in Card.

**Do NOT implement:** A custom drag overlay (`DragOverlay`) is optional polish — do not implement in Phase 3. The default browser drag representation is acceptable.

---

## 9. Server-side `package.json` additions

Add to `server/package.json` `devDependencies`:

```json
"vitest": "^2.x",
"@vitest/coverage-v8": "^2.x"
```

No new runtime dependencies on the server side.

---

## 10. `server/vitest.config.ts`

**File path:** `server/vitest.config.ts`

**Purpose:** Vitest configuration for the server package.

**Content:**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

---

## 11. `server/src/__tests__/eventBus.test.ts`

**File path:** `server/src/__tests__/eventBus.test.ts`

**Purpose:** Unit tests verifying that `EventBus.emit` calls subscribers with the correct payload and that unsubscribing stops delivery.

**Dependencies:** `vitest` (`describe`, `it`, `expect`, `vi`); `../../events/bus` (`EventBus`); `../../events/types` (`BoardEvent`)

**Tests to implement:**

Each test creates a fresh `EventBus` instance (not the singleton, to avoid cross-test interference — export the class as a named export alongside the singleton).

1. `emit calls a subscribed listener with the event` — subscribe a `vi.fn()`, emit a `BoardEvent`, assert the mock was called once with that event.
2. `emit calls multiple subscribers` — subscribe two separate mock functions, emit one event, assert both were called.
3. `unsubscribe stops delivery` — subscribe a mock, store the unsubscribe function, call it, emit an event, assert the mock was not called.
4. `emitting with no subscribers does not throw` — emit an event with no subscribers; assert no exception.
5. `emits correct payload for item.created shape` — construct a well-formed `BoardEvent` with `type: 'item.created'`, emit it, assert the listener received `type === 'item.created'` and `data.item` is defined.

**Note:** The singleton `eventBus` is NOT imported in these tests. Tests construct `new EventBus()` directly. The `EventBus` class must therefore be exported from `bus.ts` as a named class export (in addition to the `eventBus` singleton default).

---

## 12. `server/src/__tests__/sse.test.ts`

**File path:** `server/src/__tests__/sse.test.ts`

**Purpose:** Integration tests proving that the SSE endpoint connects, filters by project, sends events on mutation, and sends heartbeats.

**Dependencies:**
- `vitest` — `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi`
- `better-sqlite3` — open a temp in-memory database
- `../../db/schema` — run schema setup
- `../../db/seed` — run column seed
- `../../services/*` — instantiate real services
- `../../events/bus` — `EventBus` (the class, not the singleton)
- `../../routes/sse` — `createSseRouter`
- `../../routes/items`, `../../routes/projects`, etc. — to trigger real mutations
- `@hono/node-server` — to spin up a real HTTP server on a random port
- Node `http` built-in — to make raw HTTP requests and read the SSE stream

**Test setup (`beforeEach`):**

1. Open an in-memory better-sqlite3 database: `new Database(':memory:')`.
2. Run `applySchema(db)` and `seedColumns(db)`.
3. Instantiate all services with the in-memory db.
4. Construct a fresh `EventBus` instance.
5. Build a Hono app, register the SSE router and the items/projects/columns/comments routers (all wired to the same event bus instance).
6. Start a Node HTTP server on port 0 (OS-assigned random port) using `@hono/node-server`'s `serve` function.
7. Record the assigned port from the `listening` event.

**Teardown (`afterEach`):** Close the HTTP server. Close the database.

**Helper function `connectSSE(port, projectId)`:** Returns a Promise that resolves with an object `{ events: BoardEvent[], raw: string[], close: () => void }`. Internally opens a Node `http.get` request, accumulates the response text into a buffer, parses complete SSE messages (split on `\n\n`), and appends parsed `board` events to the `events` array. The `close()` function destroys the request. This helper must handle SSE framing — split each chunk on newlines, find `event: board` lines, extract the following `data:` line, and JSON-parse it.

**Tests to implement:**

1. `returns 400 when projectId is missing` — GET `/api/sse` with no query param; assert response status 400.
2. `connects and receives initial : connected comment` — connect with a valid projectId; assert that `raw` contains a chunk starting with `: connected`.
3. `does not deliver events for a different project` — connect for `projectAId`; create an item in `projectB`; wait 200ms; assert `events` array is empty.
4. `receives item.created event when item is created in the subscribed project` — create a project, connect for that projectId; POST a new item via the items router; wait 200ms; assert `events` has one entry with `type === 'item.created'` and `data.item.id` matching the created item's id.
5. `receives item.moved event when item is moved` — create an item, connect, call the move endpoint, wait, assert event received with `type === 'item.moved'`.
6. `column.reordered event is delivered regardless of projectId` — connect for any projectId; POST to `/api/columns/reorder`; wait; assert event with `type === 'column.reordered'` is received (because column events have `projectId === ''` and are not filtered out).
7. `heartbeat is sent within the configured interval` — override the heartbeat interval to 100ms for this test (inject a configurable interval into `createSseRouter` or mock the timer with `vi.useFakeTimers`); connect; advance time; assert raw stream contains `: heartbeat`.

**Decision on heartbeat test approach:** Use `vi.useFakeTimers()` rather than waiting a real 30 seconds. The `createSseRouter` must accept an optional `heartbeatIntervalMs` parameter (default `30_000`) so tests can pass a small value.

---

## Modified `createSseRouter` signature

Update the public interface of `server/src/routes/sse.ts` to:

```ts
export function createSseRouter(
  bus: EventBus,
  options?: { heartbeatIntervalMs?: number }
): Hono
```

`options.heartbeatIntervalMs` defaults to `30_000`. The SSE route uses this value when calling `setInterval`.

---

## Acceptance criteria

The following behaviours must be verifiable after running `pnpm dev`:

1. **SSE connects:** Opening a board at `/` causes the browser's DevTools Network tab to show a persistent `GET /api/sse?projectId=<id>` with type `eventsource` and status 200. The response preview shows the initial `: connected` comment.

2. **Realtime update within 2s:** A status change made via a direct API call (e.g. `PATCH /api/items/:id/move` via curl or any HTTP client) appears on an open board in the browser within 2 seconds without any user interaction or page reload.

3. **MCP write appears live:** A task status update made via an MCP tool call (Phase 2 path) appears on the open board within 2 seconds. (This is the primary Phase 3 goal.)

4. **SSE heartbeat:** With the browser open for 30+ seconds, the raw SSE stream (DevTools) shows `: heartbeat` lines appearing every ~30 seconds.

5. **Reconnection:** Restarting the server (killing and restarting `pnpm dev`) causes the `ConnectionIndicator` to show briefly, then disappear once `EventSource` reconnects and the board refetches.

6. **No stale data after reconnect:** After a forced disconnect and reconnect, the board reflects the current server state — no phantom items or stale columns.

7. **Drag to another column persists:** Dragging a card from one column to another moves it visually immediately. After releasing, the API call is made. A subsequent manual page refresh confirms the item is in the new column.

8. **Drag failure rolls back:** If the move API call fails (simulate by temporarily breaking the endpoint), the card snaps back to its original column.

9. **Drag writes activity:** After a successful drag-and-drop move, `GET /api/items/:id/activity` returns an entry with `event_type === 'item.moved'`.

10. **ConnectionIndicator is invisible when connected:** The reconnection badge is not visible in the UI under normal operating conditions.

11. **Automated tests pass:** `pnpm --filter server test` exits with code 0. All 12 tests across `eventBus.test.ts` and `sse.test.ts` pass.

---

## What is explicitly out of scope for Phase 3

- Event replay / missed-event recovery on reconnect. Clients refetch on reconnect; no cursor or sequence number is implemented.
- Automated UI tests for drag-and-drop. DnD interaction testing with jsdom is unreliable; the interaction is covered by manual acceptance criteria 7 and 8.
- Per-column drag reordering with precise position gaps (normalisation). Position is a soft sort key; the move endpoint already handles gaps.
- Toast/notification system for API errors during drag. `console.error` is sufficient for Phase 3.
- Any change to the SSE endpoint for Phase 2 MCP writes — Phase 2 MCP tool calls flow through the same route handlers that already emit to the event bus, so they work without any Phase 3 changes.
