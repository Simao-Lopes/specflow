import { useState } from 'react';

const STATUSES = ['backlog', 'in_progress', 'review', 'done'];
const TYPES = ['feature', 'bug', 'chore', 'enhancement', 'refactor'];

export { STATUSES, TYPES };

export function statusClass(s) { return `status-${(s || 'backlog').replace(/_/g, '-')}`; }

export function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  return d.toLocaleString();
}

export function SpecCard({ spec, onOpen }) {
  return (
    <div className="card spec-card" onClick={() => onOpen(spec.id)} role="button" tabIndex={0}>
      <div className="spec-card-head">
        <span className={`badge type-${spec.type || 'feature'}`}>{spec.type || 'feature'}</span>
        <span className={`badge ${statusClass(spec.status)}`}>{spec.status || 'backlog'}</span>
      </div>
      <h3 className="spec-card-title">{spec.title}</h3>
      <p className="spec-card-desc">{spec.description || 'No description.'}</p>
      <div className="spec-card-foot">
        {spec.repo && <span className="mono chip">{spec.repo}</span>}
        {spec.branch && <span className="mono chip">@{spec.branch}</span>}
      </div>
    </div>
  );
}

export default function SpecBoard({ specs, onOpen, onNotify, onGoNew }) {
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const filtered = (specs || []).filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (filter) {
      const q = filter.toLowerCase();
      const hay = `${s.title} ${s.description || ''} ${s.repo || ''} ${s.type || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const counts = {};
  (specs || []).forEach((s) => { counts[s.status || 'backlog'] = (counts[s.status || 'backlog'] || 0) + 1; });

  return (
    <section className="view">
      <div className="view-head">
        <h2>Spec Board</h2>
        <button className="btn primary" onClick={onGoNew}>+ New Spec</button>
      </div>

      <div className="toolbar">
        <input
          className="input search"
          placeholder="Search specs…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="status-tabs">
          {['all', ...STATUSES].map((s) => (
            <button
              key={s}
              className={`status-tab ${statusFilter === s ? 'active' : ''}`}
              onClick={() => setStatusFilter(s)}
            >
              {s === 'all' ? 'All' : s.replace(/_/g, ' ')}
              {s !== 'all' && counts[s] ? ` (${counts[s]})` : ''}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <p>No specs found.</p>
          <button className="btn" onClick={onGoNew}>Create your first spec</button>
        </div>
      ) : (
        <div className="grid">
          {filtered.map((s) => <SpecCard key={s.id} spec={s} onOpen={onOpen} />)}
        </div>
      )}
    </section>
  );
}