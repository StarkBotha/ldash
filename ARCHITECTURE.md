# ldash — Architecture

## Goal

A local-first, Trello-like project planning board for a single developer, with an LLM woven into planning and per-task chat, where Claude Code acts as a worker that reads and updates the board over MCP and the user watches it change in realtime.

## Boundaries

ldash **owns**: the project/board data model and its local store, an HTTP API over that data, a realtime push channel to the UI, an MCP endpoint that exposes board operations as tools, and an LLM gateway that brokers chat to a chosen provider. The board is the single source of truth for project planning state.

ldash does **not** own: the developer's code repo, the actual coding work (Claude Code does that in the repo), git/CI, any cloud account, user identity/auth, or multi-user collaboration. It does not embed Claude Code — Claude Code runs separately in the repo and connects in as a client.

## Components

- **UI** — single-page board (kanban columns, cards, detail drawer with chat). Talks to the backend over HTTP for reads/writes and subscribes to a realtime channel for live updates.
- **Backend / API** — one long-running local Node process. Hosts the HTTP API, the realtime channel, the MCP endpoint, and the LLM gateway. Owns all writes to the store and emits an event on every change.
- **Store** — local SQLite database (source of truth) with optional markdown export.
- **MCP server** — an HTTP (Streamable HTTP) MCP endpoint *inside* the backend, exposing board tools to Claude Code clients.
- **LLM gateway** — a provider abstraction with two adapters: Claude (subscription via Agent SDK) and OpenAI-compatible (base URL + key + model).

All four server-side concerns live in the **same process** so MCP writes, API writes, and LLM-driven writes all flow through one write path and one event bus. This is what makes realtime trivial and avoids cross-process coordination.

## Key Decisions

**Tech stack: TypeScript / Node.** The MCP SDK and the Claude Agent SDK are both first-class in TypeScript, and both are mandatory integrations here. A single-language stack (Node backend + web UI) keeps the MCP server, LLM gateway, and API in one runtime sharing one write path. Recommend a Node HTTP framework for the backend and a standard SPA framework for the UI; exact choices are the spec writer's call.

**Storage: SQLite as source of truth, with optional markdown export (hybrid).** SQLite gives transactional writes, relational queries (items by status, conversations by item, activity feed), and a single-file local store with zero server. Plain JSON/markdown files alone would force hand-rolled indexing and risk corruption under concurrent MCP + UI writes. The hybrid pays off: SQLite handles correctness and queries; a one-way export of epics/stories/tasks to markdown gives human- and git-readable snapshots. Export is derived and disposable — never read back as truth — so it stays simple. Defer export to a later phase.

**Realtime: Server-Sent Events (SSE).** The traffic is almost entirely server→client (board changes pushed to one watching UI); client→server goes over normal HTTP. SSE is one-directional, runs over plain HTTP, auto-reconnects, and needs no extra protocol — a better fit than WebSockets, whose bidirectional complexity buys nothing here. Polling is rejected: it adds latency and wastes cycles for a board the user is actively watching. Every backend write emits one event; the SSE stream relays it; the UI patches the affected card.

**MCP transport: HTTP (Streamable HTTP) endpoint on the backend — not a standalone stdio binary.** The ldash backend is already a long-running process and the sole owner of the store. A stdio MCP binary would have to be spawned per Claude Code instance and would then need its own channel back to the backend to reach the shared store — an extra hop solving a problem we don't have. The MCP TypeScript SDK's Streamable HTTP transport is a single HTTP endpoint (POST + optional SSE) that naturally supports multiple concurrent clients, so several Claude Code instances can connect to the same backend and write through the same path that already drives realtime. Verified: the SDK ships both stdio and Streamable HTTP server transports.

**LLM provider abstraction: one chat interface, two adapters.** A single internal "send messages, get a (streamed) reply" contract with selectable provider + model in settings, overridable per conversation.
- *Claude (subscription)* — use the **Claude Agent SDK**. Verified: when `ANTHROPIC_API_KEY` is unset, the SDK authenticates via OAuth against a Claude Pro/Max subscription (reading `CLAUDE_CODE_OAUTH_TOKEN`), so in-app chat rides the user's existing subscription with no API key. (Note: from 2026-06-15 subscription Agent SDK usage draws on a separate monthly Agent SDK credit; individual-use only.)
- *OpenAI-compatible* — base URL + API key + model name, covering OpenAI, OpenRouter, Ollama, LM Studio, etc.

## Tradeoffs

