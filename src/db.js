import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS raw_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    update_id INTEGER NOT NULL UNIQUE,
    user_id TEXT,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES raw_log(id),
    dedupe_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    payload TEXT NOT NULL,
    available_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS queue_ready_idx
    ON queue(status, available_at, id);
`;

export function openDatabase(filename = ":memory:") {
  let databasePath = filename;

  if (filename !== ":memory:") {
    databasePath = resolve(filename);
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  if (filename !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec(SCHEMA);

  // A process may have stopped after claiming an item. Requeue it on startup.
  db.prepare(`
    UPDATE queue
       SET status = 'pending',
           error = CASE
             WHEN error IS NULL OR error = '' THEN 'Recovered after restart'
             ELSE error
           END,
           updated_at = ?
     WHERE status = 'processing'
  `).run(new Date().toISOString());

  return db;
}
