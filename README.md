# ldash

A local-first, Trello-like project planning board for a single developer. The board supports real-time live updates via SSE — any change made through the HTTP API or via the MCP tools (e.g. from Claude Code) appears on an open board within 2 seconds without a page reload. Cards can be dragged between columns with instant optimistic feedback. Each item has a built-in chat panel backed by a configurable LLM (Claude subscription, OpenAI, OpenRouter, Ollama, or any OpenAI-compatible API).

## What's here

- **server** — Hono HTTP API backed by SQLite (better-sqlite3). Listens on `127.0.0.1:3000`.
- **ui** — React 19 + Vite SPA. Runs on `localhost:5273` in dev, proxies `/api` to the server.
- Shared TypeScript types in both packages (identical copies; no cross-package dependency needed for Phase 1).

## Running in development

Requires Node 20+ and pnpm.

```bash
# Install all dependencies
pnpm install

# Start server + UI in parallel
pnpm dev
```

The board is at http://localhost:5273. The API is at http://127.0.0.1:3000.

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
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error`, or `silent` |
| `LOG_DIR` | `<cwd>/logs` | Directory for the `ldash.log` file |

## Logging & troubleshooting

The server writes every log entry to two places simultaneously: a human-readable line to stdout and a structured NDJSON line appended to `logs/ldash.log` (relative to the server's working directory). The log file alone is enough to reconstruct what happened during a manual test session.

**Log file location:** `logs/ldash.log` by default. Set `LOG_DIR` to override.

**Full debug trail:** set `LOG_LEVEL=debug` before starting the server. This adds bus emissions, MCP tool arguments, system prompt previews, and user message previews to the log.

**Client errors are captured too.** The browser installs a global `window.onerror` and `unhandledrejection` handler on startup. Any uncaught JS error in the UI is POSTed to `POST /api/client-log` and logged under scope `client`. You'll find these in the same `ldash.log` file.

**What each scope covers:**
- `http` — every HTTP request (method, path, status, duration_ms)
- `sse` — SSE client connect/disconnect with active connection count
- `events` — every event bus emission (debug level)
- `mcp` — every MCP tool call (args at debug, outcome + duration_ms at info, errors at warn)
- `gateway` — LLM adapter selection, per-stream summary, error chunks
- `planning` — tool-loop turns and tool executions
- `chat` — conversation create/fetch, user/assistant message persistence
- `export` — export requests and files written
- `db` — migration runs and startup banner (listening URL, DB path, log file path)
- `client` — uncaught UI errors forwarded from the browser

## Connect Claude Code

After starting the server, register it as an MCP server in Claude Code from within your project repo:

```sh
claude mcp add ldash --transport http http://127.0.0.1:3000/mcp
```

Claude Code will connect to the ldash MCP endpoint and discover nine tools: `ldash_list_projects` to browse available projects, `ldash_list_items` to view board items with optional filters, `ldash_get_item` to read the full detail of an item including comments and recent activity, `ldash_create_item` to file new tasks or stories directly from a session, `ldash_update_item_fields` to revise a title or description, `ldash_update_item_status` to move an item between columns (accepts a column name or id), `ldash_add_comment` to leave a note on an item, `ldash_flag_item` to mark an item for human review, and `ldash_block_item` to record a blocker and the reason for it. All write operations record an activity entry with `actor_type: "claude"` so every change the agent makes is visible in the board's activity feed.

## LLM chat

Each item's detail panel has a Chat tab. The assistant has read-only context about the item: its title, type, status, description, flagged/blocked state, parent item, up to 10 child items, the last 10 comments, and the last 20 activity entries. The context is assembled fresh on every message so it always reflects the current board state.

### Configuring a provider

Click the gear icon (top-right corner) to open Settings. Add one or more providers, set one as active, and click Save.

The model field is a free-text input backed by an autocomplete list. When you open a provider for editing, the server fetches the available models directly from that provider and populates the dropdown suggestions. You can always type any model id by hand — the autocomplete is optional. A hint line below the field shows how many models were loaded, or a note to type the id manually if the fetch failed.

**Claude subscription** — authenticates via your existing Claude Code login (reads the `claude` CLI session). No API key needed. Available models are fetched from `api.anthropic.com/v1/models` when a `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` env var is present; otherwise a built-in list is shown.

```
Name:  My Claude
Type:  claude-subscription
Model: claude-sonnet-4-6
```

**OpenAI**

```
Name:    OpenAI GPT-4o
Type:    openai-compatible
Model:   gpt-4o
BaseURL: https://api.openai.com/v1
APIKey:  sk-...
```

**OpenRouter**

```
Name:    OpenRouter
Type:    openai-compatible
Model:   openai/gpt-4o
BaseURL: https://openrouter.ai/api/v1
APIKey:  sk-or-...
```

**Ollama (local)**

```
Name:    Ollama Llama3
Type:    openai-compatible
Model:   llama3
BaseURL: http://localhost:11434/v1
APIKey:  ollama
```

API keys are stored in the local SQLite database and masked in all API responses (`GET /api/settings` returns `sk-abcd...XXXX`). The full key is never sent to the UI after it is saved.

## Features

- Kanban board with projects, epics, stories, and tasks across configurable status columns
- Real-time board updates via Server-Sent Events — changes from the API or MCP tools appear live without page reload
- Drag-and-drop between columns with optimistic UI and automatic rollback on failure
- MCP server at `/mcp` for Claude Code integration — all write operations also fire SSE events so the board stays in sync
- Comments and activity log per item
- Per-item LLM chat with streaming responses and full item context assembly
- Settings page for provider configuration (Claude subscription, OpenAI-compatible, OpenRouter, Ollama)

## Planning mode

Click the **Plan** button in any project board header to open planning mode. This replaces the board layout with a split view: a full-height AI chat panel on top (roughly 60 % of the viewport) and a live, read-only compact board below (roughly 40 %).

The planning assistant has read access to your project's current state — columns, existing items, and the item hierarchy — injected as context on every turn. Tell it what you want to build. It will ask clarifying questions, propose a breakdown in words, and only call the board tools (`create_item`, `update_item`, `list_items`) once you have agreed. Items created during a planning session appear on the compact board below in real time via the existing SSE stream, with a tool-call indicator line in the chat (e.g. `Creating story: "Implement auth endpoint"`).

All items created by the planning assistant are written with `actor_type: 'llm'` and `actor_id: 'planning-llm'` in the activity log, so you can always distinguish them from items you or Claude Code created.

Click **Close planning mode** to return to the normal kanban board. All items created during the session are already on the board.

Use **Clear history** inside the planning chat to start a fresh conversation; board items previously created are not removed.

## Markdown export

Click the **Export** button in any project board header to generate a markdown snapshot of the project. The export is written synchronously to `exports/<project-slug>/` relative to the server's working directory:

- `README.md` — project overview listing all epics with links
- `epic-<slug>/README.md` — one file per epic, containing its stories and tasks with status labels
- `orphans.md` — any stories or tasks whose parent item no longer exists (only present if orphans exist)

Running the export again overwrites the existing files. The files are derived from the database state and are never read back by the server — treat them as disposable snapshots you can commit, share, or delete.

## How it all fits together

The workflow moves in one direction and each layer builds on the previous one:

1. **Plan with AI** — Open planning mode on a project, describe what you want to build, and let the assistant break it down into epics, stories, and tasks. It populates the board while you talk.

2. **Board** — Everything lands on the kanban board with drag-and-drop columns (Backlog, In Progress, Review, Done). You can create, edit, move, flag, and block items at any time.

3. **Connect Claude Code via MCP** — Register the server as an MCP endpoint (`claude mcp add ldash --transport http http://127.0.0.1:3000/mcp`). Claude Code can then read and write board items during a coding session — filing tasks it discovers, updating statuses as it completes work, and leaving comments on items.

4. **Watch realtime** — Any change — from the UI, from Claude Code, or from the planning assistant — triggers an SSE event. All open browser tabs update the board within 2 seconds without a page reload.

5. **Chat per task** — Open any item's detail panel and use the Chat tab to ask about that specific item. The assistant receives the full item context (title, status, comments, activity, children) on every message.

6. **Export** — When a planning sprint is complete, export the project to markdown for a human-readable record you can commit alongside the code.

## Phases

Phase 1: core board. Phase 2: MCP server. Phase 3: realtime SSE + drag-and-drop. Phase 4: LLM chat + provider gateway. Phase 5 (current): planning mode + markdown export.
