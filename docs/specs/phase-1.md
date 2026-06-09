# ldash — Phase 1 Implementation Spec

## Decisions made in this spec

The architecture doc defers exact framework choices to this spec. Here are the concrete calls made and the reasoning behind each.

**HTTP server: Hono.** Runs natively on Node with a plain `node` adapter, has zero opinions about project structure, is TypeScript-first, and stays out of the way. Express is also acceptable but Hono has better typed request/response helpers and will be easier to extend with SSE in Phase 3.

**Frontend: React 19 + Vite + TanStack Query.** React is the safest "boring, well-known" choice; Vite gives fast dev builds; TanStack Query handles server-state caching and refetching without a heavy store. No Redux, no Zustand — React state plus TanStack Query is enough for Phase 1.

**SQLite driver: better-sqlite3.** Synchronous API, excellent performance, battle-tested, easy to use from TypeScript. No ORM — raw SQL throughout so schema control is explicit.

**Drag-and-drop: deferred to Phase 3.** Phase 1 uses a simple status-dropdown on the card detail panel to move items between columns. This avoids pulling in a DnD library before realtime (Phase 3) is in place, since DnD without optimistic updates and SSE reconciliation would feel broken. The decision is noted and the architecture is left clean for it.

**Monorepo layout: pnpm workspaces with two packages — `server` and `ui`.** This keeps backend and frontend TypeScript configs separate (Node vs. browser targets) while sharing the `types` directory for API contract types.

**Item hierarchy flattened into one table.** Epics, stories, and tasks all live in the `items` table with a `type` column and a nullable `parent_id` self-reference. This is simpler than three separate tables and the schema sketch in the architecture doc treats them uniformly ("any item" can have comments, activity, etc.).

**Conversation and message tables: deferred.** The architecture doc places LLM chat in Phase 4. These tables are not created in Phase 1.

**Activity log actor: string field `actor_type` + `actor_id`.** The architecture doc's open question about distinct actor identity is resolved conservatively: every activity row carries an `actor_type` (either `"user"` or `"claude"`) and an `actor_id` (a free string — `"user"` for manual UI actions, the MCP client id or `"claude-code"` for MCP writes in later phases). This costs one column and eliminates the ambiguity later phases would need to resolve.

**No authentication.** The architecture doc explicitly rules it out. The server binds to `127.0.0.1` only.

**Column/status seeding.** On first run the server creates a default set of columns: `Backlog`, `In Progress`, `Review`, `Done`. Users can reorder and rename columns via the API; they cannot be deleted if items still reference them.

---

## Project layout

```
ldash/
  package.json            # pnpm workspace root — scripts only, no production code
  pnpm-workspace.yaml
  tsconfig.base.json      # shared TS config (strict, ES2022 target)
  .env.example
  server/
    package.json
    tsconfig.json
    src/
      index.ts            # entry point — creates DB, wires app, starts server
      db/
        schema.ts         # CREATE TABLE statements executed on startup
        connection.ts     # opens and exports the better-sqlite3 Database instance
        seed.ts           # inserts default columns if columns table is empty
      services/
        projects.ts       # ProjectService — all project mutations and queries
        items.ts          # ItemService — all item mutations and queries
        columns.ts        # ColumnService — column mutations and queries
        comments.ts       # CommentService — comment mutations and queries
        activity.ts       # ActivityService — append and query activity log
      routes/
        projects.ts       # Hono router for /api/projects
        items.ts          # Hono router for /api/items
        columns.ts        # Hono router for /api/columns
        comments.ts       # Hono router for /api/comments
        activity.ts       # Hono router for /api/activity
      middleware/
        error.ts          # global error handler middleware
      types.ts            # shared TypeScript types mirrored from DB rows
  ui/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.tsx            # React root, TanStack Query client setup
      App.tsx             # top-level router (project list vs board view)
      api/
        client.ts         # typed fetch wrappers for every API endpoint
      components/
        ProjectList.tsx
        ProjectForm.tsx   # create/edit project modal
        Board.tsx         # kanban board — columns and cards
        Column.tsx        # a single status column
        Card.tsx          # a single item card
        ItemDetailPanel.tsx # slide-in drawer: description, status dropdown, comments, activity
        CommentBox.tsx    # new comment textarea + submit
        ActivityFeed.tsx  # list of activity entries for an item
        ItemForm.tsx      # create/edit item modal
      hooks/
        useProjects.ts    # TanStack Query hooks for project CRUD
        useBoard.ts       # TanStack Query hooks for items + columns
        useItemDetail.ts  # hooks for comments + activity for one item
      types.ts            # mirrors server/src/types.ts — copy or share via path alias
```

