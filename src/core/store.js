// SQLite persistence layer (better-sqlite3, synchronous — fast & simple for single-node).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db;

export function initStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrate();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Store not initialised - call initStore() first');
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS specs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'feature',
      status TEXT DEFAULT 'backlog',
      repo TEXT,
      branch TEXT,
      acceptance_criteria TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      spec_id TEXT,
      harness TEXT,
      model TEXT,
      provider TEXT,
      status TEXT DEFAULT 'queued',
      repo TEXT,
      branch TEXT,
      pr_url TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      ts TEXT DEFAULT (datetime('now')),
      level TEXT DEFAULT 'info',
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      harness TEXT,
      model TEXT,
      provider TEXT,
      repo TEXT,
      branch_prefix TEXT DEFAULT 'feature/',
      auto_pr INTEGER DEFAULT 1,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Seed default config
  const cfg = getDb();
  cfg.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)')
     .run('primary_channel', 'rest');
  cfg.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)')
     .run('repo_root', process.env.SPECFLOW_REPO_ROOT || './work');
}