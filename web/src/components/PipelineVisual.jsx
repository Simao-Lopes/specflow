import React, { useEffect, useState } from 'react';
import api from '../api.js';
import { statusClass } from './SpecBoard.jsx';

// Shared helper: derive per-step pipeline state from step events, the job's
// current index and gate state. Status priority: failed > passed/done > running
// (current) > gated (awaiting approval) > pending.
export function deriveStepState(step, jobs, selectedJob, stepEvents, steps) {
  const job = (jobs || []).find((j) => String(j.id) === String(selectedJob));
  const events = Array.isArray(stepEvents)
    ? stepEvents.filter((s) => s && job && String(s.job_id) === String(job.id) && String(s.step_id) === String(step.id))
    : [];

  if (events.length) {
    const last = events[events.length - 1];
    if (last && typeof last.status === 'string' && last.status !== 'pending') {
      return { state: last.status, attempt: last.attempt, detail: last.detail, job, last };
    }
  }

  const pos = (steps) => (Array.isArray(job?.steps) ? job.steps : steps).findIndex((s) => String(s.id) === String(step.id));
  const current = typeof job?.step_index === 'number' ? job.step_index : 0;
  const p = pos(steps);

  if (job && p === current) {
    if (job.gate_state === 'waiting' && String(job.gate_step) === String(step.name || step.id)) {
      return { state: 'gated', job, last: null };
    }
    return { state: (job.status === 'error' || job.status === 'failed_or_error') ? 'failed' : 'running', job, last: null };
  }
  if (job && p < current) return { state: 'passed', job, last: null };
  if (job && p > current) return { state: 'pending', job, last: null };
  return { state: 'pending', job, last: null };
}

export function agentIcon(status) {
  switch (status) {
    case 'running': return '◉';
    case 'passed': case 'done': return '✓';
    case 'failed': return '✕';
    case 'iterating': return '↻';
    case 'skipped': return '–';
    case 'gated': return '⏸';
    default: return '◦';
  }
}

const STATE_LABEL = {
  running: 'working…', iterating: 'iterating', passed: 'passed', done: 'done',
  failed: 'failed', skipped: 'skipped', gated: 'awaiting human', pending: 'queued',
};

