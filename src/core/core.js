// Core Orchestration service. Owns the spec lifecycle, the steps pipeline,
// and the job execution engine. A spec is implemented as a chain of editable
// steps (default Plan -> Code); a step may define verify sub-agent(s) and an
// iteration budget so failures (e.g. tests) cause the step to re-run with the
// failure fed back — "code, then test, if test fails iterate".
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb, initStore, defaultPipelineSteps } from './store.js';
import { emit, EVT } from './events.js';
import { runHarness } from '../harnesses/index.js';
import { prepareBranch, commitAndPush, openPullRequest } from '../git/git.js';
import { resolveMethod, materializePrompts, resolvedStepPrompt, resolvedMethodPrompt, METHODS } from '../methods/catalog.js';
import { PIPELINE_PRESETS } from './presets.js';
import { jobDefaults, autoVersionPipeline } from './settings.js';
import { writePipelineToDisk, deletePipelineFromDisk, pipelinesFromDisk } from './pipelinestore.js';

let runner;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------
export function listSpecs() {
  return getDb().prepare('SELECT * FROM specs ORDER BY created_at DESC').all();
}
export function getSpec(id) {
  return getDb().prepare('SELECT * FROM specs WHERE id=?').get(id);
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
    pipeline_id        : input.pipeline_id || 'default',
  };
  getDb().prepare(`INSERT INTO specs (id,title,description,type,status,repo,branch,acceptance_criteria,pipeline_id)
                   VALUES (@id,@title,@description,@type,@status,@repo,@branch,@acceptance_criteria,@pipeline_id)`).run(row);
  emit(EVT.SPEC_UPDATED, getSpec(id));
  return getSpec(id);
}
export function updateSpec(id, patch) {
  const cur = getSpec(id);
  if (!cur) throw new Error('Spec not found');
  const fields = ['title','description','type','status','repo','branch','acceptance_criteria','pipeline_id'];
  const sets = [], vals = {};
  for (const f of fields) {
    if (patch[f] !== undefined) {
      sets.push(`${f}=@${f}`);
      vals[f] = typeof patch[f] === 'object' ? JSON.stringify(patch[f]) : patch[f];
    }
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

// ---------------------------------------------------------------------------
// Pipelines (first-class, reusable step definitions)
// ---------------------------------------------------------------------------
// Default step list used as a fallback/seed.
export function defaultSteps() {
  return defaultPipelineSteps();
}
export function listPipelines() {
  return getDb().prepare('SELECT * FROM pipelines ORDER BY name COLLATE NOCASE').all()
    .map(p => ({ ...p, steps: safeParseSteps(p.steps) }));
}
export function getPipeline(id) {
  const p = getDb().prepare('SELECT * FROM pipelines WHERE id=?').get(id);
  if (!p) return p;
  return { ...p, steps: safeParseSteps(p.steps) };
}
function safeParseSteps(steps) {
  try {
    const s = typeof steps === 'string' ? JSON.parse(steps) : steps;
    return Array.isArray(s) ? s : defaultSteps();
  } catch { return defaultSteps(); }
}
function repoRootPath() {
  return resolve(getDb().prepare('SELECT value FROM config WHERE key=?').get('repo_root')?.value || './work');
}

export function createPipeline(input) {
  const id = input.id || randomUUID().slice(0, 8);
  // Materialize prompts so they are STORED + visible (not implied by a method).
  const steps = materializePrompts(input.steps);
  getDb().prepare('INSERT INTO pipelines (id,name,description,steps) VALUES (@id,@name,@description,@steps)')
    .run({
      id, name: input.name || 'Untitled pipeline',
      description: input.description || '',
      steps: JSON.stringify(Array.isArray(steps) ? steps : defaultSteps()),
    });
  const row = getPipeline(id);
  // Write the durable pipeline folder (struct + prompts/*.md) to disk.
  writePipelineToDisk({ ...row, steps: row.steps }, { repoRoot: repoRootPath() });
  autoVersionPipeline({ id, steps: row ? row.steps : [] });
  emit(EVT.PIPELINE_UPDATED, row);
  return row;
}
export function updatePipeline(id, patch) {
  const cur = getPipeline(id);
  if (!cur) throw new Error('Pipeline not found');
  const fields = ['name','description','steps'];
  const sets = [], vals = {};
  for (const f of fields) {
    if (patch[f] !== undefined) {
      sets.push(`${f}=@${f}`);
      // Materialize prompts on save so they are stored + visible.
      vals[f] = typeof patch[f] === 'object' ? JSON.stringify(f === 'steps' ? materializePrompts(patch[f]) : patch[f]) : patch[f];
    }
  }
  if (sets.length) { vals.id = id; getDb().prepare(`UPDATE pipelines SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=@id`).run(vals); }
  const row = getPipeline(id);
  writePipelineToDisk({ ...row, steps: row.steps }, { repoRoot: repoRootPath() });
  autoVersionPipeline({ id, steps: row ? row.steps : [] });
  emit(EVT.PIPELINE_UPDATED, row);
  return row;
}
export function deletePipeline(id) {
  // Re-point specs using it to the default pipeline.
  getDb().prepare('UPDATE specs SET pipeline_id=? WHERE pipeline_id=?').run('default', id);
  getDb().prepare('DELETE FROM pipelines WHERE id=?').run(id);
  deletePipelineFromDisk(id, { repoRoot: repoRootPath() });
  emit(EVT.PIPELINE_UPDATED, { id, deleted: true });
  emit(EVT.SPEC_UPDATED, { id: '_', refetch: true });
}

// Instantiate one (or all) industry presets into real pipelines. Returns the
// created pipelines. Skips any preset whose unique name already exists.
export function instantiatePresets({ only } = {}) {
  const presets = listPresets();
  const created = [];
  for (const p of presets) {
    if (only && p.name !== only) continue;
    const exists = getDb().prepare('SELECT id FROM pipelines WHERE name=?').get(p.name);
    if (exists) continue;
    created.push(createPipeline({ name: p.name, description: p.description, steps: p.steps }));
  }
  return created;
}
export function listPresets() {
  return PIPELINE_PRESETS;
}

// Load pipelines from the disk store (folders under <repoRoot>/.specflow/pipelines/)
// and upsert them into SQLite, so edits made directly to the folder/*.md files
// are honoured. Called on server start. Returns the number of pipelines loaded.
export function syncPipelinesFromDisk() {
  const root = repoRootPath();
  const dirs = pipelinesFromDisk({ repoRoot: root });
  let loaded = 0;
  for (const p of dirs) {
    if (!p.id) continue;
    const exists = getDb().prepare('SELECT id FROM pipelines WHERE id=?').get(p.id);
    if (exists) {
      updatePipeline(p.id, { name: p.name, description: p.description, steps: p.steps });
    } else {
      createPipeline({ id: p.id, name: p.name, description: p.description, steps: p.steps });
    }
    loaded++;
  }
  return loaded;
}

// Make sure every pipeline's step prompts are MATERIALIZED (stored + visible),
// even ones created before this feature existed. Idempotent: fills empty
// step.prompt with the effective prompt and writes them to disk. Also refreshes
// steps whose stored prompt is STALE versus the current method template (e.g.
// after upgrading to the authentic Spec Kit command files).
export function materializeAllPrompts() {
  const all = listPipelines();
  let updated = 0;
  for (const p of all) {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    let changed = false;
    const next = steps.map((s) => {
      const resolved = resolvedMethodPrompt(s);
      const stale = (s && s.prompt != null && String(s.prompt).trim())
        && !matchesCurrent(s, resolved);
      if (!(s && s.prompt && String(s.prompt).trim()) || stale) {
        changed = true;
        return { ...s, prompt: resolved };
      }
      return s;
    });
    if (changed) updatePipeline(p.id, { steps: next });
    updated++;
  }
  return updated;
}

// A step's stored prompt stays valid if it already carries the authentic method
// content, OR if it's a hand-written prompt. Only refresh when the method now
// ships an authentic file and the stored prompt is still the old placeholder.
function matchesCurrent(s, resolved) {
  const stored = String(s.prompt || '').trim();
  const methodHasFile = hasMethodFile(s.method);
  // Already has the authentic instruction -> keep (idempotent).
  if (methodHasFile && stored.includes('Official /')) return true;
  return stored === resolved;
}

function hasMethodFile(methodId) {
  if (!methodId) return false;
  for (const list of Object.values(METHODS)) {
    const t = list.find((x) => x.id === methodId);
    if (t && t.file) return true;
  }
  return false;
}

// Resolve a spec's effective steps: from its pipeline, falling back to its own
// legacy inline steps, then the default pipeline.
export function stepsOf(spec) {
  if (!spec) return [];
  if (spec.pipeline_id) {
    const p = getPipeline(spec.pipeline_id);
    if (p && Array.isArray(p.steps) && p.steps.length) return p.steps;
  }
  // Legacy inline steps
  try {
    const s = typeof spec.steps === 'string' ? JSON.parse(spec.steps) : spec.steps;
    if (Array.isArray(s) && s.length) return s;
  } catch {}
  return defaultSteps();
}

// ---------------------------------------------------------------------------
// Session messages (per-spec agent interaction thread)
// ---------------------------------------------------------------------------
export function listMessages(specId) {
  return getDb().prepare('SELECT * FROM messages WHERE spec_id=? ORDER BY id').all(specId);
}
export function addMessage({ specId, role = 'user', author = 'human', content, inReplyJob = null }) {
  const r = getDb().prepare('INSERT INTO messages (spec_id,role,author,content,in_reply_job) VALUES (?,?,?,?,?)')
    .run(specId, role, author, content, inReplyJob);
  const row = getDb().prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid);
  emit(EVT.MESSAGE, row);
  return row;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
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
export function jobSteps(jobId) {
  return getDb().prepare('SELECT * FROM job_steps WHERE job_id=? ORDER BY rowid').all(jobId);
}
function addLog(jobId, message, level = 'info') {
  getDb().prepare('INSERT INTO job_logs (job_id,message,level) VALUES (?,?,?)').run(jobId, message, level);
  emit(EVT.JOB_LOG, { jobId, level, message });
}
function setStep(jobId, step, patch) {
  getDb().prepare(`INSERT INTO job_steps (job_id,step_id,name,attempt,status,detail,finished_at)
                   VALUES (@job_id,@step_id,@name,@attempt,@status,@detail,@finished_at)
                   ON CONFLICT(job_id,step_id) DO UPDATE SET
                     attempt=@attempt,status=@status,detail=@detail,
                     finished_at=COALESCE(@finished_at,finished_at)`).run({
    job_id: jobId, step_id: step.id, name: step.name,
    attempt: patch.attempt ?? 1, status: patch.status, detail: patch.detail || null,
    finished_at: ['passed','failed','skipped'].includes(patch.status) ? new Date().toISOString() : null,
  });
  const row = getDb().prepare('SELECT * FROM job_steps WHERE job_id=? AND step_id=?').get(jobId, step.id);
  emit(EVT.JOB_STEP, row);
}

// Execute a spec through its full steps pipeline with a chosen (or default) agent.
export async function runJob({ specId, harness, model, provider, agentId }) {
  const spec = getSpec(specId);
  if (!spec) throw new Error('Spec not found');
  const agent = agentId ? getDb().prepare('SELECT * FROM agents WHERE id=?').get(agentId)
                        : getDb().prepare('SELECT * FROM agents WHERE active=1 ORDER BY created_at LIMIT 1').get();

  const jobId = randomUUID().slice(0, 8);
  const repo  = spec.repo || agent?.repo || jobDefaults().repo;
  const branch = `${agent?.branch_prefix || 'feature/'}spec-${spec.id}`;
  const job = {
    id: jobId, spec_id: specId,
    harness: harness || agent?.harness || jobDefaults().harness || 'custom',
    model: model || agent?.model || jobDefaults().model || null,
    provider: provider || agent?.provider || jobDefaults().provider || null,
    status: 'queued', repo, branch,
  };
  getDb().prepare(`INSERT INTO jobs (id,spec_id,harness,model,provider,status,repo,branch)
                   VALUES (@id,@spec_id,@harness,@model,@provider,@status,@repo,@branch)`).run(job);
  emit(EVT.JOB_UPDATED, getJob(jobId));
  updateSpec(specId, { status: 'in_progress' });

  runner = runner || startRunner();
  runner.enqueue(jobId);
  return jobId;
}

async function executeJob(jobId) {
  const job = getJob(jobId);
  if (!job) return;
  const repoRoot = resolve(getDb().prepare('SELECT value FROM config WHERE key=?').get('repo_root')?.value || './work');
  const spec = getSpec(job.spec_id);
  const steps = stepsOf(spec);
  const idx = job.step_index || 0;   // index of the step to run now
  if (idx >= steps.length) { finishJob(job, spec); return; }

  try {
    mark(jobId, 'running');

    // One-time checkout setup only on the first (re)entry of a fresh run.
    let workdir;
    if (job.repo) {
      workdir = checkout(repoRoot, job.repo);
      // Always sync branch unless this is a retry of an already-paused pipeline.
      if (job.gate_state !== 'waiting' && job.gate_state !== 'approved') {
        addLog(jobId, `Checking out branch ${job.branch} from ${job.repo}`);
        await prepareBranch({ repoUrl: job.repo, branch: job.branch, base: 'main', repoRoot });
      }
    } else {
      workdir = join(repoRoot, '_scratch', `job-${jobId}`);
      mkdirSync(workdir, { recursive: true });
      if (idx === 0) addLog(jobId, 'No repo configured — working in scratch dir (no git/PR)');
    }

    if (idx === 0) {
      addLog(jobId, `🧪 Starting pipeline: ${steps.map(s => s.name).join(' → ')}`);
      addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Job ${jobId} started · pipeline: ${steps.map(s => s.name).join(' → ')}`, inReplyJob: jobId });
    }

    const step = steps[idx];
    const ok = await executeStep(job, spec, step, { checkout: workdir, repoRoot });
    const nextIdx = idx + 1;

    if (ok) {
      if (nextIdx < steps.length) {
        // HUMAN GATE: pause before running the next step.
        getDb().prepare('UPDATE jobs SET step_index=?, gate_state=\'waiting\', gate_step=? WHERE id=?')
          .run(nextIdx, steps[nextIdx].name, jobId);
        addLog(jobId, `⏸ Step "${step.name}" passed — awaiting human approval to proceed to "${steps[nextIdx].name}"`);
        addMessage({ specId: spec.id, role: 'system', author: 'specflow',
          content: `Gate at "${step.name}" (passed). Waiting for human approval before "${steps[nextIdx].name}".`, inReplyJob: jobId });
        mark(jobId, 'gated');
        return; // paused; resumes on human gate
      } else {
        await finishJob(job, spec, { workdir, steps });
        return;
      }
    } else {
      // Step failed.
      if (step.on_failure === 'continue') {
        if (nextIdx < steps.length) {
          getDb().prepare('UPDATE jobs SET step_index=?, gate_state=\'waiting\', gate_step=? WHERE id=?')
            .run(nextIdx, steps[nextIdx].name, jobId);
          addLog(jobId, `⚠ Step "${step.name}" failed (on_failure=continue) — awaiting human to proceed to "${steps[nextIdx].name}"`);
          addMessage({ specId: spec.id, role: 'system', author: 'specflow',
            content: `Step "${step.name}" FAILED but pipeline continues. Awaiting human gate for "${steps[nextIdx].name}".`, inReplyJob: jobId });
          mark(jobId, 'gated');
          return;
        }
        // last step failed-continue => finish as done w/ note
        addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Job ${jobId}: final step "${step.name}" failed (continue).`, inReplyJob: jobId });
        mark(jobId, 'failed');
        updateSpec(spec.id, { status: 'review' });
        return;
      }
      mark(jobId, 'failed');
      updateSpec(spec.id, { status: 'backlog' });
    }
  } catch (e) {
    const err = e?.message || String(e);
    addLog(jobId, `FAILED: ${err}`, 'error');
    getDb().prepare('UPDATE jobs SET error=? WHERE id=?').run(err, jobId);
    addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Job ${jobId} failed: ${err}`, inReplyJob: jobId });
    mark(jobId, 'failed');
    updateSpec(spec.id, { status: 'backlog' });
  }
}

// Commit, open a PR (never merges), and mark the job done after the final step.
async function finishJob(job, spec, { workdir } = {}) {
  try {
    if (job.repo) {
      addLog(job.id, 'Pipeline complete — committing changes');
      const push = await commitAndPush({ checkout: workdir, branch: job.branch, repoUrl: job.repo, message: `[SpecFlow] ${spec.title}` });
      if (push.changed) {
        addLog(job.id, 'Committed & pushed');
        const pr = await openPullRequest({ repoUrl: job.repo, branch: job.branch, base: 'main', title: `[SpecFlow] ${spec.title}`, body: spec.description });
        if (pr) {
          addLog(job.id, `PR opened: ${pr.url}`);
          getDb().prepare('UPDATE jobs SET pr_url=? WHERE id=?').run(pr.url, job.id);
        }
      }
    }
    addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Job ${job.id} completed successfully.`, inReplyJob: job.id });
    mark(job.id, 'succeeded');
    updateSpec(spec.id, { status: 'review' });
  } catch (e) {
    addLog(job.id, `Finalize error (job already completed steps): ${e?.message}`, 'error');
    mark(job.id, 'succeeded');
    updateSpec(spec.id, { status: 'review' });
  }
}