### Root `package.json` scripts

```json
{
  "scripts": {
    "dev": "pnpm --parallel -r dev",
    "build": "pnpm -r build",
    "start": "pnpm --filter server start"
  }
}
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - "server"
  - "ui"
```

### `server/package.json` key fields

```json
{
  "name": "ldash-server",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc --project tsconfig.json",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@hono/node-server": "^1.x",
    "better-sqlite3": "^9.x",
    "hono": "^4.x",
    "nanoid": "^5.x"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.x",
    "@types/node": "^22.x",
    "tsx": "^4.x",
    "typescript": "^5.x"
  }
}
```

### `ui/package.json` key fields

```json
{
  "name": "ldash-ui",
  "type": "module",
  "scripts": {
    "dev": "vite --port 5173",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.x",
    "react": "^19.x",
    "react-dom": "^19.x"
  },
  "devDependencies": {
    "@types/react": "^19.x",
    "@types/react-dom": "^19.x",
    "@vitejs/plugin-react": "^4.x",
    "typescript": "^5.x",
    "vite": "^6.x"
  }
}
```

Vite dev server proxies `/api` to `http://localhost:3000` so the UI never deals with CORS in development.

```ts
// vite.config.ts
server: {
  proxy: {
    "/api": "http://localhost:3000"
  }
}
```

---

## SQLite schema

All tables are created in `server/src/db/schema.ts` and executed via `db.exec(sql)` on startup. The schema uses `IF NOT EXISTS` throughout so re-running is safe.

```sql
-- Columns (board statuses). Order is explicit.
CREATE TABLE IF NOT EXISTS columns (
  id         TEXT PRIMARY KEY,          -- nanoid
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL,          -- 0-based, determines left-to-right order
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Projects. Top-level containers.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,         -- nanoid
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Items — epics, stories, tasks unified in one table.
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,         -- nanoid
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES items(id) ON DELETE SET NULL,
                                        -- NULL = top-level epic; set = story under epic, or task under story/epic
  type        TEXT NOT NULL CHECK (type IN ('epic', 'story', 'task')),
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  column_id   TEXT NOT NULL REFERENCES columns(id),
  position    INTEGER NOT NULL DEFAULT 0,
                                        -- sort order within the same column (lower = higher on board)
  flagged     INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
  blocked     INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  blocked_reason TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id);
CREATE INDEX IF NOT EXISTS idx_items_column  ON items(column_id);
CREATE INDEX IF NOT EXISTS idx_items_parent  ON items(parent_id);

-- Comments. Attached to any item. Author is free text for Phase 1.
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,          -- nanoid
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT 'user',
                                        -- 'user' in Phase 1; 'claude-code' or MCP actor in later phases
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);

-- Activity log. Append-only. Never updated or deleted.
CREATE TABLE IF NOT EXISTS activity (
  id          TEXT PRIMARY KEY,         -- nanoid
  item_id     TEXT REFERENCES items(id) ON DELETE SET NULL,
                                        -- NULL when the event is project-level (project created/renamed)
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor_type  TEXT NOT NULL DEFAULT 'user'
                CHECK (actor_type IN ('user', 'claude')),
  actor_id    TEXT NOT NULL DEFAULT 'user',
                                        -- 'user' for UI actions; 'claude-code' or client id for MCP (Phase 2+)
  event_type  TEXT NOT NULL,            -- see Event types section below
  payload     TEXT NOT NULL DEFAULT '{}',
                                        -- JSON string: the fields that changed, old/new values
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_item    ON activity(item_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
```

### Deferred tables (not created in Phase 1)

`conversations` and `messages` are Phase 4 additions. Do not create them now. Document this with a comment in `schema.ts`.

### Default column seed (`server/src/db/seed.ts`)

On startup, if `SELECT COUNT(*) FROM columns` returns 0, insert:

| position | name |
|---|---|
| 0 | Backlog |
| 1 | In Progress |
| 2 | Review |
| 3 | Done |