// ── Per-step collapsible body: Files + Git + Chat ──────────────────────────
function GatedControls({ job, onGate }) {
  const [note, setNote] = useState('');
  const act = (action) => onGate && onGate(job, action, note.trim());
  const failed = job && job.gate_state === 'failed';
  return (
    <div className={`rail-gate ${failed ? 'rail-gate-failed' : ''}`}>
      <input
        className="input mono gate-note"
        placeholder={failed ? 'Optional note (sent to the agent on retry)…' : 'Feedback (adapts this phase on revise)…'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="gate-btns">
        <button className="btn primary small" onClick={() => act('retry')}>⟳ Retry</button>
        <button className="btn danger small" onClick={() => act('reject')}>✕ Reject</button>
        {failed
          ? <button className="btn ghost small" onClick={() => act('approve')}>Skip & continue</button>
          : <button className="btn ghost small" onClick={() => act('approve')}>✓ Approve</button>}
        {!failed && <button className="btn amber small" onClick={() => act('revise')}>✎ Revise w/ feedback</button>}
      </div>
    </div>
  );
}

function StepBody({ jobId, step, messages, onSendMessage }) {
  const [tab, setTab] = useState('files');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const load = async () => {
    if (!jobId) return;
    setLoading(true);
    try { setData(await api.jobArtifacts(jobId)); } catch { setData(null); }
    setLoading(false);
  };
  useEffect(() => { if ((tab === 'files' || tab === 'git') && !data) load(); }, [tab, jobId]); // eslint-disable-line

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try { await onSendMessage(draft.trim()); setDraft(''); } finally { setSending(false); }
  };

  const isCode = /code|implement|plan/.test(String(step?.name || '').toLowerCase());

  return (
    <div className="step-body">
      <div className="step-tabs">
        <button className={`step-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>Files</button>
        {isCode && <button className={`step-tab ${tab === 'git' ? 'active' : ''}`} onClick={() => setTab('git')}>Git</button>}
        <button className={`step-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>Discuss</button>
      </div>

      {tab === 'files' && (
        <div className="step-tab-body">
          {loading ? <p className="muted small">Scanning worktree…</p>
            : !data || !data.success ? <p className="muted small">No artifacts accessible.</p>
            : data.artifacts.length === 0 ? <p className="muted small">No artifacts produced yet.</p>
            : (
              <ul className="file-list">
                {data.artifacts.map((a, i) => (
                  <li key={i} className="file-row">
                    <span className="file-path mono">{a.path}</span>
                    <span className="file-size mono small muted">{a.size} B</span>
                  </li>
                ))}
              </ul>
            )}
          {data?.git && (
            <div className="git-summary">
              <div className="git-summary-line mono small">⬢ {data.git.branch || '?'}</div>
              {data.git.remote && <div className="git-summary-line mono small muted">{data.git.remote}</div>}
              {data.git.pr_url && <a className="git-summary-line mono small" href={data.git.pr_url} target="_blank" rel="noreferrer">Open PR ↗</a>}
            </div>
          )}
        </div>
      )}

      {tab === 'git' && <GitPanel jobId={jobId} />}

      {tab === 'chat' && (
        <div className="chat-panel">
          <div className="chat-thread">
            {(messages || []).filter((m) => !m.in_reply_job || String(m.in_reply_job) === String(jobId)).length === 0
              ? <p className="muted small">No discussion yet for this phase.</p>
              : messages.filter((m) => !m.in_reply_job || String(m.in_reply_job) === String(jobId)).map((m, i) => (
                <div key={i} className={`chat-msg msg-${m.author === 'human' ? 'human' : m.author === 'specflow' ? 'system' : 'agent'}`}>
                  <span className="chat-role mono small">{m.author}</span>
                  <span className="chat-content">{m.content}</span>
                </div>
              ))}
          </div>
          <div className="chat-input">
            <input
              className="input mono"
              placeholder="Give feedback to the agent (adapts the spec / next step)…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            />
            <button className="btn primary small" onClick={send} disabled={sending || !draft.trim()}>{sending ? '…' : 'Send'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Git history panel (full commits, graph, uncommitted).
function GitPanel({ jobId }) {
  const [h, setH] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    api.jobGitHistory(jobId).then((d) => { if (alive) { if (d.success) setH(d); else setErr(d.error); } })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [jobId]);

  if (err) return <p className="muted small">Git unavailable: {err}</p>;
  if (!h) return <p className="muted small">Loading git history…</p>;
  return (
    <div className="git-panel">
      <div className="git-meta mono small">
        <span>⬢ {h.branch}</span>
        {h.pr_url && <a href={h.pr_url} target="_blank" rel="noreferrer">PR ↗</a>}
        {h.uncommitted ? <span className="git-dirty">● {h.uncommitted.split('\n').length} uncommitted</span> : <span className="git-clean">✓ clean</span>}
      </div>
      {h.graph && h.graph.length > 0 && (
        <div className="git-graph mono"><pre>{h.graph.join('\n')}</pre></div>
      )}
      <ul className="commit-list">
        {h.commits.map((c, i) => (
          <li key={i} className="commit-row">
            <span className="commit-hash mono small">{c.short}</span>
            <span className="commit-subject">{c.subject}</span>
            <span className="commit-meta mono small muted">{c.author}{c.at ? ` · ${new Date(c.at * 1000).toLocaleString()}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PipelineVisual({
  steps, jobs, selectedJob, stepEvents, onGate, messages, onSendMessage,
}) {
  // Auto-expand the active/gated phase so the flow isn't empty on load.
  const activeIdx = (() => {
    for (let i = 0; i < (steps || []).length; i++) {
      const { state } = deriveStepState(steps[i], jobs, selectedJob, stepEvents, steps);
      if (state === 'running' || state === 'gated' || state === 'iterating') return i;
    }
    return null;
  })();
  const [openStep, setOpenStep] = useState(activeIdx);
  // When the active phase changes (e.g. gate arrives), follow it.
  useEffect(() => { if (activeIdx != null) setOpenStep(activeIdx); }, [activeIdx]);

  if (!steps || steps.length === 0) return <p className="muted">No steps configured for this pipeline.</p>;

  const job = (jobs || []).find((j) => String(j.id) === String(selectedJob));

  // Live agent activity: reverse-chron stream of step events (+ job gate state).
  const activity = [
    ...(Array.isArray(stepEvents)
      ? stepEvents.filter((s) => s && job && String(s.job_id) === String(job.id)).map((s) => ({ type: 'step', ...s }))
      : []),
  ];
  if (job && job.gate_state === 'waiting') activity.push({ type: 'gate', name: job.gate_step || 'next step', state: 'gated', attempt: 1 });
  activity.reverse();

  const toggle = (i) => setOpenStep(openStep === i ? null : i);

  return (
    <div className="pipeline-rail">
      <ol className="rail-steps">
        {steps.map((step, i) => {
          const { state, attempt, detail } = deriveStepState(step, jobs, selectedJob, stepEvents, steps);
          const active = state === 'running' || state === 'gated' || state === 'iterating';
          const open = openStep === i;
          // Show gate controls on the gated step OR on the failed step that is the
          // current gate target (failure gates carry state 'failed', not 'gated').
          const isGateTarget = job && (job.gate_state === 'waiting' || job.gate_state === 'failed')
            && String(job.gate_step) === String(step.name || step.id);
          const isGatedForThis = state === 'gated' || isGateTarget;
          return (
            <li key={step.id || i} className={`rail-step rail-${state}`}>
              <div className="rail-track">
                <button className={`rail-node ${state === 'running' ? 'spin' : ''}`} onClick={() => toggle(i)} title="Expand phase" aria-label="Expand phase">
                  {state === 'running' ? '◌' : agentIcon(state)}
                </button>
                {i < steps.length - 1 && <span className="rail-line" />}
              </div>
              <div className="rail-body">
                <button className="rail-head" onClick={() => toggle(i)}>
                  <div className="rail-top">
                    <span className="rail-label">{step.name || '(unnamed)'}</span>
                    <span className={`badge status-${state}`}>{STATE_LABEL[state] || state}</span>
                    <span className={`chev ${open ? 'open' : ''}`}>▾</span>
                  </div>
                  {Array.isArray(step.verify) && step.verify.length > 0 && (
                    <span className="rail-meta mono small">
                      ⇄ {step.verify.map((v) => v.name || '(unnamed)').join(', ')}
                      {(step.iterations || 1) > 1 ? ` · iterate ×${step.iterations}` : ''}
                    </span>
                  )}
                  <span className="rail-meta mono small">{step.method ? `[${step.method}]` : ''}{attempt != null && (active) ? ` · attempt ${attempt}` : ''}</span>
                  {detail && <span className="rail-detail mono small">{detail}</span>}
                </button>

                {isGatedForThis && <GatedControls job={job} onGate={onGate} />}

                {open && (
                  <StepBody
                    jobId={selectedJob}
                    step={step}
                    messages={messages}
                    onSendMessage={onSendMessage}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="rail-stream">
        <div className="stream-head">Agent activity</div>
        {activity.length === 0 ? <p className="muted small">Run a pipeline to stream live agent activity here.</p>
          : activity.slice(0, 40).map((a, i) => (
            <div key={i} className={`stream-line ${a.type === 'gate' ? 'stream-gate' : ''}`}>
              <span className={`stream-ic status-${a.state}`}>{agentIcon(a.state)}</span>
              <span className="stream-name">{a.name || a.step_id}</span>
              {a.attempt != null && <span className="mono small muted">att {a.attempt}</span>}
              {a.detail && <span className="stream-detail mono small">{a.detail}</span>}
            </div>
          ))}
      </div>
    </div>
  );
}
