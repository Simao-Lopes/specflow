import { useEffect, useState } from 'react';
import api from '../api.js';
import StepsBuilder, { defaultSteps, flowHint } from './StepsBuilder.jsx';

export default function Pipelines({
  pipelines,
  onNotify,
  editor,
  onEditorChange,
  onCreated,
  onCancelNew,
  onChanged,
  pipelineEvent,
  models,
}) {
  // Editor state, synced from App-driven `editor` (mode: 'new' | 'edit').
  const [steps, setSteps] = useState(() => defaultSteps());
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);
  // Resolved prompts per step id (method templates filled), loaded once for the
  // pipeline being edited so the PromptEditor shows the real prompt reliably.
  const [resolvedPrompts, setResolvedPrompts] = useState({});

  // Method library (industry templates + custom actions), fetched once on mount.
  const [methods, setMethods] = useState(undefined);

  useEffect(() => {
    let active = true;
    api.getMethods()
      .then((data) => { if (active) setMethods(data || undefined); })
      .catch(() => { if (active) setMethods(undefined); }); // graceful fallback
    return () => { active = false; };
  }, []);

  // Re-sync from the backend whenever a 'pipeline' socket event fires.
  useEffect(() => {
    if (Array.isArray(pipelineEvent) && pipelineEvent.length) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineEvent]);

  // Reset the local editor form whenever the App asks us to open (or close) one.
  useEffect(() => {
    if (!editor) return;
    if (editor.mode === 'edit' && editor.pipeline) {
      const pid = editor.pipeline.id;
      setSteps(Array.isArray(editor.pipeline.steps) && editor.pipeline.steps.length ? editor.pipeline.steps : defaultSteps());
      setForm({ name: editor.pipeline.name || '', description: editor.pipeline.description || '' });
      // Preload resolved prompts so each step's editor shows the real (filled)
      // method prompt instead of a blank box.
      setResolvedPrompts({});
      api.pipelinePrompts(pid)
        .then((r) => {
          if (r && Array.isArray(r.steps)) {
            const map = {};
            r.steps.forEach((s) => { if (s && s.id != null) map[String(s.id)] = s.prompt || ''; });
            setResolvedPrompts(map);
          }
        })
        .catch(() => {});
    } else {
      setSteps(defaultSteps());
      setForm({ name: '', description: '' });
      setResolvedPrompts({});
    }
  }, [editor]);

  const isEdit = editor?.mode === 'edit';

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { onNotify('Pipeline name is required', 'error'); return; }
    if (!steps.length) { onNotify('Add at least one step', 'error'); return; }
    setSaving(true);
    try {
      if (isEdit && editor.pipeline?.id) {
        const upd = await api.updatePipeline(editor.pipeline.id, { name: form.name.trim(), description: form.description, steps });
        onNotify(`Pipeline "${upd.name || form.name}" updated`, 'success');
        onChanged();
        onEditorChange(null);
      } else {
        const created = await api.createPipeline({ name: form.name.trim(), description: form.description, steps });
        onNotify(`Pipeline "${created.name}" created`, 'success');
        onChanged();
        onCreated(created);
      }
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setSaving(false); }
  };

  const cancel = () => {
    onCancelNew();
    onEditorChange(null);
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete pipeline "${p.name}"? Specs using it will be re-pointed to 'default'.`)) return;
    try {
      await api.deletePipeline(p.id);
      onNotify('Pipeline deleted', 'info');
      onChanged();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  return (
    <section className="view">
      <div className="view-head">
        <h2>Pipelines</h2>
        <button className="btn primary" onClick={() => onEditorChange({ mode: 'new' })}>+ New Pipeline</button>
      </div>

      {editor && (
        <form className="card form" onSubmit={save}>
          <div className="flow-hint mono" title="Pipeline flow">
            <span className="flow-glyph">▸</span> {isEdit ? `Editing: ${form.name || 'pipeline'}` : 'Creating a new pipeline'}
          </div>
          <label className="field">
            <span>Name *</span>
            <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Featured Feature" />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea className="input" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="What does this pipeline do?" />
          </label>

          <StepsBuilder steps={steps} onChange={setSteps} saveLabel={isEdit ? 'Save pipeline' : 'Create pipeline'} onSave={() => save({ preventDefault: () => {} })} saving={saving} models={models} methods={{ templates: methods?.templates || {}, custom: methods?.custom || {}, phases: methods?.phases || {} }} pipelineId={isEdit ? editor.pipeline?.id : null} onNotify={onNotify} resolvedPrompts={resolvedPrompts} />

          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
            <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save Pipeline' : 'Create Pipeline'}</button>
          </div>
        </form>
      )}

      {!editor && (pipelines.length === 0 ? (
        <div className="empty">
          <p>No pipelines yet. Pipelines are reusable step flows that specs select from.</p>
          <button className="btn" onClick={() => onEditorChange({ mode: 'new' })}>Create your first pipeline</button>
        </div>
      ) : (
        <div className="grid pipelines-grid">
          {pipelines.map((p) => (
            <div key={p.id} className="card pipeline-card">
              <div className="pipeline-head">
                <h3>{p.name}</h3>
                <span className="mono chip small">id {String(p.id).slice(0, 8)}</span>
              </div>
              {p.description && <p className="pipeline-desc">{p.description}</p>}
              <div className="flow-hint mono" title="Pipeline flow">
                <span className="flow-glyph">⇢</span> {flowHint(p.steps)}
              </div>
              <div className="pipeline-actions">
                <button className="btn small" onClick={() => onEditorChange({ mode: 'edit', pipeline: p })}>Edit</button>
                <button className="btn small danger" onClick={() => remove(p)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}