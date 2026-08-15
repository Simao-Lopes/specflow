// RepoPicker: choose where a spec writes its git work.
// Priority: a per-spec repo (selected here) OVERRIDES the global specs repo.
// Options shown: a "use global" default, each git connection, or a custom URL.
import { useEffect, useState } from 'react';
import api from '../api.js';

function displayUrl(c) {
  const u = String(c?.url || c?.name || '');
  return u.replace(/^https:\/\//, '').replace(/\.git$/, '');
}

export default function RepoPicker({ value, onChange, globalRepo, label, hint }) {
  const [conns, setConns] = useState([]);
  const [custom, setCustom] = useState(() => value && !['', global].includes(value) ? value : '');

  useEffect(() => {
    api.listConnections().then((l) => setConns(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);

  const inConns = conns.some((c) => c.url === value);
  const isGlobal = global && (!value || String(value) === String(global));

  return (
    <div className="repo-picker">
      {label && <span className="field-label">{label}</span>}
      <select
        className="input mono"
        value={isGlobal ? '__global__' : (inConns ? value : (value ? '__custom__' : ''))}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__global__') onChange(global || '');
          else if (v === '__custom__') { setCustom(value || ''); onChange(''); }
          else onChange(v);
        }}
      >
        <option value="__global__">{global ? `Global repo (${displayUrl({ url: global })})` : 'Global repo (not set)'}</option>
        {conns.length > 0 && <optgroup label="Connected repos">
          {conns.map((c) => <option key={c.id} value={c.url}>{c.name || displayUrl(c)}</option>)}
        </optgroup>}
        <option value="__custom__">Custom repo…</option>
      </select>
      {(value && !inConns && !isGlobal) && (
        <input
          className="input mono"
          value={custom || value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="owner/repo or https://…"
        />
      )}
      {hint && <em className="settings-hint">{hint}</em>}
    </div>
  );
}