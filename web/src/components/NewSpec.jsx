import { useState } from 'react';
import api from '../api.js';
import { TYPES } from './SpecBoard.jsx';

const EMPTY = { title: '', description: '', type: 'feature', repo: '', acceptance_criteria: '' };

export default function NewSpec({ onNotify, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) { onNotify('Title is required', 'error'); return; }
    setSubmitting(true);
    try {
      const spec = await api.createSpec({ ...form, title: form.title.trim() });
      onNotify(`Created spec "${spec.title || form.title}"`, 'success');
      setForm(EMPTY);
      onSaved();
    } catch (err) {
      onNotify(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

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
          <label className="field">
            <span>Repo</span>
            <input className="input mono" value={form.repo} onChange={set('repo')} placeholder="owner/repo or URL" />
          </label>
        </div>

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