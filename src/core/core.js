// Core Orchestration service. Owns the spec lifecycle, the steps pipeline,
// and the job execution engine. A spec is implemented as a chain of editable
// steps (default Plan -> Code); a step may define verify sub-agent(s) and an
// iteration budget so failures (e.g. tests) cause the step to re-run with the
// failure fed back — "code, then test, if test fails iterate".
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb, initStore } from './store.js';
import { emit, EVT } from './events.js';
import { runHarness } from '../harnesses/index.js';
import { prepareBranch, commitAndPush, openPullRequest } from '../git/git.js';

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
    steps              : JSON.stringify(input.steps || defaultSteps()),
  };
  getDb().prepare(`INSERT INTO specs (id,title,description,type,status,repo,branch,acceptance_criteria,steps)
                   VALUES (@id,@title,@description,@type,@status,@repo,@branch,@acceptance_criteria,@steps)`).run(row);
  emit(EVT.SPEC_UPDATED, getSpec(id));
  return getSpec(id);
}
export function updateSpec(id, patch) {
  const cur = getSpec(id);
  if (!cur) throw new Error('Spec not found');
  const fields = ['title','description','type','status','repo','branch','acceptance_criteria','steps'];
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

// Default pipeline when a spec has no steps: Plan then Code.
// Code carries a verify sub-agent skeleton the team can fill in (e.g. a test).
export function defaultSteps() {
  return [
    { id: 'plan', name: 'Plan', harness: 'llm', provider: 'gemini', model: 'gemini-3.5-flash-lite', iterations: 1, on_failure: 'continue', verify: [], prompt: '' },
    { id: 'code', name: 'Code', harness: 'hermes', provider: null, model: null, iterations: 3, on_failure: 'stop', verify: [
      { id: 'test', name: 'Test', harness: 'custom', command: '', iterations: 1, on_failure: 'stop', prompt: '' },
    ], prompt: '' },
  ];
}

export function parseSteps(spec) {
  try {
    const s = typeof spec.steps === 'string' ? JSON.parse(spec.steps) : spec.steps;
    if (Array.isArray(s) && s.length) return s;
  } catch {}
  return defaultSteps();
}
export function stepsOf(spec) { return parseSteps(spec); }

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

  runner = runner || startRunner();
  runner.enqueue(jobId);
  return jobId;
}

async function executeJob(jobId) {
  const job = getJob(jobId);
  if (!job) return;
  const repoRoot = resolve(getDb().prepare('SELECT value FROM config WHERE key=?').get('repo_root')?.value || './work');
  const spec = getSpec(job.spec_id);
  const steps = parseSteps(spec);

  try {
    mark(jobId, 'running');
    addLog(jobId, `🧪 Starting pipeline: ${steps.map(s => s.name).join(' → ')}`);

    // One checkout shared across all steps of this job.
    let checkout = null;
    if (job.repo) {
      addLog(jobId, `Checking out branch ${job.branch} from ${job.repo}`);
      checkout = await prepareBranch({ repoUrl: job.repo, branch: job.branch, base: 'main', repoRoot });
    } else {
      checkout = join(repoRoot, '_scratch', `job-${jobId}`);
      mkdirSync(checkout, { recursive: true });
      addLog(jobId, 'No repo configured — working in scratch dir (no git/PR)');
    }

    // Greet agent-session thread
    addMessage({
      specId: spec.id, role: 'system', author: 'specflow',
      content: `Job ${jobId} started · pipeline: ${steps.map(s => s.name).join(' → ')}`,
      inReplyJob: jobId,
    });

    let aborted = false;
    for (const step of steps) {
      if (aborted) { setStep(jobId, step, { status: 'skipped' }); continue; }
      const ok = await executeStep(job, spec, step, { checkout, repoRoot });
      if (!ok) {
        if (step.on_failure === 'continue') { addLog(jobId, `Step "${step.name}" failed but continuing (on_failure=continue)`); }
        else { aborted = true; }
      }
    }

    // Commit + PR once after the pipeline (if it reached the end with a repo).
    if (job.repo && !aborted) {
      addLog(jobId, 'Pipeline complete — committing changes');
      const push = await commitAndPush({ checkout, branch: job.branch, repoUrl: job.repo, message: `[SpecFlow] ${spec.title}` });
      if (push.changed) {
        addLog(jobId, 'Committed & pushed');
        const pr = await openPullRequest({ repoUrl: job.repo, branch: job.branch, base: 'main', title: `[SpecFlow] ${spec.title}`, body: spec.description });
        if (pr) {
          addLog(jobId, `PR opened: ${pr.url}`);
          getDb().prepare('UPDATE jobs SET pr_url=? WHERE id=?').run(pr.url, jobId);
        }
      }
      updateSpec(spec.id, { status: 'review' });
    } else if (aborted) {
      updateSpec(spec.id, { status: 'backlog' });
    } else {
      updateSpec(spec.id, { status: aborted ? 'backlog' : 'review' });
    }

    addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Job ${jobId} finished (${aborted ? 'aborted after step failure' : 'ok'}).`, inReplyJob: jobId });
    mark(jobId, aborted ? 'failed' : 'succeeded');
  } catch (e) {
    const err = e?.message || String(e);
    addLog(jobId, `FAILED: ${err}`, 'error');
    getDb().prepare('UPDATE jobs SET error=? WHERE id=?').run(err, jobId);
    addMessage({ specId: spec.id, role: 'system', author: 'specflow', content: `Job ${jobId} failed: ${err}`, inReplyJob: jobId });
    mark(jobId, 'failed');
    updateSpec(spec.id, { status: 'backlog' });
  }
}

// Run one pipeline step, honouring its verify sub-agents and iteration budget.
async function executeStep(job, spec, step, { checkout }) {
  addLog(jobIdT(job), `— Step: ${step.name} (harness ${step.harness})`);
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
        harness: step.harness, model: step.model || job.model, provider: step.provider || job.provider,
        repo: job.repo, branch: job.branch,
        step, feedback, lifecycle: 'work',
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
        setStep(jobIdT(job), v, { status: 'running', attempt: 1 });
        try {
          const vres = await runHarness({
            id: jobIdT(job),
            harness: v.harness || step.harness, model: v.model || job.model, provider: v.provider || job.provider,
            repo: job.repo, branch: job.branch,
            step: v, feedback, lifecycle: 'verify',
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