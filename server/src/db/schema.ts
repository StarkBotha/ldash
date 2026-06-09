import type Database from 'better-sqlite3';

// NOTE: conversations and messages tables are deferred to Phase 4.
// Do not create them here.

const SQL = `
-- Columns (board statuses). Order is explicit.
CREATE TABLE IF NOT EXISTS columns (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Projects. Top-level containers.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Items — epics, stories, tasks unified in one table.
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES items(id) ON DELETE SET NULL,
  type        TEXT NOT NULL CHECK (type IN ('epic', 'story', 'task')),
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  column_id   TEXT NOT NULL REFERENCES columns(id),
  position    INTEGER NOT NULL DEFAULT 0,
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
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT 'user',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);

-- Activity log. Append-only. Never updated or deleted.
CREATE TABLE IF NOT EXISTS activity (
  id          TEXT PRIMARY KEY,
  item_id     TEXT REFERENCES items(id) ON DELETE SET NULL,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor_type  TEXT NOT NULL DEFAULT 'user'
                CHECK (actor_type IN ('user', 'claude')),
  actor_id    TEXT NOT NULL DEFAULT 'user',
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_item    ON activity(item_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
`;

export function runSchema(db: Database.Database): void {
  db.exec(SQL);
}