Each gets a nanoid. This runs inside a transaction.

---

## Activity event types

These are the string literals used in `activity.event_type`. Define them as a TypeScript union and as a constant object in `server/src/types.ts`.

| event_type | Triggered by | Payload fields |
|---|---|---|
| `project.created` | POST /api/projects | `{ name }` |
| `project.updated` | PATCH /api/projects/:id | `{ fields: { old, new } }` |
| `project.deleted` | DELETE /api/projects/:id | `{ name }` |
| `item.created` | POST /api/items | `{ title, type, column_id }` |
| `item.updated` | PATCH /api/items/:id (non-status fields) | `{ fields: { old, new } }` |
| `item.moved` | PATCH /api/items/:id/move | `{ from_column_id, to_column_id, from_column_name, to_column_name }` |
| `item.deleted` | DELETE /api/items/:id | `{ title, type }` |
| `item.flagged` | PATCH /api/items/:id/flag | `{ flagged: true }` |
| `item.unflagged` | PATCH /api/items/:id/flag | `{ flagged: false }` |
| `item.blocked` | PATCH /api/items/:id/block | `{ blocked: true, reason }` |
| `item.unblocked` | PATCH /api/items/:id/block | `{ blocked: false }` |
| `comment.created` | POST /api/comments | `{ comment_id, author }` |
| `column.created` | POST /api/columns | `{ name }` |
| `column.updated` | PATCH /api/columns/:id | `{ fields: { old, new } }` |
| `column.reordered` | POST /api/columns/reorder | `{ order: [id, ...] }` |

The `payload` column stores these objects JSON-serialised.

---

## TypeScript types (`server/src/types.ts` and `ui/src/types.ts` — identical)

```ts
export type ItemType = 'epic' | 'story' | 'task';
export type ActorType = 'user' | 'claude';

export interface Column {
  id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: ItemType;
  title: string;
  description: string;
  column_id: string;
  position: number;
  flagged: boolean;
  blocked: boolean;
  blocked_reason: string;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  item_id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface ActivityEntry {
  id: string;
  item_id: string | null;
  project_id: string | null;
  actor_type: ActorType;
  actor_id: string;
  event_type: string;
  payload: Record<string, unknown>;  // parsed from JSON on read
  created_at: string;
}
```

SQLite stores `flagged` and `blocked` as integers (0/1). The service layer converts them to booleans before returning. `payload` is stored as a JSON string and parsed to an object on read.

---

## HTTP API specification

The server listens on `127.0.0.1:3000`. All request and response bodies are `application/json`. All timestamps are ISO-8601 strings in UTC. Errors follow a standard shape:

```json
{ "error": "Human-readable message" }
```

HTTP status codes used:

- `200` — successful read or update
- `201` — successful creation
- `204` — successful deletion (empty body)
- `400` — validation failure (missing required field, bad value)
- `404` — resource not found
- `409` — conflict (e.g. deleting a column that still has items)
- `500` — unexpected server error

---

### Columns — `GET /api/columns`

Returns all columns ordered by `position` ascending.

**Response `200`:**
```json
[
  { "id": "...", "name": "Backlog", "position": 0, "created_at": "...", "updated_at": "..." },
  ...
]
```

---

### Columns — `POST /api/columns`

Creates a new column. Appended at the end (position = current max + 1).

**Request body:**
```json
{ "name": "string (required, non-empty)" }
```

**Response `201`:** the created `Column` object.

**Errors:** `400` if `name` is missing or empty.

Writes `column.created` activity entry (project_id null, item_id null).

---

### Columns — `PATCH /api/columns/:id`

Renames a column.

**Request body:**
```json
{ "name": "string (required, non-empty)" }
```

**Response `200`:** the updated `Column` object.

**Errors:** `404` if column not found. `400` if `name` is missing or empty.

Writes `column.updated` activity entry.

---

### Columns — `DELETE /api/columns/:id`

Deletes a column.

**Errors:** `404` if not found. `409` if any items currently reference this column. The error message must say "Column has items; move them first."

No activity entry on deletion (columns are infrastructure, not plan items).

**Response `204`:** empty body.

---

### Columns — `POST /api/columns/reorder`

Sets the order of all columns at once. Every existing column id must be present in the array.

**Request body:**
```json
{ "order": ["col-id-1", "col-id-2", "col-id-3"] }
```

