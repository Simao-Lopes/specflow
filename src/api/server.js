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
  listJobs, getJob, jobLogs, runJob,
} from '../core/core.js';
import { on, EVT } from '../core/events.js';
import { initStore } from '../core/store.js';
import { registerChannel, listChannels, setChannelEnabled, isChannelEnabled, getPrimaryChannel, startNotificationBridge } from '../channels/router.js';
import { initWhatsAppChannel } from '../channels/whatsapp.js';
import { MODEL_CATALOG, PROVIDER_LIST } from '../llm/providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildServer({ dbPath, port }) {
  initStore(dbPath);
  initWhatsAppChannel();
  startNotificationBridge();

  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  // --- REST routes ---
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

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

  app.get('/api/jobs', async (req) => listJobs({ specId: req.query.specId }));
  app.get('/api/jobs/:id', async (req) => getJob(req.params.id));
  app.get('/api/jobs/:id/logs', async (req) => jobLogs(req.params.id, { limit: req.query.limit }));
  app.post('/api/specs/:id/run', async (req) => {
    const jobId = await runJob({ specId: req.params.id, ...(req.body || {}) });
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
  }));

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
    mk(EVT.JOB_UPDATED, p => socket.emit('job', p));
    mk(EVT.JOB_LOG, p => { if (socket.jobFilters?.includes(p.jobId) || !socket.jobFilters?.length) socket.emit('log', p); });
    mk(EVT.NOTIFY, p => socket.emit('notify', p));

    socket.on('watch-job', (jobId) => { socket.jobFilters = [jobId]; });
    socket.on('watch-all', () => { socket.jobFilters = []; });

    socket.on('disconnect', () => subs.forEach(fn => fn()));
  });

  return { app, io, listen: () => new Promise((res, rej) => {
    app.listen({ port: port ?? 9120, host: '0.0.0.0' }, (err) => err ? rej(err) : res(app.server.address().port));
  }) };
}