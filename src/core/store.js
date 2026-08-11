// SQLite persistence layer (better-sqlite3, synchronous — fast & simple for single-node).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id TEXT NOT NULL,
      role TEXT DEFAULT 'user',           -- user | agent | system
      author TEXT DEFAULT 'human',
      content TEXT NOT NULL,
      in_reply_job TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS job_steps (
      job_id TEXT,
      step_id TEXT,
      name TEXT,
      attempt INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',      -- pending | running | passed | failed | skipped | iterating
      detail TEXT,
      finished_at TEXT,
      PRIMARY KEY (job_id, step_id)
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

  // Migrate existing DBs that predate the steps column
  const cols = db.prepare('PRAGMA table_info(specs)').all().map(c => c.name);
  if (!cols.includes('steps')) db.exec('ALTER TABLE specs ADD COLUMN steps TEXT');

  // Seed default config
  const cfg = getDb();
  cfg.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)')
     .run('primary_channel', 'rest');
  cfg.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)')
     .run('repo_root', process.env.SPECFLOW_REPO_ROOT ? resolve(process.env.SPECFLOW_REPO_ROOT) : resolve('./work'));
}