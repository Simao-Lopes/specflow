// Encrypted secrets vault.
//
// Agents can use these secrets (e.g. as env vars for MCP servers, or injected
// into their environment). Values are encrypted at rest with AES-256-GCM.
//
// Master key resolution order:
//   1. SPECFLOW_SECRETS_KEY env var (preferred — rotate = set a new key)
//   2. a key file at <repoRoot>/.specflow/secrets.key (auto-generated on first use)
//
// The key file is gitignored and chmod 600. If you deploy elsewhere, set
// SPECFLOW_SECRETS_KEY explicitly to a 32-byte hex key.

import { getDb } from './store.js';
import { emit, EVT } from './events.js';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

function masterKey() {
  const envKey = process.env.SPECFLOW_SECRETS_KEY;
  if (envKey) return Buffer.from(envKey.length === 64 ? envKey : createHash('sha256').update(envKey).digest('hex'), 'hex');
  // Fall back to / read the key file.
  const repoRoot = resolve(getDb().prepare('SELECT value FROM config WHERE key=?').get('repo_root')?.value || './work');
  const keyFile = resolve(repoRoot, '.specflow', 'secrets.key');
  if (existsSync(keyFile)) {
    return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  // Generate and persist.
  const key = randomBytes(32);
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

export function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  const [ivB, tagB, dataB] = String(payload).split('.');
  if (!ivB || !tagB || !dataB) return '';
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

// ---- CRUD ----

export function listSecrets() {
  // Never reveal the encrypted/plaintext value — only existence + provenance.
  return getDb().prepare('SELECT key,note,created_at,updated_at FROM secrets ORDER BY key COLLATE NOCASE').all();
}

export function getSecretValue(key) {
  const r = getDb().prepare('SELECT value FROM secrets WHERE key=?').get(key);
  if (!r) return undefined;
  return decryptSecret(r.value);
}

// Store (or update) a secret. `value` is stored encrypted.
export function upsertSecret(key, value, note = '') {
  if (!key) throw new Error('key is required');
  const enc = encryptSecret(value);
  getDb().prepare(`INSERT INTO secrets (key,value,note,created_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, note=excluded.note, updated_at=datetime('now')`)
    .run(key, enc, note);
  const row = getDb().prepare('SELECT key,note,created_at,updated_at FROM secrets WHERE key=?').get(key);
  emit(EVT.CONFIG_UPDATED, { secret: row });
  return row;
}

export function deleteSecret(key) {
  getDb().prepare('DELETE FROM secrets WHERE key=?').run(key);
  emit(EVT.CONFIG_UPDATED, { secretDeleted: key });
}

// Resolve ${secret:NAME} references in an env map against the vault.
// e.g. { GITHUB_TOKEN: '${secret:github_pat}' } -> { GITHUB_TOKEN: '<decrypted>' }
export function resolveEnv(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = resolveSecretRef(v);
  }
  return out;
}

export function resolveSecretRef(value) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^\$\{secret:([^}]+)\}$/);
  if (!m) return value;
  const secret = getSecretValue(m[1]);
  return secret === undefined ? '' : secret;
}