import Database from 'better-sqlite3';

let _db: Database.Database | null = null;

export function openDatabase(path: string): Database.Database {
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function getDatabase(): Database.Database {
  if (!_db) {
    throw new Error('Database not opened. Call openDatabase() first.');
  }
  return _db;
}
