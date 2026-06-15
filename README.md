# ldash

**A local-first, Trello-like project planning board with AI built in.** A single Node process owns everything — the HTTP API, a Model Context Protocol (MCP) endpoint, Server-Sent-Events realtime, and an LLM gateway — with SQLite as the single source of truth. The result is a kanban board you run on your own machine that an AI coding agent (like Claude Code) can read and write directly, so the work it does shows up on your board as it happens.

ldash treats the board as a **dashboard of fact**: only the leaf work items you actually do (tasks, bugs, investigations) carry a directly-set status, and the status of the stories and epics above them is *derived* by rolling up their children.

---

## Features

- **Kanban board** with projects and a four-level item hierarchy: epic → story → task/bug/investigation.
- **AI agent integration over MCP** — connect Claude Code (or any MCP client) and it gets 18 `ldash_*` tools to list/create/update items, move statuses, comment, flag, block, and manage a knowledgebase. Every write is attributed and shows up in the activity feed.
- **Realtime updates over SSE** — any change, whether from the UI, the API, or an MCP tool, is pushed live to every open board without a reload.
- **Built-in LLM chat** — a per-item chat panel and a project-level planning chat, backed by your Claude subscription (via the Claude Agent SDK) or any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, …).
- **Per-project knowledgebase** — markdown docs with GitHub-flavored markdown and Mermaid diagram rendering, searchable and managed both from the UI and from MCP tools.
- **Comments and a full activity log** on every item, with each entry attributed to who made it (you, Claude, the planning LLM, or the system).
- **Markdown export** of a project for a human-readable, committable snapshot.
- **Local-first and private** — SQLite file on disk, server bound to `127.0.0.1`. Nothing leaves your machine except the LLM calls you configure.

---

## Tech stack