Assigns `position` = array index (0-based) to each column in a single transaction.

**Errors:** `400` if `order` is missing, not an array, contains unknown ids, or does not include all existing column ids.

**Response `200`:** the full updated column list, ordered by new position.

Writes `column.reordered` activity entry.

---

### Projects — `GET /api/projects`

Returns all projects ordered by `created_at` ascending.

**Response `200`:** array of `Project` objects.

---

### Projects — `POST /api/projects`

Creates a project.

**Request body:**
```json
{
  "name": "string (required, non-empty)",
  "description": "string (optional, defaults to empty string)"
}
```

**Response `201`:** the created `Project`.

**Errors:** `400` if `name` is missing or empty.

Writes `project.created` activity entry (item_id null).

---

### Projects — `GET /api/projects/:id`

Returns a single project.

**Response `200`:** a `Project` object.

**Errors:** `404` if not found.

---

### Projects — `PATCH /api/projects/:id`

Updates a project's name and/or description. Only the fields present in the body are changed.

**Request body (all optional, but at least one required):**
```json
{
  "name": "string",
  "description": "string"
}
```

**Response `200`:** the full updated `Project`.

**Errors:** `400` if body is empty or contains no recognized fields. `404` if not found.

Writes `project.updated` activity entry with old/new values for changed fields.

---

### Projects — `DELETE /api/projects/:id`

Deletes a project. All items, comments, and activity entries belonging to the project are cascade-deleted by the database foreign key.

**Response `204`:** empty body.

**Errors:** `404` if not found.

