import { useEffect, useRef, useState } from 'react';
import api from '../api.js';
import { TYPES, statusClass, fmtTs } from './SpecBoard.jsx';

const HARNESSES = ['custom', 'hermes', 'claude', 'llm', 'plain'];
const PROVIDERS = ['gemini', 'openrouter', 'nvidia', 'ollama', 'litellm'];

export default function SpecDetail({ specId, config, onNotify, onBack, jobEvent, onRefreshJob }) {
  const [spec, setSpec] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [runForm, setRunForm] = useState({ harness: 'hermes', model: '', provider: 'openrouter' });
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [logs, setLogs] = useState([]); // {id} entries for selectedJob
  const [loadingLogs, setLoadingLogs] = useState(false);
  const logRef = useRef(null);
  const seenLogIds = useRef(new Set());

  // Load spec detail.
  useEffect(() => {
    let alive = true;
    api.getSpec(specId).then((s) => { if (alive) { setSpec(s); setForm(s); } })
      .catch((e) => onNotify(e.message, 'error'));
    api.listJobs(specId).then((list) => { if (alive) setJobs(list); })
      .catch((e) => onNotify(e.message, 'error'));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specId]);

  // Sync with prop job events (arrive via socket through App).
  useEffect(() => {
    if (!Array.isArray(jobEvent)) return;
    setJobs((prev) => {
      let next = prev;
      jobEvent.forEach((j) => {
        if (!j?.id) return;
        const i = next.findIndex((x) => String(x.id) === String(j.id));
        if (i === -1) next = [j, ...next];
        else { const c = [...next]; c[i] = { ...j }; next = c; }
      });
      const merged = [];
      jobEvent.forEach((j) => { const m = merged.find((x) => String(x.id) === String(j.id)); if (m) Object.assign(m, j); else merged.push({ ...j }); });
      return merged.filter((j) => j.spec_id === undefined || String(j.spec_id) === String(specId));
    });
  }, [jobEvent, specId]);

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
    if (!selectedJob) { setLogs([]); return; }
    let alive = true;
    setLoadingLogs(true);
    seenLogIds.current = new Set();
    api.jobLogs(selectedJob, 500).then((entries) => {
      if (!alive) return;
      entries.forEach((e) => seenLogIds.current.add(e.ts + ':' + e.message));
      setLogs(entries || []);
    }).catch((e) => onNotify(e.message, 'error')).finally(() => alive && setLoadingLogs(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob]);

  // Auto-scroll log console to bottom.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, selectedJob]);

  const saveEdit = async (e) => {
    e.preventDefault();
    try {
      const updated = await api.updateSpec(specId, form);
      setSpec(updated);
      setForm(updated);
      setEditing(false);
      onNotify('Spec updated', 'success');
    } catch (err) { onNotify(err.message, 'error'); }
  };

  const pickRun = (provider) => {
    const models = config?.models?.[provider] || [];
    setRunForm((f) => ({ ...f, provider, model: f.model || (models[0] || '') }));
  };

  const startRun = async () => {
    if (!spec) return;
    setRunMenuOpen(false);
    setRunning(true);
    try {
      await api.runSpec(specId, runForm);
      onNotify(`Run queued (${runForm.provider}/${runForm.model || runForm.harness})`, 'success');
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setRunning(false); }
  };

  const doDelete = async () => {
    if (!window.confirm(`Delete spec "${spec.title}" and its jobs?`)) return;
    try {
      await api.deleteSpec(specId);
      onNotify('Spec deleted', 'info');
      onBack();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  const setRunFormWrap = (k) => (e) => setRunForm((f) => ({ ...f, [k]: e.target.value }));

  if (!spec) return <section className="view"><div className="empty"><p>Loading spec…</p></div></section>;

  const modelsForProvider = (p) => (config?.models && config.models[p]) || [];
  const specJobs = jobs;

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
          <button className="btn" onClick={() => setEditing(!editing)}>{editing ? 'Cancel' : 'Edit'}</button>
          <button className="btn danger" onClick={doDelete}>Delete</button>
          <div className="run-wrap">
            <button className="btn primary" onClick={() => setRunMenuOpen((o) => !o)} disabled={running}>
              {running ? 'Running…' : '▶ Run'}
            </button>
            {runMenuOpen && (
              <div className="run-menu card">
                <label className="field">
                  <span>Provider</span>
                  <select className="input" value={runForm.provider} onChange={(e) => pickRun(e.target.value)}>
                    {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Model</span>
                  <select className="input mono" value={runForm.model} onChange={setRunFormWrap('model')}>
                    {modelsForProvider(runForm.provider).length === 0 && <option value="">(custom)</option>}
                    {modelsForProvider(runForm.provider).map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Harness</span>
                  <select className="input" value={runForm.harness} onChange={setRunFormWrap('harness')}>
                    {HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>
                <button className="btn primary block" onClick={startRun}>Queue run</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {editing ? (
        <form className="card form" onSubmit={saveEdit}>
          <label className="field"><span>Title</span><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <div className="row">
            <label className="field"><span>Type</span>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="field"><span>Status</span>
              <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {['backlog', 'in_progress', 'review', 'done'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>Repo</span><input className="input mono" value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} /></label>
          <label className="field"><span>Description</span><textarea className="input" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field"><span>Acceptance Criteria</span><textarea className="input mono" rows={6} value={form.acceptance_criteria} onChange={(e) => setForm({ ...form, acceptance_criteria: e.target.value })} /></label>
          <div className="form-actions"><button type="submit" className="btn primary">Save</button></div>
        </form>
      ) : (
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
      )}

      <h3 className="section-title">Runs</h3>
      <div className="card jobs">
        {specJobs.length === 0 ? (
          <p className="muted">No runs yet. Click <b>▶ Run</b> to get started.</p>
        ) : (
          <table className="jobs-table">
            <thead>
              <tr><th>ID</th><th>Status</th><th>Harness</th><th>Model</th><th>Provider</th><th>PR</th><th>Created</th></tr>
            </thead>
            <tbody>
              {specJobs.map((j) => (
                <tr key={j.id} className={String(j.id) === String(selectedJob) ? 'selected' : ''} onClick={() => setSelectedJob(j.id)}>
                  <td className="mono">{String(j.id).slice(0, 8)}</td>
                  <td><span className={`badge ${statusClass(j.status)}`}>{j.status}</span></td>
                  <td>{j.harness}</td>
                  <td className="mono">{j.model}</td>
                  <td>{j.provider}</td>
                  <td>{j.pr_url ? <a href={j.pr_url} target="_blank" rel="noreferrer">PR ↗</a> : <span className="muted">—</span>}</td>
                  <td className="muted small">{fmtTs(j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {specJobs.filter((j) => j.error).map((j) => (
          <p key={j.id} className="job-error mono">[{String(j.id).slice(0,8)}] {j.error}</p>
        ))}
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
    </section>
  );
}