// Core Orchestration service. Owns the spec lifecycle + job execution pipeline.
import { randomUUID } from 'node:crypto';
import { getDb, initStore } from './store.js';
import { emit, EVT } from './events.js';
import { runHarness } from '../harnesses/index.js';
import { prepareBranch, commitAndPush, openPullRequest } from '../git/git.js';

let runner;

// ---- Specs ----
export function listSpecs() {
  return getDb().prepare('SELECT * FROM specs ORDER BY created_at DESC').all();
}
export function getSpec(id) {
  return getDb().prepare('SELECT * FROM specs WHERE id = ?').get(id);
}
export function createSpec(input) {
  const id = randomUUID().slice(0, 8);
  const row = {
    id,
    title              : input.title,
    description        : input.description || '',
    type               : input.type || 'feature',
    status             : 'backlog',
    repo               : input.repo || null,
    branch             : input.branch || null,
    acceptance_criteria: input.acceptance_criteria || '',
  };
  getDb().prepare(`INSERT INTO specs (id,title,description,type,status,repo,branch,acceptance_criteria)
                   VALUES (@id,@title,@description,@type,@status,@repo,@branch,@acceptance_criteria)`).run(row);
  emit(EVT.SPEC_UPDATED, getSpec(id));
  return getSpec(id);
}
export function updateSpec(id, patch) {
  const cur = getSpec(id);
  if (!cur) throw new Error('Spec not found');
  const fields = ['title','description','type','status','repo','branch','acceptance_criteria'];
  const sets = [], vals = {};
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f}=@${f}`); vals[f] = patch[f]; }
  }
  if (sets.length) {
    vals.id = id;
    getDb().prepare(`UPDATE specs SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=@id`).run(vals);
  }
  emit(EVT.SPEC_UPDATED, getSpec(id));
  return getSpec(id);
}
export function deleteSpec(id) {
  getDb().prepare('DELETE FROM specs WHERE id=?').run(id);
  emit(EVT.SPEC_UPDATED, { id, deleted: true });
}

// ---- Agents ----
export function listAgents() {
  return getDb().prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
}
export function upsertAgent(input) {
  const id = input.id || randomUUID().slice(0, 8);
  getDb().prepare(`INSERT INTO agents (id,name,harness,model,provider,repo,branch_prefix,auto_pr,active)
                   VALUES (@id,@name,@harness,@model,@provider,@repo,@branch_prefix,@auto_pr,@active)
                   ON CONFLICT(id) DO UPDATE SET
                     name=@name,harness=@harness,model=@model,provider=@provider,repo=@repo,
                     branch_prefix=@branch_prefix,auto_pr=@auto_pr,active=@active`).run({
    id, name: input.name || 'default',
    harness: input.harness || 'custom', model: input.model || null,
    provider: input.provider || null, repo: input.repo || null,
    branch_prefix: input.branch_prefix || 'feature/', auto_pr: input.auto_pr ? 1 : 0,
    active: input.active !== false ? 1 : 0,
  });
  const row = getDb().prepare('SELECT * FROM agents WHERE id=?').get(id);
  emit(EVT.AGENT_UPDATED, row);
  return row;
}
export function deleteAgent(id) {
  getDb().prepare('DELETE FROM agents WHERE id=?').run(id);
  emit(EVT.AGENT_UPDATED, { id, deleted: true });
}

// ---- Jobs ----
export function listJobs({ specId } = {}) {
  if (specId) return getDb().prepare('SELECT * FROM jobs WHERE spec_id=? ORDER BY created_at DESC').all(specId);
  return getDb().prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
}
export function getJob(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id=?').get(id);
}
export function jobLogs(jobId, { limit = 200 } = {}) {
  return getDb().prepare('SELECT * FROM job_logs WHERE job_id=? ORDER BY id DESC LIMIT ?').all(jobId, limit).reverse();
}
function addLog(jobId, message, level = 'info') {
  getDb().prepare('INSERT INTO job_logs (job_id,message,level) VALUES (?,?,?)').run(jobId, message, level);
  emit(EVT.JOB_LOG, { jobId, level, message });
}

// Execute a spec with a chosen (or default) agent/harness.
export async function runJob({ specId, harness, model, provider, agentId }) {
  const spec = getSpec(specId);
  if (!spec) throw new Error('Spec not found');
  const agent = agentId ? getDb().prepare('SELECT * FROM agents WHERE id=?').get(agentId)
                        : getDb().prepare('SELECT * FROM agents WHERE active=1 ORDER BY created_at LIMIT 1').get();

  const jobId = randomUUID().slice(0, 8);
  const repo  = spec.repo || agent?.repo;
  const branch = `${agent?.branch_prefix || 'feature/'}spec-${spec.id}`;
  const job = {
    id: jobId, spec_id: specId,
    harness: harness || agent?.harness || 'custom',
    model: model || agent?.model || null,
    provider: provider || agent?.provider || null,
    status: 'queued', repo, branch,
  };
  getDb().prepare(`INSERT INTO jobs (id,spec_id,harness,model,provider,status,repo,branch)
                   VALUES (@id,@spec_id,@harness,@model,@provider,@status,@repo,@branch)`).run(job);
  emit(EVT.JOB_UPDATED, getJob(jobId));

  updateSpec(specId, { status: 'in_progress' });

  // Enqueue on async runner
  runner = runner || startRunner();
  runner.enqueue(jobId);
  return jobId;
}

async function executeJob(jobId) {
  const job = getJob(jobId);
  if (!job) { return; }
  const cfg = getDb().prepare('SELECT value FROM config WHERE key=?').get('repo_root');
  const repoRoot = cfg?.value || './work';
  const spec = getSpec(job.spec_id);

  try {
    mark(jobId, 'running');
    addLog(jobId, `Starting job on branch ${job.branch}`);
    const checkout = await prepareBranch({ repoUrl: job.repo, branch: job.branch, base: 'main', repoRoot });
    const result = await runHarness(job, {
      checkout, repo: job.repo, spec,
      config: getConfigContext(job),
    });
    addLog(jobId, `Harness finished: ${result.message || 'ok'}`);

    if (job.repo) {
      const push = await commitAndPush({ checkout, branch: job.branch, repoUrl: job.repo, message: `[SpecFlow] ${spec.title}` });
      if (push.changed) {
        addLog(jobId, 'Committed & pushed changes');
        const pr = await openPullRequest({
          repoUrl: job.repo, branch: job.branch, base: 'main',
          title: `[SpecFlow] ${spec.title}`, body: spec.description,
        });
        if (pr) {
          addLog(jobId, `PR opened: ${pr.url}`);
          getDb().prepare('UPDATE jobs SET pr_url=? WHERE id=?').run(pr.url, jobId);
        }
        updateSpec(job.spec_id, { status: 'review' });
      } else {
        addLog(jobId, 'No changes produced');
        updateSpec(job.spec_id, { status: 'done' });
      }
    } else {
      addLog(jobId, 'No repo configured — job ran in place');
      updateSpec(job.spec_id, { status: 'review' });
    }
    mark(jobId, 'succeeded');
  } catch (e) {
    const err = e?.message || String(e);
    addLog(jobId, `FAILED: ${err}`, 'error');
    getDb().prepare('UPDATE jobs SET error=? WHERE id=?').run(err, jobId);
    mark(jobId, 'failed');
    updateSpec(job.spec_id, { status: 'backlog' });
  }
}

function getConfigContext(job) {
  // Merge job-level config lookup from config table (provider/model defaults)
  const keys = ['provider', 'model', 'custom_command', 'baseUrl', 'apiKey'];
  const out = {};
  for (const k of keys) {
    const r = getDb().prepare('SELECT value FROM config WHERE key=?').get(job.provider ? `${job.provider}_${k}` : k);
    if (r) out[k] = r.value;
  }
  return out;
}

function mark(jobId, status) {
  getDb().prepare(`UPDATE jobs SET status=?, updated_at=datetime('now'),
                   started_at=CASE WHEN started_at IS NULL THEN datetime('now') ELSE started_at END,
                   finished_at=CASE WHEN ?='succeeded' OR ?='failed' THEN datetime('now') ELSE finished_at END
                   WHERE id=?`).run(status, status, status, jobId);
  emit(EVT.JOB_UPDATED, getJob(jobId));
}

// Simple in-process FIFO runner. Extend later for multiple workers.
function startRunner() {
  const queue = [];
  let running = false;
  return {
    enqueue(jobId) {
      queue.push(jobId);
      process.nextTick(drain);
    },
  };
  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      const jobId = queue.shift();
      await executeJob(jobId);
    }
    running = false;
  }
}