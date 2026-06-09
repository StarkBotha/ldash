# ldash

A local-first, Trello-like project planning board for a single developer. The board supports real-time live updates via SSE — any change made through the HTTP API or via the MCP tools (e.g. from Claude Code) appears on an open board within 2 seconds without a page reload. Cards can be dragged between columns with instant optimistic feedback.

## What's here

- **server** — Hono HTTP API backed by SQLite (better-sqlite3). Listens on `127.0.0.1:3000`.
- **ui** — React 19 + Vite SPA. Runs on `localhost:5173` in dev, proxies `/api` to the server.
- Shared TypeScript types in both packages (identical copies; no cross-package dependency needed for Phase 1).

## Running in development

Requires Node 20+ and pnpm.

```bash
# Install all dependencies
pnpm install

# Start server + UI in parallel
pnpm dev
```

The board is at http://localhost:5173. The API is at http://127.0.0.1:3000.

The SQLite database file is created at `./ldash.db` in the working directory when you first start the server. Change the path with the `DB_PATH` env var.

## Running tests

```bash
# Server tests only (vitest, all-green)
pnpm --filter server test

# Or from the root
pnpm test
```

## Building

```bash
pnpm build
```

This runs `tsc` and `vite build` in the ui package, and `tsc` in the server package.

## Project layout

```
ldash/
  package.json           workspace root (scripts only)
  pnpm-workspace.yaml
  tsconfig.base.json     shared strict TS config
  server/
    src/
      index.ts           startup: DB, schema, seed, routes, listen
      db/
        connection.ts    opens the better-sqlite3 Database
        schema.ts        CREATE TABLE IF NOT EXISTS for all tables
        seed.ts          inserts default columns (Backlog, In Progress, Review, Done)
      services/          pure synchronous service classes (one per entity)
      routes/            Hono routers (one per entity group)
      middleware/
        error.ts         global onError handler
      types.ts           shared TypeScript interfaces + EventTypes constants
      __tests__/         vitest test files covering services + HTTP API
  ui/
    src/
      main.tsx           React root + QueryClient
      App.tsx            top-level view switcher (project list vs board)
      api/client.ts      typed fetch wrappers for all API endpoints
      components/        ProjectList, ProjectForm, Board, Column, Card,
                         ItemDetailPanel, CommentBox, ActivityFeed, ItemForm
      hooks/             TanStack Query hooks (useProjects, useBoard, useItemDetail)
      types.ts           copy of server types (identical)
      __tests__/         smoke test for App render
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `DB_PATH` | `./ldash.db` | SQLite database file path |

## Connect Claude Code

After starting the server, register it as an MCP server in Claude Code from within your project repo:

```sh
claude mcp add ldash --transport http http://127.0.0.1:3000/mcp
```

Claude Code will connect to the ldash MCP endpoint and discover nine tools: `ldash_list_projects` to browse available projects, `ldash_list_items` to view board items with optional filters, `ldash_get_item` to read the full detail of an item including comments and recent activity, `ldash_create_item` to file new tasks or stories directly from a session, `ldash_update_item_fields` to revise a title or description, `ldash_update_item_status` to move an item between columns (accepts a column name or id), `ldash_add_comment` to leave a note on an item, `ldash_flag_item` to mark an item for human review, and `ldash_block_item` to record a blocker and the reason for it. All write operations record an activity entry with `actor_type: "claude"` so every change the agent makes is visible in the board's activity feed.

## Features

- Kanban board with projects, epics, stories, and tasks across configurable status columns
- Real-time board updates via Server-Sent Events — changes from the API or MCP tools appear live without page reload
- Drag-and-drop between columns with optimistic UI and automatic rollback on failure
- MCP server at `/mcp` for Claude Code integration — all write operations also fire SSE events so the board stays in sync
- Comments and activity log per item

## Phases

Phase 1: core board. Phase 2: MCP server. Phase 3 (current): realtime SSE + drag-and-drop. Phase 4: LLM chat. Phase 5: planning mode + markdown export.
