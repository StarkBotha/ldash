import type Database from 'better-sqlite3';

export const name = '002_planning_actor';

export function up(db: Database.Database): void {
  // SQLite does not support ALTER COLUMN with a new constraint,
  // so we recreate the activity table with 'llm' added to actor_type.
  // The migration runner wraps this in a transaction.
  db.exec(`
    ALTER TABLE activity RENAME TO activity_old;

    CREATE TABLE activity (
      id          TEXT PRIMARY KEY,
      item_id     TEXT REFERENCES items(id) ON DELETE SET NULL,
      project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
      actor_type  TEXT NOT NULL DEFAULT 'user'
                    CHECK (actor_type IN ('user', 'claude', 'llm')),
      actor_id    TEXT NOT NULL DEFAULT 'user',
      event_type  TEXT NOT NULL,
      payload     TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    INSERT INTO activity SELECT * FROM activity_old;

    DROP TABLE activity_old;

    CREATE INDEX IF NOT EXISTS idx_activity_item    ON activity(item_id);
    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
  `);
}
