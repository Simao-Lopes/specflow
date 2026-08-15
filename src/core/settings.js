// Editable runtime settings + git connections + prompt versioning.
// Settings live in the `config` table; git connections and prompt versions
// get dedicated tables.

import { getDb } from './store.js';
import { emit, EVT } from './events.js';
import { parseRepoUrl } from '../git/git.js';
import { randomUUID } from 'node:crypto';

// ---- Settings (key/value in the config table) ----

// Keys that are user-editable preferences.
export const SETTINGS_KEYS = [
  'default_harness',   // hermes | claude | custom | llm
  'default_provider',  // gemini | openrouter | nvidia | ollama | litellm
  'default_model',
  'default_repo',      // global specs repo; used when a project has none
  'base_branch',
  'primary_channel',
  'custom_command',
  'repo_root',
];

const SETTINGS_DEFAULTS = {
  default_harness : 'llm',
  default_provider: 'gemini',
  default_model   : 'gemini-3.5-flash-lite',
  base_branch     : 'main',
  primary_channel : 'rest',
};

export function getSettings() {
  const out = {};
  for (const k of SETTINGS_KEYS) {
    const r = getDb().prepare('SELECT value FROM config WHERE key=?').get(k);
    out[k] = r ? r.value : (SETTINGS_DEFAULTS[k] !== undefined ? SETTINGS_DEFAULTS[k] : '');
  }
  return out;
}

export function updateSettings(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!SETTINGS_KEYS.includes(k)) continue;
    if (v === null || v === undefined) continue;
    getDb().prepare('INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  }
  const settings = getSettings();
  emit(EVT.CONFIG_UPDATED, settings);
  return settings;
}

// Resolve effective job-level defaults from settings (used by runJob).
export function jobDefaults() {
  const s = getSettings();
  return {
    harness : s.default_harness,
    provider: s.default_provider,
    model   : s.default_model,
    repo    : s.default_repo || null,
    baseBranch: s.base_branch || 'main',
  };
}

// ---- Git connections ----

export function listConnections() {
  return getDb().prepare('SELECT id,name,url,provider,base_branch,created_at FROM connections ORDER BY name COLLATE NOCASE').all();
}
export function getConnection(id) {
  return getDb().prepare('SELECT id,name,url,provider,base_branch,created_at FROM connections WHERE id=?').get(id);
}
export function addConnection(input) {
  const id = input.id || randomUUID().slice(0, 8);
  const url = normalizeUrl(input.url);
  const parsed = parseRepoUrl(url);
  if (!parsed) throw new Error(`Cannot parse repo URL: ${url}`);
  const provider = input.provider || (url.includes('git@') ? 'ssh' : 'https');
  getDb().prepare('INSERT INTO connections (id,name,url,provider,base_branch) VALUES (?,?,?,?,?)')
    .run(id, input.name || parsed.name, url, provider, input.base_branch || 'main');
  return getConnection(id);
}
export function updateConnection(id, patch) {
  const cur = getConnection(id);
  if (!cur) return null;
  const fields = ['name', 'url', 'base_branch'];
  const sets = [], vals = {};
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f}=@${f}`); vals[f] = patch[f]; }
  }
  if (sets.length) { vals.id = id; getDb().prepare(`UPDATE connections SET ${sets.join(',')} WHERE id=@id`).run(vals); }
  const row = getConnection(id);
  emit(EVT.CONFIG_UPDATED, { connection: row });
  return row;
}
export function deleteConnection(id) {
  getDb().prepare('DELETE FROM connections WHERE id=?').run(id);
  emit(EVT.CONFIG_UPDATED, { deleted: id });
}

// Verify a connection by running ls-remote (reachability + auth).
export async function testConnection(id) {
  const c = getConnection(id);
  if (!c) throw new Error('Connection not found');
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const runs = promisify(execFile);
  try {
    const { stdout } = await runs('git', ['ls-remote', '--heads', c.url], { timeout: 15000, env: process.env });
    const heads = stdout.split('\n').filter(Boolean).slice(0, 20);
    return { ok: true, url: c.url, heads: heads.map((l) => l.split('\t')[1]).filter(Boolean) };
  } catch (e) {
    return { ok: false, url: c.url, error: e?.stderr || e?.message || String(e) };
  }
}

function normalizeUrl(url) {
  url = String(url || '').trim();
  if (url && !url.includes(':') && !url.startsWith('git@')) url = `https://github.com/${url}.git`;
  return url;
}

// ---- Prompt versioning ----

// Record a new version of a pipeline step's prompt. `content` may be a single
// editor-friendly prompt string, or { work, verify } for step+verifier prompts.
export function savePromptVersion(pipelineId, stepId, content, meta = {}) {
  const current = getDb().prepare('SELECT version FROM prompt_versions WHERE pipeline_id=? AND step_id=? ORDER BY version DESC LIMIT 1')
    .get(pipelineId, stepId);
  const version = (current?.version || 0) + 1;
  getDb().prepare('INSERT INTO prompt_versions (pipeline_id,step_id,version,content,note,author) VALUES (?,?,?,?,?,?)')
    .run(pipelineId, stepId, version, JSON.stringify(content), meta.note || '', meta.author || 'human');
  const rows = promptVersions(pipelineId, stepId);
  emit(EVT.PIPELINE_UPDATED, { id: pipelineId, promptVersioned: true });
  return rows;
}

export function promptVersions(pipelineId, stepId) {
  return getDb().prepare('SELECT id,pipeline_id,step_id,version,content,note,author,created_at FROM prompt_versions WHERE pipeline_id=? AND step_id=? ORDER BY version').all(pipelineId, stepId)
    .map((r) => ({ ...r, content: safeParse(r.content) }));
}

export function restorePromptVersion(pipelineId, stepId, version) {
  const v = getDb().prepare('SELECT * FROM prompt_versions WHERE pipeline_id=? AND step_id=? AND version=?').get(pipelineId, stepId, version);
  if (!v) throw new Error('Version not found');
  return safeParse(v.content);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// Auto-version a pipeline's prompts whenever it is saved (idempotent: only
// bumps when the effective prompt changed from the latest stored version).
export function autoVersionPipeline(pipeline) {
  const steps = (typeof pipeline.steps === 'string' ? safeParse(pipeline.steps) : pipeline.steps) || [];
  const barrier = getDb().prepare('SELECT version,content FROM prompt_versions WHERE pipeline_id=? AND step_id=? ORDER BY version DESC LIMIT 1');
  for (const step of steps) {
    const latest = barrier.get(pipeline.id, step.id);
    const cur = String(step.prompt || '').trim();
    const prev = latest ? String(plain(latest.content)).trim() : '';
    if (cur !== prev) savePromptVersion(pipeline.id, step.id, cur, { author: 'auto', note: 'auto' });
  }
}
function plain(x) { return typeof x === 'string' ? x : JSON.stringify(x); }