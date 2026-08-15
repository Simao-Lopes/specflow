// Fastify REST API + Socket.IO — the main web/int API surface.
// Serves entirely under the /specflow URL prefix so the app can be
// reverse-proxied at https://space.tail1697a1.ts.net/specflow while the
// site root (/) is owned by another service (Hermes dashboard).
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  listSpecs, getSpec, createSpec, updateSpec, deleteSpec,
  listAgents, upsertAgent, deleteAgent,
  listJobs, getJob, jobLogs, jobSteps, runJob, gateJob, jobArtifacts, jobGitHistory,
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
import { HARNESS_LIST, HARNESS_META, checkAvailability } from '../harnesses/index.js';
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
const WEB_PREFIX = '/specflow';

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
  // CORS stays on the ROOT app (outside the prefixed plugin).
  app.register(cors, { origin: true });

  // --- Root-level routes (NOT prefixed) ---
  // Health checks may hit this directly at the site root.
  app.get('/health', async () => ({ ok: true }));

  // --- Everything else (REST + UI + root redirects) lives under /specflow ---
  const webDist = join(__dirname, '../../web/dist');

  // Bare /specflow (with or without trailing slash) and / redirect into the prefixed UI.
  app.get('/', async (_, rep) => rep.redirect(`${WEB_PREFIX}/ui/`));
  app.get(WEB_PREFIX, async (_, rep) => rep.redirect(`${WEB_PREFIX}/ui/`));
  app.get(`${WEB_PREFIX}/`, async (_, rep) => rep.redirect(`${WEB_PREFIX}/ui/`));

  // Static web UI (built) — served under /specflow/ui/.
  app.register(fastifyStatic, { root: webDist, prefix: `${WEB_PREFIX}/ui/` });

  // REST routes — all under /specflow/api/...
  app.register(async (api) => {
    api.get('/api/specs', async () => listSpecs());
    api.get('/api/specs/:id', async (req, rep) => {
      const s = getSpec(req.params.id);
      return s ?? rep.code(404).send({ error: 'not found' });
    });
    api.post('/api/specs', async (req) => createSpec(req.body));
    api.patch('/api/specs/:id', async (req) => updateSpec(req.params.id, req.body));
    api.delete('/api/specs/:id', async (req) => { deleteSpec(req.params.id); return { ok: true }; });

    api.get('/api/agents', async () => listAgents());
    api.put('/api/agents', async (req) => upsertAgent(req.body));
    api.delete('/api/agents/:id', async (req) => { deleteAgent(req.params.id); return { ok: true }; });

    // Methods library — industry templates (simplest→complex) + custom actions
    // defined in <repoRoot>/.specflow/actions/<phase>/.
    api.get('/api/methods', async () => {
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
    api.get('/api/harnesses', async () => HARNESS_LIST.map((id) => ({ id, label: HARNESS_META[id]?.label || id, description: HARNESS_META[id]?.description || '' }) ));
    // Availability probe: which CLI binaries are installed on the server.
    api.get('/api/harnesses/availability', async () => checkAvailability());

    // Pipelines (dedicated, reusable step definitions)
    api.get('/api/pipelines', async () => listPipelines());
    api.get('/api/pipelines/:id', async (req, rep) => getPipeline(req.params.id) ?? rep.code(404).send({ error: 'not found' }));
    api.post('/api/pipelines', async (req) => createPipeline(req.body));
    api.patch('/api/pipelines/:id', async (req) => updatePipeline(req.params.id, req.body));
    api.delete('/api/pipelines/:id', async (req) => { deletePipeline(req.params.id); return { ok: true }; });

    // Industry pipeline presets — complete ready-to-run flows built from methods.
    api.get('/api/presets', async () => listPresets());
    // Instantiate presets into real pipelines: {only?: '<name>' } or {} for all.
    api.post('/api/presets/instantiate', async (req) => {
      const created = instantiatePresets({ only: req.body?.only });
      return { created: listPipelines().map((p) => p.name) };
    });

    // A spec resolves its pipeline's steps (read-only here; editing happens in the Pipelines builder).
    api.get('/api/specs/:id/steps', async (req) => {
      const s = getSpec(req.params.id);
      if (!s) return { error: 'not found' };
      return stepsOf(s);
    });

    // Effective prompts for every step of a pipeline. `?specId=...` (optional)
    // fills {description}/{acceptance} from a chosen spec so the preview shows the
    // fully-resolved prompt, not blanks. Each step also includes `template` — the
    // raw method template with {placeholders} visible.
    api.get('/api/pipelines/:id/prompts', (req) => {
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
    api.get('/api/pipelines/:id/steps/:sid/prompt', (req) => {
      const p = getPipeline(req.params.id);
      if (!p) return { error: 'not found' };
      const s = (Array.isArray(p.steps) ? p.steps : []).find((x) => String(x.id) === String(req.params.sid));
      if (!s) return { error: 'step not found' };
      return { id: s.id, name: s.name, method: s.method || null, prompt: resolvedStepPrompt(s), stepPrompt: s.prompt || '' };
    });

    // Per-spec agent-session messages (interact with the agent)
    api.get('/api/specs/:id/messages', async (req) => listMessages(req.params.id));
    api.post('/api/specs/:id/messages', async (req) => addMessage({
      specId: req.params.id, role: req.body?.role || 'user', author: 'human',
      content: req.body?.content, inReplyJob: req.body?.inReplyJob || null,
    }));

    api.get('/api/jobs', async (req) => listJobs({ specId: req.query.specId }));
    api.get('/api/jobs/:id', async (req) => getJob(req.params.id));
    api.get('/api/jobs/:id/logs', async (req) => jobLogs(req.params.id, { limit: req.query.limit }));
    api.get('/api/jobs/:id/steps', async (req) => jobSteps(req.params.id));
    api.get('/api/jobs/:id/artifacts', async (req) => jobArtifacts(req.params.id));
    api.get('/api/jobs/:id/githistory', async (req) => jobGitHistory(req.params.id));
    // Human gate decision on a paused job.
    api.post('/api/jobs/:id/gate', async (req) => gateJob(req.params.id, req.body?.action, req.body?.note || ''));
    api.post('/api/specs/:id/run', async (req) => {
      const jobId = await runJob({ specId: req.params.id });
      return { jobId };
    });

    api.get('/api/channels', async () => listChannels());
    api.post('/api/channels/:name', async (req) => {
      setChannelEnabled(req.params.name, !!req.body?.enabled);
      return { ok: true, enabled: isChannelEnabled(req.params.name) };
    });
    api.get('/api/config', async () => ({
      primaryChannel : getPrimaryChannel(),
      models         : MODEL_CATALOG,
      providers      : PROVIDER_LIST,
      channels       : listChannels(),
      settings       : getSettings(),
      connections    : listConnections(),
    }));
    // Editable preferences.
    api.get('/api/settings', async () => getSettings());
    api.put('/api/settings', async (req) => updateSettings(req.body));

    // Git connections.
    api.get('/api/connections', async () => listConnections());
    api.post('/api/connections', async (req) => addConnection(req.body));
    api.patch('/api/connections/:id', async (req, rep) => updateConnection(req.params.id, req.body) ?? rep.code(404).send({ error: 'not found' }));
    api.delete('/api/connections/:id', async (req) => { deleteConnection(req.params.id); return { ok: true }; });
    api.post('/api/connections/:id/test', async (req) => testConnection(req.params.id));

    // MCP tool connections.
    api.get('/api/mcp', async () => listMcpConnections());
    api.get('/api/mcp/:id', async (req, rep) => getMcpConnection(req.params.id) ?? rep.code(404).send({ error: 'not found' }));
    api.post('/api/mcp', async (req) => addMcpConnection(req.body));
    api.patch('/api/mcp/:id', async (req) => updateMcpConnection(req.params.id, req.body));
    api.delete('/api/mcp/:id', async (req) => { deleteMcpConnection(req.params.id); return { ok: true }; });
    api.post('/api/mcp/:id/test', async (req) => testMcpConnection(req.params.id));
    // One-click MCP preset templates.
    api.get('/api/mcp/presets', async () => listMcpPresets());

    // Encrypted secrets vault.
    api.get('/api/secrets', async () => listSecrets());
    api.post('/api/secrets', async (req) => upsertSecret(req.body?.key, req.body?.value, req.body?.note || ''));
    api.put('/api/secrets/:key', async (req) => upsertSecret(req.params.key, req.body?.value, req.body?.note || req.params.note || ''));
    api.delete('/api/secrets/:key', async (req) => { deleteSecret(req.params.key); return { ok: true }; });
    api.get('/api/secrets/:key/value', async (req, rep) => {
      const v = getSecretValue(req.params.key);
      return v === undefined ? rep.code(404).send({ error: 'not found' }) : { key: req.params.key, value: v };
    });

    // Prompt versioning.
    api.get('/api/pipelines/:pid/steps/:sid/prompt-versions', async (req) => promptVersions(req.params.pid, req.params.sid));
    api.post('/api/pipelines/:pid/steps/:sid/prompt-versions', async (req) => savePromptVersion(req.params.pid, req.params.sid, req.body?.content, { note: req.body?.note, author: req.body?.author }));
    api.post('/api/pipelines/:pid/steps/:sid/prompt-versions/restore/:version', async (req, rep) => {
      try {
        const content = restorePromptVersion(req.params.pid, req.params.sid, Number(req.params.version));
        // Apply back onto the pipeline's step (by step_id) and re-save, which also auto-versions.
        const p = getPipeline(req.params.pid);
        const steps = (p?.steps || []).map((s) => String(s.id) === String(req.params.sid) ? { ...s, prompt: typeof content === 'string' ? content : (content.prompt || s.prompt) } : s);
        const saved = updatePipeline(req.params.pid, { steps });
        return { ok: true, pipeline: saved };
      } catch (e) { return rep.code(400).send({ error: e.message }); }
    });

    // Middleware/delegation note: nothing else lives here.
    void registerChannel;
  }, { prefix: WEB_PREFIX });

  // --- HTTP server + Socket.IO ---
  const httpServer = app.server;
  const io = new Server(httpServer, { cors: { origin: true }, path: `${WEB_PREFIX}/socket.io` });

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
