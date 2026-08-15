import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api.js';
import { TYPES, statusClass, fmtTs } from './SpecBoard.jsx';
import { flowHint } from './StepsBuilder.jsx';
import AgentConsole from './AgentConsole.jsx';
import AgentChat from './AgentChat.jsx';
import PipelineVisual from './PipelineVisual.jsx';
import RepoPicker from './RepoPicker.jsx';

// Clearly-collapsible section: tappable header with chevron + hint, so it's
// obvious the panel expands/collapses.
export function CollapsibleSection({ title, icon, open: controlled, defaultOpen, onToggle, children, badge }) {
  const [self, setSelf] = useState(defaultOpen ?? true);
  const open = controlled !== undefined ? controlled : self;
  const toggle = () => { if (onToggle) onToggle(!open); else setSelf(!open); };
  return (
    <div className={`collapsible ${open ? 'open' : 'closed'}`}>
      <button className="collapsible-head" onClick={toggle} aria-expanded={open}>
        <span className="collapsible-ic">{icon || '▸'}</span>
        <span className="collapsible-title">{title}</span>
        {badge && <span className="collapsible-badge">{badge}</span>}
        <span className="collapsible-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

// Prominent PR banner for the selected job.
function PRBanner({ job }) {
  if (!job) return null;
  const url = job.pr_url;
  if (!url) {
    // No PR yet — if the job has a branch, point at a manual compare URL.
    const base = job.repo ? job.repo.replace(/\.git$/, '').replace(/^git@github.com:/, 'https://github.com/') : null;
    const compare = (base && job.branch) ? `${base}/compare/main...${job.branch}` : null;
    return (
      <div className="pr-banner pr-none">
        <span className="pr-ic">⎇</span>
        <span className="pr-text">No pull request yet — {job.branch ? <code className="mono">{job.branch}</code> : 'no branch'} on {job.status}</span>
        {compare && <a className="btn ghost small" href={compare} target="_blank" rel="noreferrer">Compare ↗</a>}
      </div>
    );
  }
  return (
    <div className="pr-banner pr-live">
      <span className="pr-ic">⤴</span>
      <span className="pr-text">Pull request ready</span>
      <a className="btn primary small" href={url} target="_blank" rel="noreferrer">Open PR ↗</a>
    </div>
  );
}

export default function SpecDetail({
  specId, onNotify, onBack,
  jobEvent, onRefreshJob, stepEvent, messageEvent, specEvent,
  pipelines, onOpenPipelinesForNew, globalRepo,
}) {
  const [spec, setSpec] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [steps, setSteps] = useState([]);
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const [gateNotes, setGateNotes] = useState({});
  const [syncTick, setSyncTick] = useState(0);
  const seenLogIds = useRef(new Set());
  const seenMsgIds = useRef(new Set());
  const selectedJobRef = useRef(null);

  // Load everything from the backend. Used on mount and re-run on socket events.
  const loadAll = useCallback(() => {
    api.getSpec(specId).then(setSpec).catch((e) => onNotify(e.message, 'error'));
    api.listJobs(specId).then((list) => {
      list = list || [];
      setJobs(list);
      // PERSISTENT LIVE LOG: always ensure we have a valid selected run so the
      // console shows logs. Prefer the saved one if it still exists, else the latest.
      const saved = sessionStorage.getItem(`specflow_seljob_${specId}`);
      const stillExists = list.some((j) => String(j.id) === String(saved));
      if (saved && stillExists) {
        selectedJobRef.current = saved;
        setSelectedJob(saved);
      } else if (list.length) {
        const latest = list[0].id;
        selectedJobRef.current = latest;
        setSelectedJob(latest);
        sessionStorage.setItem(`specflow_seljob_${specId}`, latest);
      }
    }).catch((e) => onNotify(e.message, 'error'));
    api.getSpecSteps(specId)
      .then((s) => setSteps(Array.isArray(s) ? s : []))
      .catch(() => setSteps([]));
    api.listMessages(specId)
      .then((m) => { (m || []).forEach((x) => seenMsgIds.current.add(String(x.id))); setMessages(m || []); })
      .catch((e) => onNotify(e.message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specId]);

  // Restore the previously selected run (and its cached logs) across navigations / reloads.
  useEffect(() => {
    const saved = sessionStorage.getItem(`specflow_seljob_${specId}`);
    if (saved) { selectedJobRef.current = saved; setSelectedJob(saved); }
    const cachedLogs = sessionStorage.getItem(`specflow_logs_${specId}`);
    if (cachedLogs) { try { const arr = JSON.parse(cachedLogs); if (Array.isArray(arr)) { arr.forEach((e) => seenLogIds.current.add(e.ts + ':' + e.message)); setLogs(arr); } } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specId]);

  // Initial load on mount / spec change.
  useEffect(() => { loadAll(); }, [loadAll]);

  // FULL SYNC: refetch spec + jobs + pipeline steps + messages whenever any
  // relevant socket event stream changes. This guarantees the Runs list,
  // pipeline display and chat always reflect backend state (fixes the
  // "running spec but zero runs shown" bug).
  useEffect(() => {
    setSyncTick((t) => t + 1);
  }, [jobEvent, stepEvent, messageEvent, specEvent]);

  useEffect(() => {
    if (syncTick > 0) loadAll();
  }, [syncTick, loadAll]);

  // Append live agent-session messages pushed over the socket (filtered to this spec).
  useEffect(() => {
    if (!Array.isArray(messageEvent)) return;
    const mine = messageEvent.filter((m) => m && m.id !== undefined && String(m.spec_id) === String(specId));
    if (!mine.length) return;
    setMessages((prev) => {
      const next = [...prev];
      mine.forEach((m) => {
        if (seenMsgIds.current.has(String(m.id))) return;
        seenMsgIds.current.add(String(m.id));
        if (!next.some((x) => String(x.id) === String(m.id))) next.push(m);
      });
      return next;
    });
  }, [messageEvent, specId]);

  // Pick up live logs (received in App via watch-all socket) for the selected job.
  useEffect(() => {
    const live = jobEvent?.find((j) => String(j.id) === String(selectedJob))?._liveLogs || [];
    if (!live.length) return;
    setLogs((prev) => {
      const next = [...prev];
      live.forEach((e) => {
        if (!e || seenLogIds.current.has(e.ts + ':' + e.message)) return;
        seenLogIds.current.add(e.ts + ':' + e.message);
        next.push(e);
      });
      return next;
    });
  }, [jobEvent, selectedJob]);

  // Fetch initial logs when a job is selected.
  useEffect(() => {
    if (!selectedJob) { return; }
    let alive = true;
    setLoadingLogs(true);
    api.jobLogs(selectedJob, 500).then((entries) => {
      if (!alive) return;
      seenLogIds.current = new Set();
      entries.forEach((e) => seenLogIds.current.add(e.ts + ':' + e.message));
      setLogs(entries || []);
    }).catch((e) => onNotify(e.message, 'error')).finally(() => alive && setLoadingLogs(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob]);

  // PERSIST live log: cache logs in sessionStorage so they survive navigation/reload.
  useEffect(() => {
    if (!selectedJob) return;
    try { sessionStorage.setItem(`specflow_logs_${specId}`, JSON.stringify(logs.slice(-400))); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, selectedJob, specId]);

  const startRun = async () => {
    if (!spec || running) return;
    setRunning(true);
    try {
      await api.runSpec(specId, {});
      onNotify('Run queued', 'success');
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setRunning(false); loadAll(); }
  };

  const gateAction = async (job, action, noteArg) => {
    const note = (noteArg !== undefined ? noteArg : (gateNotes[job.id] || '')).trim();
    try {
      await api.gateJob(job.id, action, note);
      onNotify(
        action === 'approve' ? 'Approved — continuing the pipeline…'
          : action === 'reject' ? 'Step rejected'
          : 'Retrying current step…',
        'success'
      );
      setGateNotes((g) => ({ ...g, [job.id]: '' }));
      loadAll();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  const changePipeline = async (val) => {
    if (val === '__new__') { onOpenPipelinesForNew(); return; }
    if (!spec || val === spec.pipeline_id) return;
    try {
      await api.updateSpec(specId, { pipeline_id: val });
      onNotify('Pipeline updated', 'success');
      loadAll();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  const changeRepo = async (val) => {
    if (!spec || (spec.repo || '') === (val || '')) return;
    try {
      await api.updateSpec(specId, { repo: val || null });
      onNotify(val ? `Repo set: ${val}` : 'Repo set to Global specs repo', 'success');
      loadAll();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  const doDelete = async () => {
    if (!window.confirm(`Delete spec "${spec.title}" and its jobs?`)) return;
    try {
      await api.deleteSpec(specId);
      onNotify('Spec deleted', 'info');
      onBack();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  const sendMessage = async (content) => {
    const saved = await api.sendMessage(specId, content);
    if (saved && saved.id) {
      seenMsgIds.current.add(String(saved.id));
      setMessages((prev) => (prev.some((x) => String(x.id) === String(saved.id)) ? prev : [...prev, saved]));
    }
    return saved;
  };

  if (!spec) return <section className="view"><div className="empty"><p>Loading spec…</p></div></section>;

  const gatedJobs = jobs.filter((j) => j.status === 'gated' && (j.gate_state === 'waiting' || j.gate_state === 'failed'));
  const pipelineName = spec.pipeline_id
    ? (pipelines || []).find((p) => String(p.id) === String(spec.pipeline_id))?.name
    : null;

  // Live pipeline status from socket 'step' events, limited to jobs belonging to this spec.
  const liveStepEvents = Array.isArray(stepEvent)
    ? stepEvent.filter((s) => s && jobs.some((j) => String(j.id) === String(s.job_id)))
    : [];

  return (
    <section className="view">
      <div className="view-head">
        <button className="btn ghost" onClick={onBack}>← Back</button>
        <div className="view-head-title">
          <h2>{spec.title}</h2>
          <div className="spec-meta">
            <span className={`badge type-${spec.type || 'feature'}`}>{spec.type || 'feature'}</span>
            <span className={`badge ${statusClass(spec.status)}`}>{spec.status}</span>
            <span className="mono chip repo-chip" title={spec.repo || 'Global specs repo'}>
              {spec.repo || '🌐 global specs repo'}
            </span>
            {spec.branch && <span className="mono chip">@{spec.branch}</span>}
          </div>
        </div>
        <div className="head-actions">
          <button className="btn danger" onClick={doDelete}>Delete</button>
          <button className="btn primary" onClick={startRun} disabled={running}>
            {running ? 'Running…' : '▶ Run'}
          </button>
        </div>
      </div>

      <div className="card spec-detail">
        {spec.description && <p className="spec-description">{spec.description}</p>}
        {spec.acceptance_criteria && (
          <div>
            <h4>Acceptance Criteria</h4>
            <pre className="criteria mono">{spec.acceptance_criteria}</pre>
          </div>
        )}
        {!spec.description && !spec.acceptance_criteria && <p className="muted">No description or acceptance criteria yet.</p>}
        <p className="muted small">Created {fmtTs(spec.created_at)}</p>
      </div>

      <h3 className="section-title">Pipeline</h3>
      <div className="card pipeline-card">
        <div className="pipeline-display">
          <div>
            <span className="muted small">Selected pipeline</span>
            <div className="pipeline-name">{pipelineName || <span className="mono">{spec.pipeline_id || 'default'}</span>}</div>
          </div>
          <label className="field pipeline-select">
            <span>Switch pipeline</span>
            <select className="input" value={spec.pipeline_id || 'default'} onChange={(e) => changePipeline(e.target.value)}>
              {(pipelines || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="default">default</option>
              <option value="__new__">＋ New pipeline…</option>
            </select>
          </label>
          <label className="field repo-select">
            <span>Repo</span>
            <RepoPicker
              value={spec.repo || ''}
              onChange={async (v) => { await changeRepo(v); }}
              globalRepo={globalRepo}
              hint="Global = write into the shared specs repo; pick a connection to isolate this project"
            />
          </label>
        </div>
        <div className="flow-hint mono" title="Pipeline flow">
          <span className="flow-glyph">⇢</span> {steps.length ? flowHint(steps) : 'No steps configured for this pipeline.'}
        </div>
      </div>

      <h3 className="section-title">Runs</h3>
      <div className="card jobs">
        {gatedJobs.length > 0 && (
          <div className="gate-list">
            {gatedJobs.map((j) => {
              const failed = j.gate_state === 'failed';
              return (
                <div key={j.id} className={`gate-banner ${failed ? 'gate-failed' : ''}`}>
                  <div className="gate-title">
                    {failed ? '❌ Step failed' : '⏸ Awaiting approval to proceed to'} {failed
                      ? <b className="mono">{j.gate_step || 'this step'}</b>
                      : <b className="mono">{j.gate_step || 'next step'}</b>}
                    <span className="muted small mono"> · job {String(j.id).slice(0, 8)}</span>
                  </div>
                  {failed && j.error && (
                    <div className="gate-error mono small">{j.error}</div>
                  )}
                  <input
                    className="input mono gate-note"
                    placeholder="Optional note (sent to the agent)…"
                    value={gateNotes[j.id] || ''}
                    onChange={(e) => setGateNotes((g) => ({ ...g, [j.id]: e.target.value }))}
                  />
                  <div className="gate-actions">
                    <button className="btn primary small" onClick={() => gateAction(j, 'retry')}>⟳ Retry</button>
                    <button className="btn danger small" onClick={() => gateAction(j, 'reject')}>✕ Reject</button>
                    <button className="btn ghost small" onClick={() => gateAction(j, 'approve')}>Skip & continue</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {jobs.length === 0 ? (
          <p className="muted">No runs yet. Click <b>▶ Run</b> to get started.</p>
        ) : (
          <table className="jobs-table">
            <thead>
              <tr><th>ID</th><th>Status</th><th>Step</th><th>Repo</th><th>PR</th><th>Created</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={String(j.id) === String(selectedJob) ? 'selected' : ''} onClick={() => { selectedJobRef.current = j.id; setSelectedJob(j.id); sessionStorage.setItem(`specflow_seljob_${specId}`, j.id); }}>
                  <td className="mono">{String(j.id).slice(0, 8)}</td>
                  <td>
                    <span className={`badge ${statusClass(j.status)}`}>{j.status}</span>
                    {(j.gate_state === 'waiting' || j.gate_state === 'failed') && j.status === 'gated' && <span className={`badge ${j.gate_state === 'failed' ? 'status-failed' : 'status-gated'}`}>{j.gate_state === 'failed' ? '✕ failed' : '⏸ gated'}</span>}
                  </td>
                  <td>{typeof j.step_index === 'number' ? `step ${j.step_index + 1}` : '—'}{j.gate_step ? <span className="muted small mono"> · {j.gate_step}</span> : null}</td>
                  <td className="repo-cell" title={j.repo || 'scratch (no repo)'}>
                    {j.repo
                      ? <span className="mono small">{j.repo.replace(/^https:\/\//, '').replace(/\.git$/, '')}</span>
                      : <span className="muted small">scratch</span>}
                  </td>
                  <td>{j.pr_url ? <a href={j.pr_url} target="_blank" rel="noreferrer">PR ↗</a> : <span className="muted">—</span>}</td>
                  <td className="muted small">{fmtTs(j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {jobs.filter((j) => j.error).map((j) => (
          <p key={j.id} className="job-error mono">[{String(j.id).slice(0, 8)}] {j.error}</p>
        ))}
      </div>

      <h3 className="section-title">Live Pipeline</h3>
      <div className="card pipeline-card">
        <PRBanner job={(jobs || []).find((j) => String(j.id) === String(selectedJob))} />
        <CollapsibleSection title="Pipeline flow" icon="◫" defaultOpen>
          <PipelineVisual
            steps={steps}
            jobs={jobs}
            selectedJob={selectedJob}
            stepEvents={liveStepEvents}
            onGate={gateAction}
            messages={messages}
            onSendMessage={sendMessage}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Agent activity" icon="⚡" defaultOpen={false}>
          <div className="rail-stream" style={{ borderTop: 'none', paddingTop: 0 }}>
            {liveStepEvents.length === 0 ? <p className="muted small">Run a pipeline to stream live agent activity here.</p>
              : liveStepEvents.slice(0, 40).map((a, i) => (
                <div key={i} className={`stream-line ${a.type === 'gate' ? 'stream-gate' : ''}`}>
                  <span className="stream-ic mono">{a.name || a.step_id}</span>
                  {a.attempt != null && <span className="mono small muted">att {a.attempt}</span>}
                  <span className={`badge ${statusClass(a.status)}`}>{a.status}</span>
                  {a.detail && <span className="stream-detail mono small">{a.detail}</span>}
                </div>
              ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Agent console" icon="⌨" defaultOpen={false}>
          <AgentConsole
            messages={messages}
            logs={logs}
            stepEvents={liveStepEvents}
            selectedJob={selectedJob}
            onSend={sendMessage}
          />
        </CollapsibleSection>
      </div>
    </section>
  );
}