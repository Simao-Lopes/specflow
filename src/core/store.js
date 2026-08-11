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

    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      steps TEXT,                          -- JSON array of steps
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

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      provider TEXT DEFAULT 'https',
      base_branch TEXT DEFAULT 'main',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT,
      note TEXT,
      author TEXT DEFAULT 'human',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      url TEXT,
      args TEXT DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrate existing DBs that predate the steps column / gate columns
  const cols = db.prepare('PRAGMA table_info(specs)').all().map(c => c.name);
  if (!cols.includes('steps')) db.exec('ALTER TABLE specs ADD COLUMN steps TEXT');
  if (!cols.includes('pipeline_id')) db.exec('ALTER TABLE specs ADD COLUMN pipeline_id TEXT');

  const jcols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  if (!jcols.includes('step_index')) db.exec('ALTER TABLE jobs ADD COLUMN step_index INTEGER DEFAULT 0');
  if (!jcols.includes('gate_step')) db.exec('ALTER TABLE jobs ADD COLUMN gate_step TEXT');
  if (!jcols.includes('gate_state')) db.exec("ALTER TABLE jobs ADD COLUMN gate_state TEXT DEFAULT 'none'");

  // Seed default config
  const cfg = getDb();
  cfg.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)')
     .run('primary_channel', 'rest');
  cfg.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)')
     .run('repo_root', process.env.SPECFLOW_REPO_ROOT ? resolve(process.env.SPECFLOW_REPO_ROOT) : resolve('./work'));

  // Seed a default pipeline if none exists (reused by specs with no explicit pipeline).
  const existing = cfg.prepare('SELECT COUNT(*) AS n FROM pipelines').get().n;
  if (existing === 0) {
    const dp = JSON.stringify(defaultPipelineSteps());
    cfg.prepare('INSERT INTO pipelines (id,name,description,steps) VALUES (?,?,?,?)')
       .run('default', 'Default (Plan → Code)', 'Plan then implement, with a Test verifier that iterates.', dp);
  }
}

// Canonical default pipeline steps (Plan -> Code, Code gated by a Test verifier).
export function defaultPipelineSteps() {
  return [
    { id: 'plan', name: 'Plan', harness: 'llm', provider: 'gemini', model: 'gemini-3.5-flash-lite', iterations: 1, on_failure: 'continue', verify: [], prompt: '' },
    { id: 'code', name: 'Code', harness: 'hermes', provider: null, model: null, iterations: 3, on_failure: 'stop', verify: [
      { id: 'test', name: 'Test', harness: 'custom', command: '', iterations: 1, on_failure: 'stop', prompt: '' },
    ], prompt: '' },
  ];
}