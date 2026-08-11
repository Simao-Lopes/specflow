import { useState } from 'react';
import api from '../api.js';

const HARNESSES = ['custom', 'hermes', 'claude', 'llm', 'plain'];
const PROVIDERS = ['gemini', 'openrouter', 'nvidia', 'ollama', 'litellm'];
const EMPTY = { name: '', harness: 'hermes', model: '', provider: 'openrouter', repo: '', branch_prefix: 'feature/', auto_pr: false, active: true };

function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle" title={label}>
      <span className="toggle-label">{label}</span>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(!!e.target.checked)} />
      <span className="switch" />
    </label>
  );
}

export default function Agents({ agents, config, onNotify, onChanged }) {
  const [editing, setEditing] = useState(null); // agent obj or null
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const startEdit = (agent) => {
    setForm(agent ? { ...agent, auto_pr: !!agent.auto_pr, active: agent.active !== false } : { ...EMPTY });
    setEditing(agent ? agent : { isNew: true });
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setBool = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { onNotify('Name is required', 'error'); return; }
    setSaving(true);
    try {
      if (editing?.id) form.id = editing.id;
      await api.upsertAgent(form);
      onNotify(editing?.id ? 'Agent updated' : 'Agent created', 'success');
      setEditing(null);
      onChanged();
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setSaving(false); }
  };

  const remove = async (agent) => {
    if (!window.confirm(`Delete agent "${agent.name}"?`)) return;
    try { await api.deleteAgent(agent.id); onNotify('Agent deleted', 'info'); onChanged(); }
    catch (err) { onNotify(err.message, 'error'); }
  };

  const modelsForProvider = (p) => (config?.models && config.models[p]) || [];

  return (
    <section className="view">
      <div className="view-head">
        <h2>Agents</h2>
        <button className="btn primary" onClick={() => startEdit(null)}>+ New Agent</button>
      </div>

      {editing && (
        <form className="card form" onSubmit={save}>
          <div className="row">
            <label className="field"><span>Name *</span><input className="input" value={form.name} onChange={set('name')} placeholder="e.g. feature-agent" /></label>
            <label className="field"><span>Harness</span>
              <select className="input" value={form.harness} onChange={set('harness')}>
                {HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field"><span>Provider</span>
              <select className="input" value={form.provider} onChange={set('provider')}>
                {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="field"><span>Model</span>
              <select className="input mono" value={form.model} onChange={set('model')}>
                <option value="">(default)</option>
                {modelsForProvider(form.provider).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field"><span>Repo</span><input className="input mono" value={form.repo} onChange={set('repo')} placeholder="owner/repo or URL" /></label>
            <label className="field"><span>Branch Prefix</span><input className="input mono" value={form.branch_prefix} onChange={set('branch_prefix')} placeholder="feature/" /></label>
          </div>
          <div className="row toggles">
            <Toggle label="Auto PR" checked={form.auto_pr} onChange={setBool('auto_pr')} />
            <Toggle label="Active" checked={form.active} onChange={setBool('active')} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save Agent'}</button>
          </div>
        </form>
      )}

      {(!agents || agents.length === 0) && !editing ? (
        <div className="empty"><p>No agents configured.</p><button className="btn" onClick={() => startEdit(null)}>Configure your first agent</button></div>
      ) : (
        <div className="grid agents-grid">
          {agents.map((a) => (
            <div key={a.id} className="card agent-card">
              <div className="agent-head">
                <h3>{a.name}</h3>
                <span className={`badge ${a.active === false ? 'done' : 'active'}`}>{a.active === false ? 'inactive' : 'active'}</span>
              </div>
              <div className="agent-kvs">
                <div><span className="muted small">Harness</span><span className="mono">{a.harness}</span></div>
                <div><span className="muted small">Model</span><span className="mono">{a.model || '—'}</span></div>
                <div><span className="muted small">Provider</span><span>{a.provider}</span></div>
                {a.repo && <div><span className="muted small">Repo</span><span className="mono">{a.repo}</span></div>}
                {a.branch_prefix && <div><span className="muted small">Branch</span><span className="mono">{a.branch_prefix}</span></div>}
                <div><span className="muted small">Auto PR</span><span>{a.auto_pr ? '✓ yes' : 'no'}</span></div>
              </div>
              <div className="agent-actions">
                <button className="btn small" onClick={() => startEdit(a)}>Edit</button>
                <button className="btn small danger" onClick={() => remove(a)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}