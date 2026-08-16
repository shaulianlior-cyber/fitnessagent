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

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    source_key TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS conversations_user_time_idx
    ON conversations(user_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    user_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    open_items TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preferences (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS pending_extractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    event_key TEXT,
    row_json TEXT NOT NULL,
    missing_json TEXT NOT NULL,
    errors_json TEXT NOT NULL,
    confidence REAL,
    usage_json TEXT,
    write_started_at TEXT,
    write_error TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS pending_extractions_user_idx
    ON pending_extractions(user_id, status, id DESC);

  CREATE TABLE IF NOT EXISTS stage3_events (
    event_key TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS outbox (
    dedupe_key TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_markup_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sent')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );

  CREATE TABLE IF NOT EXISTS model_budget_daily (
    day TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
    updated_at TEXT NOT NULL
  );
`;

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

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
  ensureColumn(db, "conversations", "source_key", "TEXT");
  ensureColumn(db, "pending_extractions", "event_key", "TEXT");
  ensureColumn(db, "pending_extractions", "confidence", "REAL");
  ensureColumn(db, "pending_extractions", "usage_json", "TEXT");
  ensureColumn(db, "pending_extractions", "write_started_at", "TEXT");
  ensureColumn(db, "pending_extractions", "write_error", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_source_key_idx
      ON conversations(source_key) WHERE source_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS pending_extractions_event_key_idx
      ON pending_extractions(event_key) WHERE event_key IS NOT NULL;
  `);

  return db;
}
