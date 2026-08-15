import { useState } from 'react';
import api from '../api.js';
import { TYPES } from './SpecBoard.jsx';
import RepoPicker from './RepoPicker.jsx';

const EMPTY = { title: '', description: '', type: 'feature', repo: '', acceptance_criteria: '', pipeline_id: 'default' };

export default function NewSpec({ onNotify, onSaved, pipelines, initialDraft, onDraftChange, onOpenPipelinesForNew, globalRepo }) {
  const [form, setForm] = useState(() => { const d = initialDraft && Object.keys(initialDraft).length ? initialDraft : EMPTY; return { ...EMPTY, ...d }; });
  const [submitting, setSubmitting] = useState(false);

  const set = (k) => (e) => {
    setForm((f) => {
      const nf = { ...f, [k]: e.target.value };
      if (onDraftChange) onDraftChange(nf);
      return nf;
    });
  };

  const changePipeline = (val) => {
    if (val === '__new__') {
      onOpenPipelinesForNew();
      return;
    }
    setForm((f) => {
      const nf = { ...f, pipeline_id: val };
      if (onDraftChange) onDraftChange(nf);
      return nf;
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) { onNotify('Title is required', 'error'); return; }
    setSubmitting(true);
    try {
      const spec = await api.createSpec({ ...form, title: form.title.trim(), pipeline_id: form.pipeline_id || 'default' });
      onNotify(`Created spec "${spec.title || form.title}"`, 'success');
      if (onDraftChange) onDraftChange(EMPTY);
      setForm(EMPTY);
      onSaved();
    } catch (err) {
      onNotify(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedId = form.pipeline_id || 'default';

  return (
    <section className="view">
      <div className="view-head">
        <h2>New Spec</h2>
      </div>
      <form className="card form" onSubmit={submit}>
        <label className="field">
          <span>Title *</span>
          <input className="input" value={form.title} onChange={set('title')} placeholder="e.g. Wire up notifications for failed runs" />
        </label>

        <div className="row">
          <label className="field">
            <span>Type</span>
            <select className="input" value={form.type} onChange={set('type')}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <RepoPicker
            value={form.repo}
            onChange={(v) => setForm((f) => { const nf = { ...f, repo: v }; if (onDraftChange) onDraftChange(nf); return nf; })}
            globalRepo={globalRepo}
            label="Repo"
            hint="Leave as Global repo to write into the shared specs repo"
          />
        </div>

        <label className="field">
          <span>Pipeline</span>
          <select className="input" value={selectedId} onChange={(e) => changePipeline(e.target.value)}>
            {(pipelines || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="default">default</option>
            <option value="__new__">＋ New pipeline…</option>
          </select>
        </label>

        <label className="field">
          <span>Description</span>
          <textarea className="input" rows={4} value={form.description} onChange={set('description')} placeholder="What's the goal? Context for the agent." />
        </label>

        <label className="field">
          <span>Acceptance Criteria</span>
          <textarea className="input mono" rows={6} value={form.acceptance_criteria} onChange={set('acceptance_criteria')} placeholder={'Given…\nWhen…\nThen…\n\nOr lines/bullets describing what "done" looks like.'} />
        </label>

        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Spec'}
          </button>
        </div>
      </form>
    </section>
  );
}