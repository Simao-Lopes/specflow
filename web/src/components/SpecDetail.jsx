import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api.js';
import { TYPES, statusClass, fmtTs } from './SpecBoard.jsx';
import { flowHint } from './StepsBuilder.jsx';
import AgentChat from './AgentChat.jsx';

export default function SpecDetail({
  specId, onNotify, onBack,
  jobEvent, onRefreshJob, stepEvent, messageEvent, specEvent,
  pipelines, onOpenPipelinesForNew,
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
  const logRef = useRef(null);
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

  // Auto-scroll log console to bottom.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, selectedJob]);

  const startRun = async () => {
    if (!spec || running) return;
    setRunning(true);
    try {
      await api.runSpec(specId, {});
      onNotify('Run queued', 'success');
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setRunning(false); loadAll(); }
  };

  const gateAction = async (job, action) => {
    const note = (gateNotes[job.id] || '').trim();
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

  const gatedJobs = jobs.filter((j) => j.status === 'gated' && j.gate_state === 'waiting');
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
            {spec.repo && <span className="mono chip">{spec.repo}</span>}
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
        </div>
        <div className="flow-hint mono" title="Pipeline flow">
          <span className="flow-glyph">⇢</span> {steps.length ? flowHint(steps) : 'No steps configured for this pipeline.'}
        </div>
      </div>

      <h3 className="section-title">Runs</h3>
      <div className="card jobs">
        {gatedJobs.length > 0 && (
          <div className="gate-list">
            {gatedJobs.map((j) => (
              <div key={j.id} className="gate-banner">
                <div className="gate-title">
                  ⏸ Awaiting approval to proceed to <b className="mono">{j.gate_step || 'next step'}</b>
                  <span className="muted small mono"> · job {String(j.id).slice(0, 8)}</span>
                </div>
                <input
                  className="input mono gate-note"
                  placeholder="Optional note (sent to the agent)…"
                  value={gateNotes[j.id] || ''}
                  onChange={(e) => setGateNotes((g) => ({ ...g, [j.id]: e.target.value }))}
                />
                <div className="gate-actions">
                  <button className="btn primary small" onClick={() => gateAction(j, 'approve')}>✓ Approve</button>
                  <button className="btn danger small" onClick={() => gateAction(j, 'reject')}>✕ Reject</button>
                  <button className="btn ghost small" onClick={() => gateAction(j, 'retry')}>⟳ Retry current</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {jobs.length === 0 ? (
          <p className="muted">No runs yet. Click <b>▶ Run</b> to get started.</p>
        ) : (
          <table className="jobs-table">
            <thead>
              <tr><th>ID</th><th>Status</th><th>Step</th><th>PR</th><th>Created</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={String(j.id) === String(selectedJob) ? 'selected' : ''} onClick={() => { selectedJobRef.current = j.id; setSelectedJob(j.id); sessionStorage.setItem(`specflow_seljob_${specId}`, j.id); }}>
                  <td className="mono">{String(j.id).slice(0, 8)}</td>
                  <td>
                    <span className={`badge ${statusClass(j.status)}`}>{j.status}</span>
                    {j.gate_state === 'waiting' && <span className="badge status-gated">⏸ gated</span>}
                  </td>
                  <td>{typeof j.step_index === 'number' ? `step ${j.step_index + 1}` : '—'}{j.gate_step ? <span className="muted small mono"> · {j.gate_step}</span> : null}</td>
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
        {liveStepEvents.length === 0 ? (
          <p className="muted">No live step activity. Start a run to stream pipeline steps here.</p>
        ) : (
          <>
            <p className="muted small">Streaming step status from the active run(s):</p>
            <div className="pipeline-list">
              {liveStepEvents.slice(0, 30).map((s, i) => (
                <div className="pipe-row" key={i}>
                  <span className={`badge ${statusClass(s.status)}`}>{s.status}</span>
                  <span className="pipe-name">{s.name || s.step_id}</span>
                  {s.attempt != null && <span className="mono small muted">attempt {s.attempt}</span>}
                  <span className="mono chip small">job {String(s.job_id).slice(0, 8)}</span>
                  {s.detail && <span className="pipe-detail mono small">{s.detail}</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <h3 className="section-title">Live Log</h3>
      <div className="card console-card">
        {!selectedJob ? (
          <p className="muted">Select a run to view its live log console.</p>
        ) : (
          <>
            <div className="console-head mono">job {selectedJob.slice(0, 8)}… {loadingLogs ? '· loading' : `· ${logs.length} lines`}</div>
            <div className="console" ref={logRef}>
              {logs.length === 0 && <div className="muted">No log output yet.</div>}
              {logs.map((l, i) => (
                <div key={i} className={`log-line ${l.level || 'info'}`}>
                  <span className="log-ts mono">[{fmtTs(l.ts)}]</span>
                  <span className={`log-level mono ${l.level || 'info'}`}>{(l.level || 'info').padEnd(5)}</span>
                  <span className="log-msg">{l.message}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <h3 className="section-title">Agent Session</h3>
      <div className="card chat-card">
        <p className="muted small" style={{ marginTop: 0 }}>
          Chat with the agent working on this spec. Messages are persisted and injected into agent prompts as guidance.
        </p>
        <AgentChat messages={messages} onSend={sendMessage} />
      </div>
    </section>
  );
}