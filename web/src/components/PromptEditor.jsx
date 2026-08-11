import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import api from '../api.js';

// Format content for display — prompt content may be a plain string OR an
// object like { work, verify } produced by structured prompt sources.
function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    const parts = [];
    if (content.work != null) parts.push(typeof content.work === 'string' ? content.work : JSON.stringify(content.work, null, 2));
    if (content.verify != null) parts.push('## Verify\n\n' + (typeof content.verify === 'string' ? content.verify : JSON.stringify(content.verify, null, 2)));
    return parts.join('\n\n');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

function renderMd(text) {
  if (!text || !text.trim()) return '<p class="muted">(no prompt yet)</p>';
  try { return marked.parse(text); } catch { return `<pre>${String(text)}</pre>`; }
}

// Mobile-friendly step prompt editor.
//   - PREVIEW mode (default): shows only the rendered markdown + an Edit button.
//   - EDIT mode: a plain-MD textarea. Save applies the prompt to the step (via
//     onApplyRestore) and returns to preview; Cancel discards.
//   - When a saved pipeline/step id exists, Save also records a version and
//     offers version history + restore in the edit view.
export default function PromptEditor({ pipelineId, stepId, prompt, method, resolvedPrompt, onApplyRestore, notify }) {
  const [mode, setMode] = useState('preview'); // 'preview' | 'edit'
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyVersion, setBusyVersion] = useState(null);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [fetchedResolved, setFetchedResolved] = useState(null);

  const enabled = Boolean(pipelineId && stepId);
  const openRef = useRef(false);

  // Effective prompt: explicit step prompt if present, else the server-resolved
  // method prompt (what the agent would receive).
  const effectivePrompt = (() => {
    const sp = (prompt || '').trim();
    if (sp) return sp;
    if (fetchedResolved != null) return fetchedResolved;
    if (resolvedPrompt != null && resolvedPrompt.trim()) return resolvedPrompt;
    return '';
  })();

  // Fetch the server-resolved (authentic) prompt for method steps.
  useEffect(() => {
    if (!enabled || !method) { setFetchedResolved(null); return; }
    let alive = true;
    api.stepPrompt(pipelineId, stepId)
      .then((r) => { if (alive && r && r.prompt != null) setFetchedResolved(r.prompt); })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pipelineId, stepId, method]);

  const loadVersions = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const list = await api.promptVersions(pipelineId, stepId);
      setVersions(Array.isArray(list) ? list : []);
    } catch { setVersions([]); }
    finally { setLoading(false); }
  }, [enabled, pipelineId, stepId]);

  const openEditor = () => {
    setText(textOf(effectivePrompt));
    setNote('');
    setError('');
    setMode('edit');
    if (enabled && !openRef.current) { openRef.current = true; loadVersions(); }
  };

  const cancel = () => {
    setMode('preview');
    setText('');
    setNote('');
    setError('');
  };

  const save = async () => {
    if (!onApplyRestore) return;
    if (enabled) {
      setSaving(true);
      setError('');
      try {
        await api.savePromptVersion(pipelineId, stepId, { content: text, ...(note ? { note } : {}) });
        await loadVersions();
        notify('Prompt saved & versioned', 'success');
      } catch (e) { setError(e.message); setSaving(false); return; }
    }
    // Back to rendered preview with the applied prompt.
    onApplyRestore(text);
    setMode('preview');
    setText('');
    setNote('');
    setSaving(false);
  };

  const restore = async (version) => {
    setBusyVersion(version);
    try {
      const res = await api.restorePromptVersion(pipelineId, stepId, version);
      const restored = (Array.isArray(versions) ? versions.find((v) => String(v.version) === String(version)) : null);
      const restoredText = restored ? textOf(restored.content) : text;
      setText(restoredText);
      setMode('edit');
      await loadVersions();
      notify('Prompt restored', 'success');
    } catch (e) {
      setError(e.message);
    } finally { setBusyVersion(null); }
  };

  const previewHtml = useMemo(() => renderMd(effectivePrompt), [effectivePrompt]);

  return (
    <div className="prompt-editor">
      {mode === 'preview' ? (
        <div className="prompt-preview">
          <div className="prompt-preview-head">
            <span className="field-label">Prompt</span>
            <button type="button" className="btn small ghost" onClick={openEditor}>✎ Edit</button>
          </div>
          <div className="md-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </div>
      ) : (
        <div className="prompt-edit">
          <div className="prompt-edit-head">
            <span className="field-label">Edit prompt (markdown)</span>
            <div className="prompt-edit-actions">
              <button type="button" className="btn small ghost" onClick={() => setShowHistory((s) => !s)}>History</button>
              <button type="button" className="btn small ghost" onClick={cancel}>Cancel</button>
              <button type="button" className="btn small primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
          <textarea
            className="input mono prompt-md"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write the step prompt in markdown..."
            autoFocus
          />
          {enabled && (
            <div className="prompt-edit-note">
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Version note (optional)…" />
            </div>
          )}
          {error && <p className="prompt-error">{error}</p>}
          {showHistory && (
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
                          {v.note && <em className="prompt-version-note">{v.note}</em>}
                          {v.author ? ` · ${v.author}` : ''}
                        </span>
                      </div>
                      <button type="button" className="btn small ghost" disabled={busyVersion !== null} onClick={() => restore(v.version)}>
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