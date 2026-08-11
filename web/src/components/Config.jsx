import { useEffect, useState } from 'react';
import api from '../api.js';

export default function Config({ config, onNotify, onChanged }) {
  const [toggling, setToggling] = useState(null);
  const [local, setLocal] = useState(() => JSON.stringify(config));

  useEffect(() => {
    if (config) setLocal(JSON.stringify(config));
  }, [config]);

  const toggle = async (name, current) => {
    setToggling(name);
    try {
      await api.setChannel(name, !current);
      onNotify(`Channel "${name}" ${!current ? 'enabled' : 'disabled'}`, 'success');
      onChanged();
    } catch (e) { onNotify(e.message, 'error'); }
    finally { setToggling(null); }
  };

  if (!config) return <section className="view"><div className="empty"><p>Loading config…</p></div></section>;

  const channels = config.channels || [];
  const primary = config.primaryChannel;
  const models = config.models || {};

  return (
    <section className="view">
      <div className="view-head">
        <h2>Config</h2>
      </div>

      <div className="card config-card">
        <div className="config-row">
          <span className="muted small">Primary Channel</span>
          <span className="mono primary-chip">{primary || '— none —'}</span>
        </div>
      </div>

      <h3 className="section-title">Channels</h3>
      <div className="card config-card">
        {channels.length === 0 ? (
          <p className="muted">No channels registered.</p>
        ) : (
          <>
            {channels.map((c) => (
              <div key={c.id} className="config-row">
                <div>
                  <span className="config-name">{c.id}</span>
                  {String(c.id) === String(primary) && <span className="badge active">primary</span>}
                </div>
                <button
                  className={`btn small ${c.enabled ? 'primary' : 'ghost'}`}
                  disabled={toggling === c.id}
                  onClick={() => toggle(c.id, c.enabled)}
                >
                  {toggling === c.id ? '…' : c.enabled ? 'Enabled ✓' : 'Disabled'}
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      <h3 className="section-title">Model Catalog</h3>
      <div className="grid models-grid">
        {Object.entries(models).map(([prov, list]) => (
          <div key={prov} className="card model-card">
            <h3 className="mono">{prov}</h3>
            {(!list || list.length === 0) ? <p className="muted small">No models listed.</p> : (
              <ul>
                {list.map((m) => <li key={m} className="mono small">{m}</li>)}
              </ul>
            )}
          </div>
        ))}
      </div>

      <h3 className="section-title">Raw Config <span className="muted small">(read-only)</span></h3>
      <pre className="criteria mono raw-config">{local}</pre>
    </section>
  );
}