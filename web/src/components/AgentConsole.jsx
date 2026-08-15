import { useEffect, useRef, useState } from 'react';
import { fmtTs } from './SpecBoard.jsx';

// Unified agent console: merges chat messages, job logs and pipeline step
// events into ONE chronological stream, like a harness terminal. Every line
// is stamped with an actor + timestamp; the composer at the bottom chats with
// the agent. No more separate "Live Log" and "Agent Session" panes.

function sortKey(e) {
  // logs use .ts, messages .created_at, steps .ts — all TEXT datetime('now').
  const raw = e.ts || e.created_at || 0;
  if (!raw) { e.__ord = 0; return 0; }
  if (e.__ord != null) return e.__ord;
  const t = new Date(String(raw).replace(' ', 'T') + 'Z').getTime();
  e.__ord = isNaN(t) ? Date.now() : t;
  return e.__ord;
}

function ActorIcon({ kind }) {
  switch (kind) {
    case 'human': return <span className="actor-ic human">H</span>;
    case 'agent': return <span className="actor-ic agent">A</span>;
    case 'system': return <span className="actor-ic sys">⚙</span>;
    case 'log': return <span className="actor-ic log">»</span>;
    case 'step': return <span className="actor-ic step">•</span>;
    default: return <span className="actor-ic">?</span>;
  }
}

export default function AgentConsole({
  messages, logs, stepEvents, selectedJob, onSend, disabled,
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);
  const seen = useRef(new Set());

  // Build the merged chronological timeline.
  const lines = [];
  (Array.isArray(messages) ? messages : []).forEach((m) => {
    lines.push({
      key: 'm' + m.id, kind: m.role === 'user' ? 'human' : (m.author && m.author !== 'specflow' ? 'agent' : 'system'),
      ts: m.created_at, human: m.author || (m.role === 'user' ? 'human' : 'specflow'),
      text: m.content, level: 'msg', jobId: m.in_reply_job || null,
    });
  });
  (Array.isArray(logs) ? logs : []).forEach((l) => {
    if (l.__merged) return;
    lines.push({ key: 'l' + l.id + l.ts, kind: 'log', ts: l.ts, human: 'log', text: l.message, level: l.level || 'info', jobId: l.job_id || null });
  });
  (Array.isArray(stepEvents) ? stepEvents : []).forEach((s) => {
    if (!s || (selectedJob && String(s.job_id) !== String(selectedJob))) return;
    lines.push({ key: 's' + (s.id || s.step_id) + s.ts + s.attempt, kind: 'step', ts: s.ts || '', human: 'step', text: `[${s.status || '…'}] ${s.name || s.step_id}${s.attempt != null ? ` (attempt ${s.attempt})` : ''}${s.detail ? ` — ${s.detail}` : ''}`, level: 'step', jobId: s.job_id || null });
  });

  lines.sort((a, b) => (sortKey(a) - sortKey(b)) || 0);
  lines.forEach((l) => seen.current.add(l.key));

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines.length]);

  const submit = async () => {
    const content = text.trim();
    if (!content || disabled || sending) return;
    setSending(true);
    try { await onSend(content); setText(''); } catch { /* caller notifies */ }
    finally { setSending(false); }
  };
  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };

  return (
    <div className="console-panel">
      <div className="console-body mono" ref={scrollRef}>
        {lines.length === 0 ? (
          <p className="muted small">No activity yet. Run the spec or send a message — chat, logs and steps all appear here.</p>
        ) : lines.map((l, i) => (
          <div key={l.key || i} className={`console-line ${l.level || 'info'} ${l.kind}`}>
            <ActorIcon kind={l.kind} />
            <span className="console-ts">[{l.ts ? fmtTs(l.ts) : ''}]</span>
            <span className="console-actor">{l.human}</span>
            <span className="console-text">{l.text}</span>
          </div>
        ))}
      </div>
      <div className="console-input-row">
        <textarea
          className="input mono console-input" rows={2}
          placeholder="Message the agent… (Enter to send, Shift+Enter for newline)"
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        />
        <button className="btn primary" onClick={submit} disabled={disabled || sending || !text.trim()}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
