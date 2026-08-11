// Channel router — decides where SpecFlow sends notifications and where it
// accepts commands, driven by config (primary_channel + per-channel enabled).
import { getDb } from '../core/store.js';
import { on, emit, EVT } from '../core/events.js';

const channels = {}; // name -> { send(msg), start(), name }

export function registerChannel(name, impl) {
  channels[name] = { name, ...impl };
}

export function getChannel(name) {
  return channels[name];
}

export function listChannels() {
  return Object.entries(channels).map(([id, c]) => ({
    id, enabled: isChannelEnabled(id), ...c.summary?.() || {},
  }));
}

export function isChannelEnabled(name) {
  const r = getDb().prepare('SELECT value FROM config WHERE key=?').get(`channel_${name}`);
  return r ? r.value === '1' : false;
}

export function setChannelEnabled(name, enabled) {
  getDb().prepare('INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
     .run(`channel_${name}`, enabled ? '1' : '0');
}

export function getPrimaryChannel() {
  const r = getDb().prepare('SELECT value FROM config WHERE key=?').get('primary_channel');
  return r?.value || 'rest';
}

// Send a user-facing message to the primary configured channel.
export async function notify(message, level = 'info') {
  emit(EVT.NOTIFY, { message, level });
  const primary = getPrimaryChannel();
  const ch = channels[primary];
  if (ch && ch.send) {
    try { await ch.send(message); } catch (e) {
      emit(EVT.NOTIFY, { message: `[channel ${primary} failed: ${e.message}] ${message}`, level: 'error' });
    }
  }
  // Always also log it (so it's visible via API/CLI regardless)
  emit(EVT.JOB_LOG, { jobId: '*', level, message: `[notify] ${message}` });
}

// Wire job/spec events to the notify channel
export function startNotificationBridge() {
  on(EVT.JOB_UPDATED, (job) => {
    if (job?.status === 'succeeded') notify(`✅ Job ${job.id} succeeded for spec ${job.spec_id}`);
    if (job?.status === 'failed') notify(`❌ Job ${job.id} failed: ${job.error || 'unknown error'}`);
  });
}