Writes `project.deleted` activity entry before deletion executes (so the entry's `project_id` is still valid at write time). Because the deletion cascades, the activity entry's `project_id` will be `NULL` after the cascade fires — this is acceptable; the payload still contains the project name for human-readable context.

---

### Items — `GET /api/projects/:projectId/items`

Returns all items for a project. Does not filter by column or type; the UI does its own grouping.

**Response `200`:** array of `Item` objects, ordered by `column_id ASC, position ASC`.

**Errors:** `404` if the project is not found.

---

### Items — `POST /api/items`

Creates an item.

**Request body:**
```json
{
  "project_id": "string (required)",
  "parent_id": "string | null (optional, defaults to null)",
  "type": "'epic' | 'story' | 'task' (required)",
  "title": "string (required, non-empty)",
  "description": "string (optional, defaults to '')",
  "column_id": "string (required)"
}
```

Validation rules:
- `project_id` must reference an existing project. `404` if not.
- `column_id` must reference an existing column. `400` if not.
- `parent_id` (if provided) must reference an existing item in the same project. `400` if not.
- `type` must be one of `epic`, `story`, `task`. `400` otherwise.
- `title` must be non-empty. `400` otherwise.

`position` is auto-assigned: `SELECT COALESCE(MAX(position), -1) + 1 FROM items WHERE column_id = ? AND project_id = ?`.

**Response `201`:** the created `Item`.

Writes `item.created` activity entry with `project_id` and `item_id` set.

---

### Items — `GET /api/items/:id`

Returns a single item.

**Response `200`:** an `Item` object.

**Errors:** `404` if not found.

---

### Items — `PATCH /api/items/:id`

Updates editable fields: `title`, `description`, `parent_id`. Does not handle status moves or flag/block (those have dedicated endpoints). Only fields present in the body are changed.

**Request body (all optional, at least one required):**
```json
{
  "title": "string",
  "description": "string",
  "parent_id": "string | null"
}
```

**Errors:** `404` if not found. `400` if body is empty or contains no recognized fields. `400` if `parent_id` references a nonexistent item or an item in a different project.

**Response `200`:** the full updated `Item`.

Writes `item.updated` activity entry with old/new values for changed fields.

---

### Items — `PATCH /api/items/:id/move`

Moves an item to a different column and/or a new position within that column. This is the endpoint the status-dropdown on the card detail panel calls.

**Request body:**
```json
{
  "column_id": "string (required)",
  "position": "integer (optional)"
}
```

If `position` is omitted, the item is placed at the end of the target column (same auto-assign logic as creation).

If `column_id` is the same as the item's current column and `position` is provided, this is a reorder within the column.

This endpoint does NOT repack or normalise other items' positions. Position is a soft sort key; gaps are acceptable. The UI may call this endpoint with an explicit position when implementing future drag-and-drop.

**Errors:** `404` if item not found. `400` if `column_id` does not exist.

**Response `200`:** the full updated `Item`.

Writes `item.moved` activity entry. If the column did not change (position-only reorder), still write the entry but set `from_column_id == to_column_id`.

---

### Items — `PATCH /api/items/:id/flag`

Sets or clears the `flagged` state.

**Request body:**
```json
{ "flagged": true | false }
```

**Errors:** `404` if not found. `400` if `flagged` is not a boolean.

**Response `200`:** the full updated `Item`.

Writes `item.flagged` or `item.unflagged` activity entry.

---

### Items — `PATCH /api/items/:id/block`

Sets or clears the `blocked` state with an optional reason.

**Request body:**
```json
{
  "blocked": true | false,
  "reason": "string (required when blocked=true, ignored when blocked=false)"
}
```

When `blocked` is `false`, `blocked_reason` is set to `''` in the database regardless of what was passed.

**Errors:** `404` if not found. `400` if `blocked` is not a boolean. `400` if `blocked` is `true` and `reason` is missing or empty.

**Response `200`:** the full updated `Item`.

Writes `item.blocked` or `item.unblocked` activity entry.

---

### Items — `DELETE /api/items/:id`

Deletes an item. All comments referencing the item are cascade-deleted. Child items (those with `parent_id` pointing to this item) have their `parent_id` set to `NULL` (ON DELETE SET NULL in the schema — they become orphaned top-level items rather than disappearing).

**Response `204`:** empty body.

**Errors:** `404` if not found.

Writes `item.deleted` activity entry before deletion.

---

### Comments — `GET /api/items/:itemId/comments`

Returns all comments for an item, ordered by `created_at` ascending.

**Response `200`:** array of `Comment` objects.

**Errors:** `404` if the item does not exist.

---

### Comments — `POST /api/comments`

Creates a comment on an item.

**Request body:**
```json
{
  "item_id": "string (required)",
  "body": "string (required, non-empty)",
  "author": "string (optional, defaults to 'user')"
}
```

**Errors:** `400` if `item_id` or `body` is missing/empty. `404` if `item_id` does not reference an existing item.

**Response `201`:** the created `Comment`.

Writes `comment.created` activity entry on the item.

---

### Comments — `DELETE /api/comments/:id`

Deletes a comment.

**Response `204`:** empty body.

**Errors:** `404` if not found.

No activity entry on comment deletion (comments are user-editable scratch; deletion is not a plan state change).

---

### Activity — `GET /api/projects/:projectId/activity`

Returns the activity log for a project (all entries where `project_id` matches, including item-level events for items within the project). Ordered by `created_at` descending (newest first).

**Query parameters:**
- `limit` — integer, default 50, max 200.
- `before` — ISO timestamp; return entries with `created_at < before` (for pagination).

**Response `200`:**
```json
{
  "entries": [ /* ActivityEntry[] */ ],
  "next_before": "ISO timestamp or null"
}
```

`next_before` is the `created_at` of the last entry in the current page, or `null` if the page is smaller than `limit` (end of log).

**Errors:** `404` if project not found.

---

### Activity — `GET /api/items/:itemId/activity`

Returns activity entries scoped to a single item, ordered by `created_at` descending.

**Query parameters:** same `limit` and `before` as above.

**Response `200`:** same shape as project-level activity endpoint.

**Errors:** `404` if item not found.

---

## Service layer contracts

Every service lives in `server/src/services/`. All methods are synchronous (better-sqlite3 is synchronous). They throw typed errors that the route layer catches. No service calls another service — all cross-entity logic (e.g. checking a project exists before creating an item) happens in the route handler, which calls the relevant services in sequence.

The service layer is designed so Phase 3 can add an event bus hook here with no route changes: the route handler calls the service, then emits an event. The service itself does not emit.

### `ProjectService`

```ts
class ProjectService {
  constructor(db: Database) {}

  list(): Project[]
  // SELECT * FROM projects ORDER BY created_at ASC

  get(id: string): Project | undefined
  // SELECT * FROM projects WHERE id = ?

  create(data: { name: string; description?: string }): Project
  // INSERT; returns the new row

  update(id: string, data: Partial<{ name: string; description: string }>): Project
  // UPDATE only provided fields; refreshes updated_at; returns full row

  delete(id: string): void
  // DELETE; cascades via DB foreign key
}
```

### `ColumnService`

```ts
class ColumnService {
  constructor(db: Database) {}

  list(): Column[]
  // SELECT * FROM columns ORDER BY position ASC

  get(id: string): Column | undefined

  create(data: { name: string }): Column
  // position = MAX(position) + 1; INSERT

  update(id: string, data: { name: string }): Column
  // UPDATE name and updated_at

  reorder(orderedIds: string[]): Column[]
  // In a transaction: UPDATE columns SET position = idx WHERE id = orderedIds[idx] for each
  // Returns updated list ordered by new position

  delete(id: string): void
  // Caller must have already verified no items reference this column
}
```

### `ItemService`

```ts
class ItemService {
  constructor(db: Database) {}

  listByProject(projectId: string): Item[]
  // SELECT * FROM items WHERE project_id = ? ORDER BY column_id ASC, position ASC

  get(id: string): Item | undefined

  create(data: {
    project_id: string;
    parent_id?: string | null;
    type: ItemType;
    title: string;
    description?: string;
    column_id: string;
  }): Item
  // position = MAX(position)+1 in same project+column; INSERT

  update(id: string, data: Partial<{ title: string; description: string; parent_id: string | null }>): Item
  // UPDATE only provided fields; refresh updated_at

  move(id: string, data: { column_id: string; position?: number }): Item
  // UPDATE column_id and position; if position omitted use MAX(position)+1 in target column

  setFlag(id: string, flagged: boolean): Item
  // UPDATE flagged, updated_at

  setBlock(id: string, blocked: boolean, reason: string): Item
  // UPDATE blocked, blocked_reason, updated_at

  delete(id: string): void
  // DELETE; child items' parent_id set to NULL by DB (ON DELETE SET NULL)
}
```

### `CommentService`

```ts
class CommentService {
  constructor(db: Database) {}

  listByItem(itemId: string): Comment[]
  // SELECT * FROM comments WHERE item_id = ? ORDER BY created_at ASC

  create(data: { item_id: string; body: string; author?: string }): Comment
  // INSERT; author defaults to 'user'

  delete(id: string): void
}
```

### `ActivityService`

```ts
class ActivityService {
  constructor(db: Database) {}

  append(data: {
    item_id?: string | null;
    project_id?: string | null;
    actor_type?: ActorType;
    actor_id?: string;
    event_type: string;
    payload?: Record<string, unknown>;
  }): ActivityEntry
  // INSERT; returns the new row with payload parsed back to object

  listByProject(projectId: string, opts: { limit: number; before?: string }): ActivityEntry[]
  // SELECT WHERE project_id = ? [AND created_at < before] ORDER BY created_at DESC LIMIT limit

  listByItem(itemId: string, opts: { limit: number; before?: string }): ActivityEntry[]
  // SELECT WHERE item_id = ? [AND created_at < before] ORDER BY created_at DESC LIMIT limit
}
```

---

## Error handling

`server/src/middleware/error.ts` exports a Hono `onError` handler. It catches any thrown `Error` and returns `{ error: err.message }` with status 500. Route handlers throw standard `Error` instances with a `status` property (a simple convention — no fancy error class needed):

```ts
// in a route handler
const err = new Error('Project not found') as any;
err.status = 404;
throw err;
```

The error middleware checks `err.status` and uses it if present, otherwise defaults to 500.

---

## UI scope and component behaviour

### Phase 1 UI summary

The UI is a single-page app with two views: the project list and the board for a selected project. No routing library is required — a single piece of React state (`selectedProjectId`) controls which view is shown.

There is no drag-and-drop in Phase 1. Moving an item between columns is done via a status dropdown in the item detail panel.

All server communication uses typed fetch wrappers in `ui/src/api/client.ts`. TanStack Query manages caching and refetching. On mutation success, the relevant query is invalidated so the board re-fetches fresh data.

### `ProjectList`

Displays all projects as clickable cards. Has a "New project" button that opens `ProjectForm`. Clicking a project card sets `selectedProjectId` and shows `Board`. Each card has a delete button (with a confirmation `window.confirm` before calling DELETE).

### `ProjectForm`

A modal overlay with inputs for `name` (required) and `description` (optional textarea). Submits POST (create) or PATCH (edit). Closes on success or on an explicit cancel button.

### `Board`

Fetches columns (`GET /api/columns`) and items (`GET /api/projects/:projectId/items`). Renders one `Column` component per column, ordered by `position`. Passes each column's items (filtered client-side) to `Column`. Has a "New item" button that opens `ItemForm` pre-set to the first column. Displays the project name as a heading with an edit button.

### `Column`

Renders its items as `Card` components ordered by `position`. Displays the column name and item count. Has a "+" button to create a new item in this column (opens `ItemForm` with `column_id` pre-set).

### `Card`

Displays item title, type badge (`epic` / `story` / `task`), flagged indicator (a yellow flag icon or coloured border), and blocked indicator (a red blocked badge). Clicking the card opens `ItemDetailPanel` for that item.

### `ItemForm`

A modal with fields: `title` (text input, required), `type` (select: epic / story / task), `description` (textarea), `parent_id` (optional select populated with items of compatible type from the same project — any item can be selected as parent in Phase 1, no type hierarchy enforcement), `column_id` (select pre-filled). Submits POST to create or PATCH to edit.

### `ItemDetailPanel`

A slide-in drawer (fixed right panel). Shows:
- Item title (editable inline on click, or via an edit button opening `ItemForm`).
- Type badge.
- Status dropdown: a `<select>` populated with all columns. On change, calls `PATCH /api/items/:id/move`. On success, invalidates the board query.
- Flag toggle button: calls `PATCH /api/items/:id/flag`.
- Block toggle: a button that when clicked shows a small textarea for reason if enabling, then calls `PATCH /api/items/:id/block`.
- Description (rendered as plain text; editable via edit button).
- `CommentBox` component.
- `ActivityFeed` component.
- A delete button (with `window.confirm`) that calls DELETE and closes the panel.

### `CommentBox`

A textarea and a "Post" button. On submit, calls `POST /api/comments`. On success, clears the textarea and invalidates the comments query for the item.

### `ActivityFeed`

Fetches `GET /api/items/:itemId/activity`. Renders entries as a chronological list (oldest first in the UI — reverse the descending API response). Each entry shows: actor, event type translated to a human sentence (e.g. `item.moved` → "Moved from Backlog to In Progress"), and relative timestamp. Pagination is not required in Phase 1; fetch with the default limit of 50.

---

## `server/src/index.ts` — startup sequence

1. Open the SQLite database file (`./ldash.db` relative to the working directory, configurable via `DB_PATH` env var).
2. Run `schema.ts` (all CREATE TABLE IF NOT EXISTS).
3. Run `seed.ts` (insert default columns if none exist).
4. Instantiate all services, passing the `db` instance.
5. Create the Hono app.
6. Register all route modules, passing service instances.
7. Register the error middleware.
8. Start listening on `127.0.0.1:3000` (port configurable via `PORT` env var).
9. Log `ldash listening on http://127.0.0.1:3000` to stdout.

---

## Acceptance criteria

These are the verifiable behaviours a test agent can check after running `pnpm dev`.

### Projects

1. `GET /api/projects` returns `200` with an empty array on a fresh database.
2. `POST /api/projects` with `{ "name": "My Project" }` returns `201` with a `Project` object that includes a non-empty `id`, `name === "My Project"`, `description === ""`, and valid `created_at` / `updated_at` timestamps.
3. `POST /api/projects` with a missing `name` field returns `400`.
4. `POST /api/projects` with `{ "name": "" }` returns `400`.
5. `GET /api/projects/:id` returns `200` with the project after creation.
6. `GET /api/projects/:nonexistent` returns `404`.
7. `PATCH /api/projects/:id` with `{ "name": "Renamed" }` returns `200` with updated `name` and a new `updated_at`.
8. `PATCH /api/projects/:id` with an empty body returns `400`.
9. `DELETE /api/projects/:id` returns `204`. A subsequent `GET /api/projects/:id` returns `404`.
10. After `POST /api/projects`, `GET /api/projects/:projectId/activity` includes an entry with `event_type === "project.created"`.

### Columns

11. `GET /api/columns` on a fresh database returns exactly 4 columns: Backlog, In Progress, Review, Done in that order.
12. `POST /api/columns` with `{ "name": "QA" }` returns `201` with a `Column` object and `position` equal to 4 (end of list).
13. `POST /api/columns` with missing `name` returns `400`.
14. `PATCH /api/columns/:id` with `{ "name": "In Review" }` returns `200` with updated `name`.
15. `POST /api/columns/reorder` with a valid reordered id array returns `200` with columns in new order.
16. `POST /api/columns/reorder` with a missing id returns `400`.
17. `DELETE /api/columns/:id` when the column has no items returns `204`.
18. `DELETE /api/columns/:id` when the column has items returns `409` with a message containing "move them first".

### Items

19. `POST /api/items` with valid fields returns `201` with an `Item` whose `id` is set, `position` is `0` (first item in column), and `flagged === false`, `blocked === false`.
20. `POST /api/items` with a nonexistent `project_id` returns `404`.
21. `POST /api/items` with a nonexistent `column_id` returns `400`.
22. `POST /api/items` with an invalid `type` value returns `400`.
23. `POST /api/items` with missing `title` returns `400`.
24. A second item created in the same project and column gets `position === 1`.
25. `GET /api/projects/:projectId/items` returns all items for the project, ordered by column then position.
26. `GET /api/items/:id` returns the item.
27. `GET /api/items/:nonexistent` returns `404`.
28. `PATCH /api/items/:id` with `{ "title": "New Title" }` returns `200` with updated title and refreshed `updated_at`.
29. `PATCH /api/items/:id/move` with a different `column_id` returns `200` with the new `column_id`. A subsequent `GET /api/items/:id` confirms the change.
30. `PATCH /api/items/:id/move` writes an `item.moved` activity entry.
31. `PATCH /api/items/:id/flag` with `{ "flagged": true }` returns `200` with `flagged === true` and writes an `item.flagged` activity entry.
32. `PATCH /api/items/:id/flag` with `{ "flagged": false }` returns `200` with `flagged === false` and writes an `item.unflagged` activity entry.
33. `PATCH /api/items/:id/block` with `{ "blocked": true, "reason": "Waiting on design" }` returns `200` with `blocked === true` and `blocked_reason === "Waiting on design"`.
34. `PATCH /api/items/:id/block` with `{ "blocked": true }` and no `reason` returns `400`.
35. `PATCH /api/items/:id/block` with `{ "blocked": false }` returns `200` with `blocked === false` and `blocked_reason === ""`.
36. `DELETE /api/items/:id` returns `204`. A subsequent `GET /api/items/:id` returns `404`.
37. Deleting an item sets `parent_id` to `null` on its child items rather than deleting them.
38. Creating an item writes an `item.created` activity entry retrievable from `GET /api/items/:itemId/activity`.

### Comments

39. `POST /api/comments` with `{ "item_id": "...", "body": "Looks good" }` returns `201` with a `Comment` object including a non-empty `id`, `author === "user"`, and the correct `body`.
40. `POST /api/comments` with an empty `body` returns `400`.
41. `POST /api/comments` with a nonexistent `item_id` returns `404`.
42. `GET /api/items/:itemId/comments` returns comments ordered oldest-first.
43. `DELETE /api/comments/:id` returns `204`. The comment no longer appears in subsequent list responses.
44. Creating a comment writes a `comment.created` activity entry on the item.

### Activity feed

45. `GET /api/projects/:projectId/activity` returns entries with newest first.
46. `GET /api/projects/:projectId/activity?limit=2` returns at most 2 entries.
47. `GET /api/projects/:projectId/activity?limit=2` returns a `next_before` value when more entries exist.
48. Passing `before=<next_before>` to a subsequent request returns the next page of entries with no overlap.
49. `GET /api/projects/:nonexistent/activity` returns `404`.
50. `GET /api/items/:itemId/activity` returns only entries for that item.

### UI smoke checks

51. The project list renders on load and shows a "New project" button.
52. Creating a project via the form causes it to appear in the list without a page reload.
53. Clicking a project opens the board view showing the 4 default columns.
54. Creating an item via the "+" button on a column causes the card to appear in that column.
55. Opening a card shows the item detail panel with the status dropdown and the correct current column selected.
56. Changing the status dropdown on the detail panel moves the card to the chosen column on the next board fetch.
57. Posting a comment via `CommentBox` causes the comment to appear in the panel.
58. The activity feed in the detail panel shows at least the `item.created` entry for a newly created item.
