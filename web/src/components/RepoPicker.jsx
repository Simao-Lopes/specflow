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
  const [customMode, setCustomMode] = useState(() => !!value && !['', globalRepo].includes(value));

  useEffect(() => {
    api.listConnections().then((l) => setConns(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);

  const inConns = conns.some((c) => c.url === value);
  const isGlobal = globalRepo && (!value || String(value) === String(globalRepo));
  const showCustomInput = customMode || (!!value && !inConns && !isGlobal);

  const selectValue = isGlobal ? '__global__'
    : (inConns ? value
      : (showCustomInput ? '__custom__' : ''));

  return (
    <div className="repo-picker">
      {label && <span className="field-label">{label}</span>}
      <select
        className="input mono"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__global__') { setCustomMode(false); onChange(globalRepo || ''); }
          else if (v === '__custom__') { setCustomMode(true); }
          else { setCustomMode(false); onChange(v); }
        }}
      >
        <option value="__global__">{globalRepo ? `Global repo (${displayUrl({ url: globalRepo })})` : 'Global repo (not set)'}</option>
        {conns.length > 0 && <optgroup label="Connected repos">
          {conns.map((c) => <option key={c.id} value={c.url}>{c.name || displayUrl(c)}</option>)}
        </optgroup>}
        <option value="__custom__">Custom repo…</option>
      </select>
      {showCustomInput && (
        <input
          className="input mono"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="owner/repo or https://…"
        />
      )}
      {hint && <em className="settings-hint">{hint}</em>}
    </div>
  );
}