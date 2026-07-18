'use strict';

const Database = require('better-sqlite3');
const { DB_PATH, ensureDirs } = require('./paths');

ensureDirs();

const db = new Database(DB_PATH);

// WAL mode lets multiple worker processes read/write the same file
// concurrently without stepping on each other's toes.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    command      TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending',
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_retries  INTEGER NOT NULL DEFAULT 3,
    backoff_base INTEGER NOT NULL DEFAULT 2,
    priority     INTEGER NOT NULL DEFAULT 0,
    timeout_ms   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    next_run_at  TEXT,
    worker_id    TEXT,
    last_error   TEXT,
    output       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state);

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Run migrations to add fields if existing DB is old
try {
  db.exec("ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;");
} catch (e) {
  // Ignore if column already exists
}
try {
  db.exec("ALTER TABLE jobs ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 0;");
} catch (e) {
  // Ignore if column already exists
}

// Seed default configuration if not already present.
const defaults = { max_retries: '3', backoff_base: '2', poll_interval_ms: '1000' };
const insertDefault = db.prepare(
  'INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)'
);
for (const [key, value] of Object.entries(defaults)) {
  insertDefault.run(key, value);
}

module.exports = db;