// Resolve a repo URL to its local checkout path.
function checkout(repoRoot, repoUrl) {
  // e.g. https://github.com/owner/name.git -> <repoRoot>/owner/name
  const m = String(repoUrl).match(/(?:github\.com[/:]|^)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return join(repoRoot, '_repos', Buffer.from(repoUrl).toString('hex').slice(0, 16));
  return join(repoRoot, m[1], m[2]);
}

// Human gate decision (approve / reject / retry).
export async function gateJob(jobId, action, note = '') {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  if (job.gate_state !== 'waiting') throw new Error('No pending gate on this job');

  if (action === 'approve') {
    getDb().prepare('UPDATE jobs SET gate_state=? WHERE id=?').run('approved', jobId);
    addLog(jobId, `✅ Gate approved — proceeding to step "${job.gate_step}"`);
    addMessage({ specId: job.spec_id, role: 'user', author: 'human', content: `Approve next step: ${job.gate_step}${note ? ' — ' + note : ''}`, inReplyJob: jobId });
    mark(jobId, 'running');
    runner.enqueue(jobId);           // resume: execute steps[job.step_index]
    return getJob(jobId);
  }

  if (action === 'reject') {
    getDb().prepare('UPDATE jobs SET gate_state=? WHERE id=?').run('rejected', jobId);
    addLog(jobId, `⛔ Gate rejected by human${note ? ': ' + note : ''}`, 'warn');
    addMessage({ specId: job.spec_id, role: 'user', author: 'human', content: `Reject pipeline at "${job.gate_step}"${note ? ' — ' + note : ''}`, inReplyJob: jobId });
    mark(jobId, 'failed');
    updateSpec(job.spec_id, { status: 'backlog' });
    return getJob(jobId);
  }

  if (action === 'retry') {
    // Re-run the step that just produced this gate.
    const redoIdx = Math.max(0, (job.step_index || 1) - 1);
    getDb().prepare('UPDATE jobs SET step_index=?, gate_state=? WHERE id=?').run(redoIdx, 'retrying', jobId);
    addLog(jobId, `↻ Human requested retry of step at index ${redoIdx}`);
    addMessage({ specId: job.spec_id, role: 'user', author: 'human', content: `Retry step "${job.gate_step}"${note ? ' — ' + note : ''}`, inReplyJob: jobId });
    mark(jobId, 'running');
    runner.enqueue(jobId);
    return getJob(jobId);
  }

  throw new Error('Unknown gate action');
}

// Run one pipeline step, honouring its verify sub-agents and iteration budget.
async function executeStep(job, spec, step, { checkout }) {
  // Resolve an industry-method or custom-action into execution config when the
  // step declares a `method`. Otherwise the step is fully custom as configured.
  const method = resolveMethod(step, { repoRoot: jobRepoRoot() });
  const runStep = method
  ? { ...step, ...pick(method, ['harness', 'command', 'provider', 'model']), prompt: step.prompt || method.prompt || '' }
  : step;

  addLog(jobIdT(job), `— Step: ${step.name}${method ? ` [method: ${method.name}]` : (step.harness ? ` (harness ${step.harness})` : '')}`);
  setStep(jobIdT(job), step, { status: 'running', attempt: 1 });

  const maxIter = Math.max(1, step.iterations || 1);
  let feedback = '';
  let lastErr = null;

  for (let attempt = 1; attempt <= maxIter; attempt++) {
    if (attempt > 1) {
      addLog(jobIdT(job), `  ↻ Iteration ${attempt}/${maxIter} (previous verify failed)`);
      setStep(jobIdT(job), step, { status: 'iterating', attempt });
    }

    // Run the step's own work harness.
    try {
      const result = await runHarness({
        id: jobIdT(job),
        harness: runStep.harness, model: runStep.model || job.model, provider: runStep.provider || job.provider,
        repo: job.repo, branch: job.branch,
        step: runStep, feedback, lifecycle: 'work',
      }, { checkout, repo: job.repo, spec });
      addLog(jobIdT(job), `  [${step.name}] harness done: ${result?.messages || result?.message || 'ok'}`);
      lastErr = null;
    } catch (e) {
      lastErr = e?.message || String(e);
      addLog(jobIdT(job), `  [${step.name}] harness error: ${lastErr}`, 'error');
      feedback = `The work harness reported this error: ${lastErr}`;
      if (!step.verify?.length) {
        setStep(jobIdT(job), step, { status: 'failed', detail: lastErr });
        addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Step "${step.name}" failed: ${lastErr}`, inReplyJob: jobIdT(job) });
        return false;
      }
    }

    // If the step produced no work error, run its verify sub-agents.
    let verifyFailed = false;
    let verifyMsgs = [];
    if (step.verify?.length) {
      addLog(jobIdT(job), `  Running ${step.verify.length} verify sub-agent(s): ${step.verify.map(v => v.name).join(', ')}`);
      for (const v of step.verify) {
        // Verify sub-agents may also declare a method (template or custom action).
        const vMethod = resolveMethod(v, { repoRoot: jobRepoRoot() });
        const runV = vMethod ? { ...v, ...pick(vMethod, ['harness', 'command', 'provider', 'model']), prompt: v.prompt || vMethod.prompt || '' } : v;
        // Gracefully skip verifiers that were added but not yet configured
        // (e.g. a custom verifier with an empty command and no method — a method
        // would supply the harness/command). Don't hard-fail.
        const vh = runV.harness || step.harness || v.harness;
        const unconfigured = !vMethod && vh === 'custom' && !(v.command || '').trim();
        if (unconfigured) {
          addLog(jobIdT(job), `  [${v.name}] not configured (no command) — skipping`);
          setStep(jobIdT(job), v, { status: 'skipped', detail: 'no command' });
          verifyMsgs.push(`[${v.name}] skipped (not configured)`);
          continue;
        }
        setStep(jobIdT(job), v, { status: 'running', attempt: 1 });
        try {
          const vres = await runHarness({
            id: jobIdT(job),
            harness: vh, model: runV.model || job.model, provider: runV.provider || job.provider,
            repo: job.repo, branch: job.branch,
            step: runV, feedback, lifecycle: 'verify',
          }, { checkout, repo: job.repo, spec });
          verifyMsgs.push(`[${v.name}] ${vres?.messages || vres?.message || 'passed'}`);
          addLog(jobIdT(job), `  [${v.name}] verify passed`);
          setStep(jobIdT(job), v, { status: 'passed' });
        } catch (e) {
          verifyFailed = true;
          const vem = e?.message || String(e);
          verifyMsgs.push(`[${v.name}] FAILED: ${vem}`);
          addLog(jobIdT(job), `  [${v.name}] verify FAILED: ${vem}`, 'error');
          setStep(jobIdT(job), v, { status: 'failed', detail: vem });
        }
      }
    }

    if (!verifyFailed) {
      setStep(jobIdT(job), step, { status: 'passed' });
      addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Step "${step.name}" passed.`, inReplyJob: jobIdT(job) });
      return true;
    }

    // Verify failed — prepare feedback for the next iteration.
    feedback = `Your previous work did not pass the verification sub-agents.\nVerification results:\n${verifyMsgs.join('\n')}\nPlease fix the issues and try again.`;
    if (attempt === maxIter) {
      setStep(jobIdT(job), step, { status: 'failed', detail: verifyMsgs.join('; ') });
      addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Step "${step.name}" failed after ${maxIter} iteration(s): ${verifyMsgs.join('; ')}`, inReplyJob: jobIdT(job) });
      return false;
    }
  }
  return false;
}

function jobIdT(job) {
  return typeof job === 'string' ? job : job.id;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '' && obj[k] !== null) out[k] = obj[k];
  return out;
}

function jobRepoRoot() {
  return getDb().prepare('SELECT value FROM config WHERE key=?').get('repo_root')?.value || process.cwd();
}

function getConfigContext(job) {
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
  return { enqueue(jobId) { queue.push(jobId); process.nextTick(drain); } };
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