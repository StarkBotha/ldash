import type Database from 'better-sqlite3';

export const name = '013_project_repo_path';

// Adds an optional `repo_path` to projects — the absolute filesystem path to the
// project's repository, surfaced in the board header (click to copy). Nullable;
// existing projects keep NULL until set.
//
// Plain ADD COLUMN — no table rebuild and no FK toggling needed. Not declared in
// schema.ts (the frozen baseline), because schema.ts runs first on a fresh DB and
// all migrations run after it — declaring it in both would make this ADD COLUMN
// fail with "duplicate column".
export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE projects ADD COLUMN repo_path TEXT`);
}
