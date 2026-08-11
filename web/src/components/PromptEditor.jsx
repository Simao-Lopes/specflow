import { useCallback, useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import api from '../api.js';

// Format content for display — prompt content may be a plain string OR an
// object like { work, verify } produced by auto-versioned steps.
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    const parts = [];
    if (content.work) parts.push(typeof content.work === 'string' ? content.work : sanitizeAny(content.work));
    if (content.verify) parts.push(typeof content.verify === 'string' ? content.verify : sanitizeAny(content.verify));
    return parts.join('\n\n');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

function sanitizeAny(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// Convert a prompt (string or {work,verify}) to markdown source text safe for
// the editor.
function contentToMd(content) {
  const t = contentToText(content);
  // If it came from an object, render it as readable sectioned markdown.
  if (content !== null && typeof content === 'object') {
    const secs = [];
    if (content.work) secs.push('## Work\n\n' + (typeof content.work === 'string' ? content.work : JSON.stringify(content.work, null, 2)));
    if (content.verify) secs.push('## Verify\n\n' + (typeof content.verify === 'string' ? content.verify : JSON.stringify(content.verify, null, 2)));
    return secs.join('\n\n');
  }
  return t;
}

// Render a prompt version's content into readable markdown source for preview.
function versionContent(version) {
  return contentToMd(version && version.content);
}

export default function PromptEditor({ pipelineId, stepId, prompt, onApplyRestore, notify }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyVersion, setBusyVersion] = useState(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const enabled = Boolean(pipelineId && stepId);

  // Keep the editor text in sync with the step's current prompt (e.g. when a
  // restore happens, or an external edit changes the prompt). Only resync when
  // we are NOT currently focused on typing.
  useEffect(() => {
    setText(contentToMd(prompt));
  }, [prompt]);

  const loadVersions = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError('');
    try {
      const list = await api.promptVersions(pipelineId, stepId);
      setVersions(Array.isArray(list) ? list : []);
    } catch (e) {
      // Silently show nothing on network failure, but keep a hint.
      setVersions([]);
      setError('');
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [enabled, pipelineId, stepId]);

  // Load the version history when the editor is first opened.
  useEffect(() => {
    if (open && !loaded) loadVersions();
  }, [open, loaded, loadVersions]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setText(contentToMd(prompt));
    setNote('');
    setOpen(true);
  };

  const previewHtml = useMemo(() => {
    try {
      return marked.parse(text || '*(empty)*');
    } catch {
      return '<p><em>(could not render)</em></p>';
    }
  }, [text]);

  const onSave = async () => {
    if (!enabled) return;
    setSaving(true);
    setError('');
    try {
      const list = await api.savePromptVersion(pipelineId, stepId, { content: text, ...(note ? { note } : {}) });
      setVersions(Array.isArray(list) ? list : []);
      setNote('');
      notify('Prompt version saved', 'success');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const onRestore = async (version) => {
    if (!enabled) return;
    setBusyVersion(version);
    setError('');
    try {
      const res = await api.restorePromptVersion(pipelineId, stepId, version);
      notify('Prompt restored', 'success');
      // Restore the editor text + tell the parent to update the step's prompt.
      const restored = (Array.isArray(versions) ? versions.find((v) => String(v.version) === String(version)) : null);
      const restoredText = restored ? contentToMd(restored.content) : text;
      setText(restoredText);
      if (onApplyRestore) onApplyRestore(restoredText);
      // Refresh version list to include the new re-version.
      await loadVersions();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyVersion(null);
    }
  };

  return (
    <div className="prompt-editor">
      <button type="button" className={`btn small ghost ${open ? 'prompt-editor-toggle open' : ''}`} onClick={toggle}>
        {open ? '▾' : '▸'} Edit prompt
      </button>

      {open && (
        <div className="prompt-editor-body">
          {!enabled && (
            <p className="muted small prompt-editor-hint">Save the pipeline first to enable prompt versioning.</p>
          )}

          <div className="prompt-editor-split">
            <label className="field">
              <span>Markdown source</span>
              <textarea className="input mono prompt-editor-src" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write the step prompt in markdown…" />
            </label>
            <div className="field">
              <span>Readable preview</span>
              <div className="md-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          </div>

          {enabled && (
            <div className="prompt-save-row">
              <input className="input prompt-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for this version…" />
              <button type="button" className="btn small primary" onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save version'}
              </button>
            </div>
          )}

          {error && <p className="prompt-error">{error}</p>}

          {enabled && (
            <div className="prompt-versions">
              <div className="prompt-versions-head">
                <span className="verify-title">Version history</span>
                {loading && <span className="muted small">…</span>}
              </div>
              {!loading && versions.length === 0 && <p className="muted small">No saved versions yet.</p>}
              {!loading && versions.length > 0 && (
                <ul className="prompt-versions-list">
                  {versions.map((v) => (
                    <li key={v.version} className="prompt-version">
                      <div className="prompt-version-main">
                        <span className="mono small prompt-version-num">v{v.version}</span>
                        <span className="muted small prompt-version-meta">
                          {(v.note || v.watch || '') && <em className="prompt-version-note">{v.note || v.watch}</em>}
                          {v.author ? ` · ${v.author}` : ''}
                          {v.created_at ? ` · ${formatDate(v.created_at)}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn small ghost"
                        disabled={busyVersion !== null}
                        onClick={() => onRestore(v.version)}
                      >
                        {busyVersion === v.version ? '…' : 'Restore'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}