- **Server** — TypeScript on [Hono](https://hono.dev/) with [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), and the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) for Claude-subscription chat. Validation with [Zod](https://zod.dev/).
- **UI** — [React 19](https://react.dev/) + [Vite](https://vite.dev/) + [TanStack Query](https://tanstack.com/query), with `react-markdown` + `remark-gfm` and lazy-loaded [Mermaid](https://mermaid.js.org/) for the knowledgebase.
- **Storage** — a single SQLite database file. It is the source of truth for everything.
- **Tooling** — pnpm workspaces, TypeScript (strict), Vitest.

---

## Prerequisites

- **Node.js 20+**
- **[pnpm](https://pnpm.io/)**

---

## Getting started

```bash
# Install all dependencies (server + ui workspaces)
pnpm install

# Start the server and the Vite UI together
pnpm dev
```

- The **board UI** is at **http://localhost:5273**.
- The **server** listens on **http://127.0.0.1:3000** by default (override with the `PORT` env var).

On first start the server creates the SQLite database file at `./ldash.db` in its working directory; change the location with `DB_PATH`.

### Build and run for production

```bash
pnpm build   # tsc for the server, tsc + vite build for the ui
pnpm start   # runs the built server (node dist/index.js)
```

> When running the built server, rebuild `dist/` with `tsc` after any server code change — `pnpm start` runs the compiled output, not the source.

### Configuration

| Variable | Default | What it does |
|----------|---------|--------------|
| `PORT` | `3000` | Server listen port (bound to `127.0.0.1`) |
| `DB_PATH` | `./ldash.db` | Path to the SQLite database file |

(A `.env.example` is included with these two.)

To use AI chat, open **Settings** (gear icon, top-right) and add a provider — either a Claude subscription (no API key; uses your existing Claude login) or any OpenAI-compatible endpoint with a base URL and key. API keys are stored locally in SQLite and masked in all API responses.

---

## The status model

This is the load-bearing product decision in ldash, and it's worth understanding before you use it.

- **Item types** are `epic`, `story`, `task`, `bug`, and `investigation`. The last three are *leaf work items* — the actual units of work.
- **Only leaf work items have a directly-set status.** A story's or epic's column is **derived** by rolling up the columns of its descendant leaf items, never set by hand. The board shows you the true state of the work rather than a status someone remembered to update.
- **There is deliberately no drag-and-drop.** A leaf item moves between columns only through an explicit action: an MCP tool, a planning/chat tool call, or the detail-panel dropdown. This keeps every move attributable and intentional.
- **Columns are global** (one shared set, not per-project): **Backlog → In Progress → Review → Done → Cancelled**. The Cancelled column is special — cancelled leaves are excluded from the rollup, so cancelling a task doesn't drag its parent's derived status down. (To cancel work, move it to Cancelled rather than deleting it.)
- Every item gets an **immutable key** like `LDA-12` (a per-project prefix plus a counter). Keys never change, and numbers are never reused.

---

## MCP integration (connect Claude Code)

ldash exposes an MCP server at `/mcp`. With the server running, register it from inside your project repo:

```sh
claude mcp add --transport http ldash http://localhost:<PORT>/mcp
```

(Use the port the server is listening on — `3000` by default.)

Claude Code then gets 18 `ldash_*` tools covering:

- **Items** — list, search, get, create, update fields, and move status.
- **Collaboration** — add and edit comments, flag an item for human review, block an item with a reason.
- **Projects** — list and create.
- **Knowledgebase** — save (upsert by title), get, list, search, and delete per-project markdown docs.

Every write an agent makes is recorded in the activity log attributed to the agent, and fires an SSE event so your open board updates live as the agent works.

---

## Telling your agent to use the board (CLAUDE.md snippet)

MCP gives the agent the *tools*; it doesn't make the agent *use* them. To get an agent like Claude Code to track all its work on ldash automatically, add instructions to your global `CLAUDE.md` (`~/.claude/CLAUDE.md`). Below is the snippet the author uses — copy it into your own `CLAUDE.md` and adjust the URLs/ports to match your setup:

```md
## ldash board tracking — ALL repos, ALL tasks

ldash is my local task board (`ldash_*` MCP tools; server http://localhost:3210, UI http://localhost:5273, runs as a systemd user service). **ALL work must be a ticket — no exceptions.** That includes bugs, investigations/debugging sessions, housekeeping/ops (commits, repo publishing, config changes), and single-step tasks. If you're about to do work and no ticket exists for it, create one first:

- **Project = repo folder name.** At the start of work, `ldash_list_projects` and find the project whose name exactly matches the repo's root folder name (basename of the git root, or of the working directory if not a git repo). If it doesn't exist, create it with `ldash_create_project`.
- **Before starting work** — i.e. BEFORE the first edit/command, not after the work is done — make sure a task item exists for it: find it with `ldash_list_items` or create it with `ldash_create_item` (type `task`; nest under the right story via `parent_id` if a hierarchy exists), then move it to in-progress with `ldash_update_item_status`. Create-the-ticket-first is the rule even for a one-line change: ticket → do the work → comment + move to done. Creating the ticket only at the end (after the edit already landed) is a failure of this rule.
- **When done and verified**, `ldash_add_comment` with what was done (files touched, tests run), then move the task to done.
- **File follow-up work immediately** (bugs, refactors, TODOs discovered along the way) as new tasks with `ldash_create_item` — no mental lists. A bug or an investigation gets its own ticket too, even if you fix it on the spot. If blocked, `ldash_block_item` with the reason.
- **‼️ NOTHING outstanding lives only in chat.** Every single outstanding task, follow-up, open or unanswered question, pending decision, anomaly to verify, and external/blocked dependency (someone else's action, an ops decision, a vendor answer) MUST be logged as an ldash ticket the moment it is identified — use type `investigation` for open questions. If a response mentions anything as "remaining", "open", "to verify", "worth chasing", "needs deciding", or "follow up later" and no ticket exists for it, that is a failure: the user does not track prose, the board is the single source of truth. Before ending any work session, sweep your own summaries for untracked items and ticket them.
- **Only tasks move between columns.** Story/epic status is derived by the server — never try to set it.
- **Column convention — what each status means.** Match the column to the *kind* of remaining work: **In Progress** = engineering work actively in flight; **Review** = engineering is done and verified but it still needs a test/validation on prod (or another final confirmation) before it can be called done — i.e. nothing left to build, just to confirm; **Backlog** = not started, or merely awaiting an external party (vendor/ops/another team) with no active push from us; **Done** = complete and confirmed. A ticket whose only outstanding step is "test it on prod" goes to **Review**, not In Progress or Done.
- If the ldash tools are unavailable (server down), say so once and carry on — don't silently skip tracking.
- For planning a whole body of work onto the board, use the `/ldash-plan` skill.

## ldash knowledgebase — project knowledge lives in ldash, NOT in local files

Each ldash project has a knowledgebase (kb): per-project markdown docs (mermaid diagrams render in the UI), managed via the `ldash_*_kb_doc` MCP tools. **From now on, project knowledge is stored in the ldash kb — not in local `.claude/` knowledge files and not in ad-hoc local `.md` notes files.**

- **Retrieve first**: at the start of work on a project, `ldash_list_kb_docs` (or `ldash_search_kb_docs`) its kb before re-deriving knowledge from scratch; read a doc with `ldash_get_kb_doc` (accepts key, id, or title — case-insensitive).
- **Each doc has an immutable key** like `LDA-KB-1` (project prefix + `KB` + a per-project counter, independent of board ticket numbers). Quote that key to refer to a specific article, the same way you'd cite a ticket like `LDA-51`. `list`/`search` results include the key; `get`/`delete` resolve a doc by it.
- **Store**: `ldash_save_kb_doc` — it UPSERTS by title, so re-saving a title replaces that doc; update the existing doc when facts change rather than creating near-duplicates. Save anything worth keeping: architecture overviews, runbooks, how-tos, hosting/deploy info, gotchas, command references, process diagrams.
- **Cross-project kb access is explicit-only.** Default scope is the current project. Only when I explicitly ask (e.g. "check ProjectX's kb" or "search all KBs"): resolve the project via `ldash_list_projects` and pass its id, or omit `project_id` on `ldash_search_kb_docs` to search every project at once. Never roam other projects' KBs unprompted.
- **Do NOT create local knowledge stores**: no `.claude/CODEBASE.md`, no handoff/session-notes `.md` files, no `NOTES.md`/`docs/commands-*.md`-style knowledge dumps. Exceptions that stay local: `CLAUDE.md` files themselves (harness instructions, not knowledge storage) and real deliverable docs that ship with the repo (README, published docs, specs that are part of the product).
```

---

## Project layout

```
ldash/
  package.json            workspace root (scripts)
  pnpm-workspace.yaml      server + ui workspaces
  tsconfig.base.json       shared strict TS config
  server/
    src/
      index.ts             startup: DB, schema, migrations, routes, listen
      db/                   connection, schema, migrations, seed (default columns)
      routes/               Hono routers (one per resource group)
      services/             all writes go through these service classes
      services/rollup.ts    derives story/epic status from leaf items
      mcp/tools/            the ldash_* MCP tools (items, comments, flags, projects, kb)
      gateway/              LLM gateway + adapters (Claude Agent SDK, OpenAI-compatible)
      planning/             planning-chat system prompt + tools
      events/               event bus (SSE feed)
      export/               markdown export
  ui/
    src/
      components/           Board, Column, Card, detail panel, KnowledgeBase, …
      hooks/useSSE.ts       SSE subscription that invalidates query keys
      api/                  typed fetch client
```

---

## Testing

```bash
pnpm test                  # server test suite (Vitest)
cd ui && npx vitest run    # UI tests (Vitest + Testing Library)
```

---

## License

No license file is currently present in this repository, so the licensing terms are **TBD**. Until a `LICENSE` is added, treat the code as all-rights-reserved.
