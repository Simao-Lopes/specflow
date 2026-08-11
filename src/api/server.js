// Fastify REST API + Socket.IO — the main web/int API surface.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  listSpecs, getSpec, createSpec, updateSpec, deleteSpec,
  listAgents, upsertAgent, deleteAgent,
  listJobs, getJob, jobLogs, jobSteps, runJob, gateJob,
  listMessages, addMessage, stepsOf,
  listPipelines, getPipeline, createPipeline, updatePipeline, deletePipeline,
  instantiatePresets, listPresets, syncPipelinesFromDisk, materializeAllPrompts,
} from '../core/core.js';
import { on, EVT } from '../core/events.js';
import { initStore, getDb } from '../core/store.js';
import { registerChannel, listChannels, setChannelEnabled, isChannelEnabled, getPrimaryChannel, startNotificationBridge } from '../channels/router.js';
import { initWhatsAppChannel } from '../channels/whatsapp.js';
import { MODEL_CATALOG, PROVIDER_LIST } from '../llm/providers.js';
import { templateCatalog, listCustomActions, PHASE_LABELS, resolvedStepPrompt, rawTemplate } from '../methods/catalog.js';
import { HARNESS_LIST, HARNESS_META } from '../harnesses/index.js';
import {
  getSettings, updateSettings, jobDefaults,
  listConnections, addConnection, updateConnection, deleteConnection, testConnection,
  savePromptVersion, promptVersions, restorePromptVersion,
} from '../core/settings.js';
import {
  listMcpConnections, getMcpConnection, addMcpConnection, updateMcpConnection, deleteMcpConnection,
  testMcpConnection, listMcpPresets,
} from '../core/mcp.js';
import { listSecrets, upsertSecret, deleteSecret, getSecretValue } from '../core/secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildServer({ dbPath, port }) {
  initStore(dbPath);
  // Seed industry preset pipelines (idempotent) + load any pipelines edited
  // directly on disk (folders under <repoRoot>/.specflow/pipelines/).
  try { instantiatePresets(); } catch (e) { console.error('preset seed:', e.message); }
  try { const a = materializeAllPrompts(); if (a) console.log(`[pipelines] materialized prompts on ${a}`); } catch (e) { console.error('materialize:', e.message); }
  try { const n = syncPipelinesFromDisk(); console.log(`[pipelines] loaded ${n} from disk store`); } catch (e) { console.error('disk sync:', e.message); }
  initWhatsAppChannel();
  startNotificationBridge();

  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  // --- REST routes ---
  app.get('/health', async () => ({ ok: true }));

  app.get('/api/specs', async () => listSpecs());
  app.get('/api/specs/:id', async (req, rep) => {
    const s = getSpec(req.params.id);
    return s ?? rep.code(404).send({ error: 'not found' });
  });
  app.post('/api/specs', async (req) => createSpec(req.body));
  app.patch('/api/specs/:id', async (req) => updateSpec(req.params.id, req.body));
  app.delete('/api/specs/:id', async (req) => { deleteSpec(req.params.id); return { ok: true }; });

  app.get('/api/agents', async () => listAgents());
  app.put('/api/agents', async (req) => upsertAgent(req.body));
  app.delete('/api/agents/:id', async (req) => { deleteAgent(req.params.id); return { ok: true }; });

  // Methods library — industry templates (simplest→complex) + custom actions
  // defined in <repoRoot>/.specflow/actions/<phase>/.
  app.get('/api/methods', async () => {
    const rr = getDb().prepare('SELECT value FROM config WHERE key=?').get('repo_root')?.value || './work';
    return {
      phases      : PHASE_LABELS,
      templates   : templateCatalog(),
      custom      : listCustomActions({ repoRoot: rr }),
      harnesses   : HARNESS_LIST.map((id) => ({ id, label: HARNESS_META[id]?.label || id, description: HARNESS_META[id]?.description || '' })),
      repoRoot    : rr,
    };
  });

  // Agent harnesses (CLI coding agents) — list + metadata for UI dropdowns.
  app.get('/api/harnesses', async () => HARNESS_LIST.map((id) => ({ id, label: HARNESS_META[id]?.label || id, description: HARNESS_META[id]?.description || '' })));

  // Pipelines (dedicated, reusable step definitions)
  app.get('/api/pipelines', async () => listPipelines());
  app.get('/api/pipelines/:id', async (req, rep) => getPipeline(req.params.id) ?? rep.code(404).send({ error: 'not found' }));
  app.post('/api/pipelines', async (req) => createPipeline(req.body));
  app.patch('/api/pipelines/:id', async (req) => updatePipeline(req.params.id, req.body));
  app.delete('/api/pipelines/:id', async (req) => { deletePipeline(req.params.id); return { ok: true }; });

  // Industry pipeline presets — complete ready-to-run flows built from methods.
  app.get('/api/presets', async () => listPresets());
  // Instantiate presets into real pipelines: {only?: '<name>' } or {} for all.
  app.post('/api/presets/instantiate', async (req) => {
    const created = instantiatePresets({ only: req.body?.only });
    return { created: listPipelines().map((p) => p.name) };
  });

  // A spec resolves its pipeline's steps (read-only here; editing happens in the Pipelines builder).
  app.get('/api/specs/:id/steps', async (req) => {
    const s = getSpec(req.params.id);
    if (!s) return { error: 'not found' };
    return stepsOf(s);
  });

  // Effective prompts for every step of a pipeline. `?specId=...` (optional)
  // fills {description}/{acceptance} from a chosen spec so the preview shows the
  // fully-resolved prompt, not blanks. Each step also includes `template` — the
  // raw method template with {placeholders} visible.
  app.get('/api/pipelines/:id/prompts', (req) => {
    const p = getPipeline(req.params.id);
    if (!p) return { error: 'not found' };
    const spec = req.query.specId ? getSpec(req.query.specId) : null;
    const ctx = spec ? { title: spec.title, description: spec.description || '', acceptance_criteria: spec.acceptance_criteria || '' } : null;
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const resolved = steps.map((s) => ({
      id: s.id, name: s.name, method: s.method || null,
      prompt: resolvedStepPrompt(s, { spec: ctx }),
      template: rawTemplate(s),
      stepPrompt: s.prompt || '',
    }));
    return { pipelineId: p.id, spec: spec ? { id: spec.id, title: spec.title } : null, steps: resolved };
  });
  app.get('/api/pipelines/:id/steps/:sid/prompt', (req) => {
    const p = getPipeline(req.params.id);
    if (!p) return { error: 'not found' };
    const s = (Array.isArray(p.steps) ? p.steps : []).find((x) => String(x.id) === String(req.params.sid));
    if (!s) return { error: 'step not found' };
    return { id: s.id, name: s.name, method: s.method || null, prompt: resolvedStepPrompt(s), stepPrompt: s.prompt || '' };
  });

  // Per-spec agent-session messages (interact with the agent)
  app.get('/api/specs/:id/messages', async (req) => listMessages(req.params.id));
  app.post('/api/specs/:id/messages', async (req) => addMessage({
    specId: req.params.id, role: req.body?.role || 'user', author: 'human',
    content: req.body?.content, inReplyJob: req.body?.inReplyJob || null,
  }));

  app.get('/api/jobs', async (req) => listJobs({ specId: req.query.specId }));
  app.get('/api/jobs/:id', async (req) => getJob(req.params.id));
  app.get('/api/jobs/:id/logs', async (req) => jobLogs(req.params.id, { limit: req.query.limit }));
  app.get('/api/jobs/:id/steps', async (req) => jobSteps(req.params.id));
  // Human gate decision on a paused job.
  app.post('/api/jobs/:id/gate', async (req) => gateJob(req.params.id, req.body?.action, req.body?.note || ''));
  app.post('/api/specs/:id/run', async (req) => {
    const jobId = await runJob({ specId: req.params.id });
    return { jobId };
  });

  app.get('/api/channels', async () => listChannels());
  app.post('/api/channels/:name', async (req) => {
    setChannelEnabled(req.params.name, !!req.body?.enabled);
    return { ok: true, enabled: isChannelEnabled(req.params.name) };
  });
  app.get('/api/config', async () => ({
    primaryChannel : getPrimaryChannel(),
    models         : MODEL_CATALOG,
    providers      : PROVIDER_LIST,
    channels       : listChannels(),
    settings       : getSettings(),
    connections    : listConnections(),
  }));
  // Editable preferences.
  app.get('/api/settings', async () => getSettings());
  app.put('/api/settings', async (req) => updateSettings(req.body));

  // Git connections.
  app.get('/api/connections', async () => listConnections());
  app.post('/api/connections', async (req) => addConnection(req.body));
  app.patch('/api/connections/:id', async (req, rep) => updateConnection(req.params.id, req.body) ?? rep.code(404).send({ error: 'not found' }));
  app.delete('/api/connections/:id', async (req) => { deleteConnection(req.params.id); return { ok: true }; });
  app.post('/api/connections/:id/test', async (req) => testConnection(req.params.id));

  // MCP tool connections.
  app.get('/api/mcp', async () => listMcpConnections());
  app.get('/api/mcp/:id', async (req, rep) => getMcpConnection(req.params.id) ?? rep.code(404).send({ error: 'not found' }));
  app.post('/api/mcp', async (req) => addMcpConnection(req.body));
  app.patch('/api/mcp/:id', async (req) => updateMcpConnection(req.params.id, req.body));
  app.delete('/api/mcp/:id', async (req) => { deleteMcpConnection(req.params.id); return { ok: true }; });
  app.post('/api/mcp/:id/test', async (req) => testMcpConnection(req.params.id));
  // One-click MCP preset templates.
  app.get('/api/mcp/presets', async () => listMcpPresets());

  // Encrypted secrets vault.
  app.get('/api/secrets', async () => listSecrets());
  app.post('/api/secrets', async (req) => upsertSecret(req.body?.key, req.body?.value, req.body?.note || ''));
  app.put('/api/secrets/:key', async (req) => upsertSecret(req.params.key, req.body?.value, req.body?.note || req.params.note || ''));
  app.delete('/api/secrets/:key', async (req) => { deleteSecret(req.params.key); return { ok: true }; });
  app.get('/api/secrets/:key/value', async (req, rep) => {
    const v = getSecretValue(req.params.key);
    return v === undefined ? rep.code(404).send({ error: 'not found' }) : { key: req.params.key, value: v };
  });

  // Prompt versioning.
  app.get('/api/pipelines/:pid/steps/:sid/prompt-versions', async (req) => promptVersions(req.params.pid, req.params.sid));
  app.post('/api/pipelines/:pid/steps/:sid/prompt-versions', async (req) => savePromptVersion(req.params.pid, req.params.sid, req.body?.content, { note: req.body?.note, author: req.body?.author }));
  app.post('/api/pipelines/:pid/steps/:sid/prompt-versions/restore/:version', async (req, rep) => {
    try {
      const content = restorePromptVersion(req.params.pid, req.params.sid, Number(req.params.version));
      // Apply back onto the pipeline's step (by step_id) and re-save, which also auto-versions.
      const p = getPipeline(req.params.pid);
      const steps = (p?.steps || []).map((s) => String(s.id) === String(req.params.sid) ? { ...s, prompt: typeof content === 'string' ? content : (content.prompt || s.prompt) } : s);
      const saved = updatePipeline(req.params.pid, { steps });
      return { ok: true, pipeline: saved };
    } catch (e) { return rep.code(400).send({ error: e.message }); }
  });

  // --- Static web UI (built) ---
  const webDist = join(__dirname, '../../web/dist');
  app.register(fastifyStatic, { root: webDist, prefix: '/ui/' });
  app.get('/', async (_, rep) => rep.redirect('/ui/'));

  // --- HTTP server + Socket.IO ---
  const httpServer = app.server;
  const io = new Server(httpServer, { cors: { origin: true } });

  io.on('connection', (socket) => {
    const subs = [];
    const mk = (event, tx) => subs.push(on(event, payload => tx(payload)));

    mk(EVT.SPEC_UPDATED, p => socket.emit('spec', p));
    mk(EVT.PIPELINE_UPDATED, p => socket.emit('pipeline', p));
    mk(EVT.JOB_UPDATED, p => socket.emit('job', p));
    mk(EVT.JOB_LOG, p => { if (socket.jobFilters?.includes(p.jobId) || !socket.jobFilters?.length) socket.emit('log', p); });
    mk(EVT.JOB_STEP, p => { if (socket.jobFilters?.includes(p.job_id) || !socket.jobFilters?.length) socket.emit('step', p); });
    mk(EVT.MESSAGE, p => socket.emit('message', p));
    mk(EVT.CONFIG_UPDATED, p => socket.emit('config', p));
    mk(EVT.NOTIFY, p => socket.emit('notify', p));

    socket.on('watch-job', (jobId) => { socket.jobFilters = [jobId]; });
    socket.on('watch-all', () => { socket.jobFilters = []; });

    socket.on('disconnect', () => subs.forEach(fn => fn()));
  });

  return { app, io, listen: () => new Promise((res, rej) => {
    app.listen({ port: port ?? 9120, host: '0.0.0.0' }, (err) => err ? rej(err) : res(app.server.address().port));
  }) };
}