- **Single process for everything** — simplest possible realtime and write integrity, at the cost of no horizontal scaling. Acceptable: it's one developer on one machine.
- **SQLite over files-as-truth** — loses git-native diffing of the live store, regained partially via markdown export. Worth it for query power and write safety.
- **SSE over WebSocket** — no client→server streaming over the live channel; fine, because all writes already have an HTTP path.
- **HTTP MCP over stdio** — slightly more setup than a stdio binary (a URL to configure), but avoids per-client process spawning and a second store-access channel.
- **Subscription LLM auth** — convenient and key-free, but individual-use-only and quota-bound; the OpenAI-compatible adapter is the escape hatch.

## Constraints (hard rules)

- TypeScript / Node across backend, MCP server, and LLM gateway.
- One backend process owns all writes; UI, MCP, and LLM gateway never touch the store directly — they go through the backend's write path.
- Every state change emits exactly one event on the internal bus; the SSE stream is the only realtime channel.
- MCP exposed via the SDK's Streamable HTTP transport; must tolerate multiple concurrent clients.
- LLM access only through the gateway abstraction — no provider SDK called directly from UI or feature code.
- Markdown export is one-way and derived; it is never a read source of truth.
- No auth, no multi-tenant, no cloud sync, no network exposure beyond localhost.

## Data Model (sketch)

- **project** — top-level container.
- **epic** — belongs to a project.
- **story** — belongs to an epic.
- **task** — belongs to a story (or directly to an epic); carries status, optional flag/block state.
- **column / status** — the board's ordered states a card moves through.
- **comment** — attached to any item (epic/story/task), authored by user or Claude Code.
- **flag / block** — a markable state on a task with a reason.
- **conversation** — a chat thread scoped either to planning (project-level) or to a single item.
- **message** — belongs to a conversation; role + content + which provider/model produced it.
- **activity log** — append-only record of every state change (who/what/when), feeding the realtime stream and the audit feed.

Keep it minimal; add fields only when a phase needs them.

## Data Flow — three core loops

**(a) Planning chat → artifacts.** User opens a project-level conversation. Messages go UI → backend → LLM gateway → chosen provider. The assistant proposes epics/stories/tasks; on user confirmation the backend writes them through the single write path. Each created item emits an event, and the board updates live as the plan materializes.

**(b) Claude Code → MCP write → realtime UI.** Claude Code connects to the backend's Streamable HTTP MCP endpoint and calls tools (list/read tasks, update status, comment, flag/block). Each tool call hits the same backend write path, mutates SQLite, writes an activity-log entry, and emits an event. The SSE stream relays it and the watching UI patches the affected card — no refresh.

**(c) User clicks a task → contextual chat.** Opening a card's detail drawer loads or creates that item's conversation. Outgoing messages carry context assembled by the backend — the item, its history/activity, and related items — passed through the LLM gateway to the selected provider. The reply streams back over the chat response and is persisted as messages on that item's conversation.

## Phased Build Plan

**Phase 1 — Core data + API + board.** SQLite store, the data model, the backend with its single write path and HTTP API, and the SPA board: create/move/edit epics, stories, tasks across columns; comment and flag. No AI, no realtime yet. Yields a usable manual planning board.

**Phase 2 — MCP server.** Add the Streamable HTTP MCP endpoint exposing board tools (list/read tasks, update status, comment, flag/block) over the existing write path. Connect a Claude Code instance and drive the board from it. Yields Claude Code as a working board client.

**Phase 3 — Realtime.** Add the internal event bus and SSE stream; have the UI subscribe and patch on events. Now Phase 2's MCP writes (and all API writes) appear live. Yields the "watch Claude Code work" experience.

**Phase 4 — LLM chat + provider gateway.** Build the gateway abstraction with both adapters (Claude Agent SDK subscription auth + OpenAI-compatible), settings for provider/model, conversations/messages persistence, and per-item contextual chat in the card drawer. Yields per-task AI chat.

**Phase 5 — Planning mode + polish.** Project-level planning conversation that turns chat into confirmed epics/stories/tasks, per-conversation model override, and the one-way markdown export of the board for git-readable snapshots. Yields the full AI-assisted planning loop.

## Open Questions

- Markdown export scope — items only, or also conversations and activity?
- Should planning-mode artifact creation require explicit user confirmation per item, or batch-apply a proposed plan?
- Per-item chat context limit — how much history/related-item context before it needs trimming or summarizing?
- Does Claude Code authoring comments/status need a distinct actor identity in the activity log vs. the user, for the audit feed?
- Any need to guard the localhost MCP/HTTP endpoints (token) even on a single machine, or is loopback-only binding sufficient?
