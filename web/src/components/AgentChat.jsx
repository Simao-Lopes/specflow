import { useEffect, useRef, useState } from 'react';
import { fmtTs } from './SpecBoard.jsx';

function Bubble({ m }) {
  const isUser = m.role === 'user';
  const isSystem = m.role === 'system';
  return (
    <div className={`bubble-wrap ${isUser ? 'me' : isSystem ? 'sys' : 'agent'}`}>
      <div className="bubble-meta mono">
        <span className="bubble-author">{m.author || (isUser ? 'human' : 'specflow')} · {m.role || 'message'}</span>
        {m.in_reply_job && <span className="muted">↺ job {String(m.in_reply_job).slice(0, 8)}</span>}
      </div>
      <div className="bubble">{m.content}</div>
      <span className="bubble-ts mono">{m.created_at ? fmtTs(m.created_at) : ''}</span>
    </div>
  );
}

export default function AgentChat({ messages, onSend, disabled }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const submit = async () => {
    const content = text.trim();
    if (!content || disabled || sending) return;
    setSending(true);
    try {
      await onSend(content);
      setText('');
    } catch {
      /* error handled by caller → onNotify */
    } finally {
      setSending(false);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-body" ref={scrollRef}>
        {(!messages || messages.length === 0) ? (
          <p className="muted small">No messages yet. Chat with the agent working on this spec — your guidance is persisted and injected into agent prompts.</p>
        ) : (
          messages.map((m) => <Bubble key={m.id} m={m} />)
        )}
      </div>
      <div className="chat-input-row">
        <textarea
          className="input mono chat-input"
          rows={2}
          placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button className="btn primary" onClick={submit} disabled={disabled || sending || !text.trim()}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}