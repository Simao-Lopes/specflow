import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api.js';

const HARNESSES = ['hermes', 'claude', 'opencode', 'codex', 'gemini', 'aider', 'qwen-code', 'github-copilot'];
const PROVIDERS = ['gemini', 'openrouter', 'nvidia', 'ollama', 'litellm'];

const DEFAULT_SETTINGS = {
  default_harness: 'hermes',
  default_provider: 'gemini',
  default_model: '',
  default_repo: '',
  base_branch: 'main',
  llm_provider: 'gemini',
  llm_model: '',
  primary_channel: '',
  custom_command: '',
  repo_root: '',
};

function Field({ label, children, hint }) {
  return (
    <label className="field settings-field">
      <span>{label}</span>
      {children}
      {hint && <em className="settings-hint">{hint}</em>}
    </label>
  );
}

// Model picker: dropdown of the provider's catalog + a "custom…" free-text
// option. Falls back to a plain text input when the provider has no catalog.
function SettingsModelSelect({ provider, model, onChange, models }) {
  const catalog = (models && provider && models[provider]) || [];
  const inCatalog = catalog.some((m) => m === model);
  const [customMode, setCustomMode] = useState(() => catalog.length > 0 && !!model && !inCatalog);

  if (catalog.length === 0) {
    return (
      <input className="input mono" value={model || ''} onChange={(e) => onChange(e.target.value)} placeholder="model id" />
    );
  }
  return (
    <>
      <select
        className="input mono"
        value={customMode ? '__custom__' : (inCatalog ? model : '')}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') { setCustomMode(true); return; }
          setCustomMode(false);
          onChange(v);
        }}
      >
        <option value="">(default)</option>
        {catalog.map((m) => <option key={m} value={m}>{m}</option>)}
        <option value="__custom__">custom…</option>
      </select>
      {customMode && (
        <input className="input mono model-custom" value={model || ''} onChange={(e) => onChange(e.target.value)} placeholder="custom model id" />
      )}
    </>
  );
}

// Format a connection's url for display (owner/repo or full url).
function displayUrl(conn) {
  if (!conn) return '';
  return conn.url || '';
}

export default function Config({ config, onNotify, onChanged }) {
  const [toggling, setToggling] = useState(null);
  const [local, setLocal] = useState(() => JSON.stringify(config));

  // Preferences editor state.
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [savingSettings, setSavingSettings] = useState(false);

  // Git connections.
  const [connections, setConnections] = useState([]);
  const [connLoading, setConnLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [newConn, setNewConn] = useState({ name: '', url: '', base_branch: 'main' });
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState({}); // id -> 'busy' | 'ok' | 'error'
  const [testResult, setTestResult] = useState({}); // id -> {heads} | {error}

  useEffect(() => {
    if (config) setLocal(JSON.stringify(config));
  }, [config]);

  // Seed the settings form from config.settings (if present), then refresh from
  // /api/settings for the authoritative current values.
  useEffect(() => {
    const seed = { ...DEFAULT_SETTINGS, ...(config?.settings || {}) };
    setSettings(seed);
    api.getSettings()
      .then((s) => { if (s && typeof s === 'object') setSettings((prev) => ({ ...prev, ...s })); })
      .catch(() => { /* fall back to config.settings / defaults */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshConnections = useCallback(async () => {
    setConnLoading(true);
    try {
      const list = await api.listConnections();
      setConnections(Array.isArray(list) ? list : []);
    } catch (e) {
      onNotify(e.message, 'error');
    } finally {
      setConnLoading(false);
    }
  }, [onNotify]);

  useEffect(() => { refreshConnections(); }, [refreshConnections]);

  const toggle = async (name, current) => {
    setToggling(name);
    try {
      await api.setChannel(name, !current);
      onNotify(`Channel "${name}" ${!current ? 'enabled' : 'disabled'}`, 'success');
      onChanged();
    } catch (e) { onNotify(e.message, 'error'); }
    finally { setToggling(null); }
  };

  const saveSettings = async (e) => {
    if (e) e.preventDefault();
    setSavingSettings(true);
    try {
      const body = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (settings[k] !== undefined && settings[k] !== null) body[k] = settings[k];
      }
      await api.updateSettings(body);
      onNotify('Preferences saved', 'success');
      onChanged();
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setSavingSettings(false); }
  };

  const setSetting = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  const addConn = async (e) => {
    e.preventDefault();
    if (!newConn.name.trim()) { onNotify('Connection name is required', 'error'); return; }
    if (!newConn.url.trim()) { onNotify('Connection URL is required', 'error'); return; }
    setAdding(true);
    try {
      await api.addConnection({
        name: newConn.name.trim(),
        url: newConn.url.trim(),
        ...(newConn.base_branch ? { base_branch: newConn.base_branch.trim() } : {}),
      });
      onNotify('Connection added', 'success');
      setNewConn({ name: '', url: '', base_branch: 'main' });
      setFormOpen(false);
      await refreshConnections();
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setAdding(false); }
  };

  const deleteConn = async (c) => {
    if (!window.confirm(`Delete connection "${c.name}"?`)) return;
    try {
      await api.deleteConnection(c.id);
      onNotify('Connection deleted', 'info');
      await refreshConnections();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  const testConn = async (c) => {
    setTesting((t) => ({ ...t, [c.id]: 'busy' }));
    setTestResult((t) => ({ ...t, [c.id]: undefined }));
    try {
      const res = await api.testConnection(c.id);
      if (res && res.ok) {
        setTesting((t) => ({ ...t, [c.id]: 'ok' }));
        setTestResult((t) => ({ ...t, [c.id]: { heads: res.heads || [] } }));
        onNotify(`Connection "${c.name}" OK (${(res.heads || []).length} heads)`, 'success');
      } else {
        setTesting((t) => ({ ...t, [c.id]: 'error' }));
        setTestResult((t) => ({ ...t, [c.id]: { error: (res && res.error) || 'test failed' } }));
        onNotify((res && res.error) || `Connection "${c.name}" failed`, 'error');
      }
    } catch (err) {
      setTesting((t) => ({ ...t, [c.id]: 'error' }));
      setTestResult((t) => ({ ...t, [c.id]: { error: err.message } }));
      onNotify(err.message, 'error');
    }
  };

  // MCP tool connections.
  const [mcps, setMcps] = useState([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [newMcp, setNewMcp] = useState({ name: '', transport: 'stdio', command: '', url: '', args: '' });
  const [addingMcp, setAddingMcp] = useState(false);
  const [testingMcp, setTestingMcp] = useState({}); // id -> 'busy'|'ok'|'error'
  const [mcpTestResult, setMcpTestResult] = useState({}); // id -> {tools}|{error}
  const [presets, setPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [presetEnv, setPresetEnv] = useState({}); // var -> value entered by user

  // Secrets vault.
  const [secrets, setSecrets] = useState([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secFormOpen, setSecFormOpen] = useState(false);
  const [newSecret, setNewSecret] = useState({ key: '', value: '', note: '' });
  const [addingSecret, setAddingSecret] = useState(false);
  const [secShow, setSecShow] = useState({}); // key -> show/hide (flag only; value never displayed back)

  const refreshSecrets = useCallback(async () => {
    setSecretsLoading(true);
    try {
      const list = await api.listSecrets();
      setSecrets(Array.isArray(list) ? list : []);
    } catch (e) { onNotify(e.message, 'error'); }
    finally { setSecretsLoading(false); }
  }, [onNotify]);

  useEffect(() => { refreshSecrets(); }, [refreshSecrets]);

  const addSecret = async (e) => {
    e.preventDefault();
    if (!newSecret.key.trim() || !newSecret.value) { onNotify('Secret key and value are required', 'error'); return; }
    setAddingSecret(true);
    try {
      await api.addSecret(newSecret.key.trim(), newSecret.value, newSecret.note.trim());
      onNotify('Secret stored (encrypted)', 'success');
      setNewSecret({ key: '', value: '', note: '' });
      setSecFormOpen(false);
      await refreshSecrets();
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setAddingSecret(false); }
  };

  const deleteSecret = async (s) => {
    if (!window.confirm(`Delete secret "${s.key}"? This cannot be undone.`)) return;
    try {
      await api.deleteSecret(s.key);
      onNotify('Secret deleted', 'info');
      await refreshSecrets();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  // Harness availability on the server.
  const [harnessAvail, setHarnessAvail] = useState([]);
  const [availLoading, setAvailLoading] = useState(false);

  const refreshHarnessAvail = useCallback(async () => {
    setAvailLoading(true);
    try {
      const list = await api.harnessAvailability();
      setHarnessAvail(Array.isArray(list) ? list : []);
    } catch (e) { setHarnessAvail([]); }
    finally { setAvailLoading(false); }
  }, []);

  useEffect(() => { refreshHarnessAvail(); }, [refreshHarnessAvail]);

  const refreshMcps = useCallback(async () => {
    setMcpLoading(true);
    try {
      const list = await api.listMcp();
      setMcps(Array.isArray(list) ? list : []);
    } catch (e) { onNotify(e.message, 'error'); }
    finally { setMcpLoading(false); }
  }, [onNotify]);

  useEffect(() => { refreshMcps(); }, [refreshMcps]);

  // Load MCP preset templates.
  useEffect(() => {
    api.listMcpPresets()
      .then((list) => { if (Array.isArray(list)) setPresets(list); })
      .catch(() => {});
  }, []);

  // Fill the form from a chosen preset, showing any env (API key) fields.
  const applyPreset = (presetId) => {
    const p = presets.find((x) => x.id === presetId);
    if (!p) return;
    setSelectedPreset(presetId);
    setNewMcp({
      name: p.name,
      transport: p.transport,
      command: p.command || '',
      url: p.url || '',
      args: (p.args || []).join(' '),
    });
    const nextEnv = {};
    (p.env || []).forEach((e) => { nextEnv[e.var] = ''; });
    setPresetEnv(nextEnv);
  };

  const clearPreset = () => {
    setSelectedPreset('');
    setPresetEnv({});
    setNewMcp({ name: '', transport: 'stdio', command: '', url: '', args: '' });
  };

  const addMcp = async (e) => {
    e.preventDefault();
    if (!newMcp.name.trim()) { onNotify('MCP name is required', 'error'); return; }
    if (newMcp.transport !== 'stdio' && !newMcp.url.trim()) { onNotify('MCP URL is required', 'error'); return; }
    if (newMcp.transport === 'stdio' && !newMcp.command.trim()) { onNotify('MCP command is required', 'error'); return; }
    setAddingMcp(true);
    try {
      const args = newMcp.args.split(/[\s,]+/).filter(Boolean);
      // Only send env values the user actually filled in (skip empty API keys).
      const env = {};
      for (const [k, v] of Object.entries(presetEnv)) { if (v && v.trim()) env[k] = v.trim(); }
      await api.addMcp({
        name: newMcp.name.trim(),
        transport: newMcp.transport,
        command: newMcp.transport === 'stdio' ? newMcp.command.trim() : '',
        url: newMcp.transport !== 'stdio' ? newMcp.url.trim() : '',
        args,
        env,
      });
      onNotify('MCP connection added', 'success');
      clearPreset();
      setMcpFormOpen(false);
      await refreshMcps();
    } catch (err) { onNotify(err.message, 'error'); }
    finally { setAddingMcp(false); }
  };

  const deleteMcp = async (c) => {
    if (!window.confirm(`Delete MCP connection "${c.name}"?`)) return;
    try {
      await api.deleteMcp(c.id);
      onNotify('MCP connection deleted', 'info');
      await refreshMcps();
    } catch (err) { onNotify(err.message, 'error'); }
  };

  const testMcp = async (c) => {
    setTestingMcp((t) => ({ ...t, [c.id]: 'busy' }));
    setMcpTestResult((t) => ({ ...t, [c.id]: undefined }));
    try {
      const res = await api.testMcp(c.id);
      if (res && res.ok) {
        setTestingMcp((t) => ({ ...t, [c.id]: 'ok' }));
        setMcpTestResult((t) => ({ ...t, [c.id]: { tools: res.tools || [] } }));
        onNotify(`MCP "${c.name}" OK (${(res.tools || []).length} tools)`, 'success');
      } else {
        setTestingMcp((t) => ({ ...t, [c.id]: 'error' }));
        setMcpTestResult((t) => ({ ...t, [c.id]: { error: (res && res.error) || 'test failed' } }));
        onNotify((res && res.error) || `MCP "${c.name}" failed`, 'error');
      }
    } catch (err) {
      setTestingMcp((t) => ({ ...t, [c.id]: 'error' }));
      setMcpTestResult((t) => ({ ...t, [c.id]: { error: err.message } }));
      onNotify(err.message, 'error');
    }
  };

  const models = useMemo(() => config?.models || {}, [config]);
  const connOptions = useMemo(() => connections.map((c) => ({ id: c.id, name: c.name, url: displayUrl(c) })), [connections]);

  if (!config) return <section className="view"><div className="empty"><p>Loading config…</p></div></section>;

  const channels = config.channels || [];
  const primary = config.primaryChannel;

  const setRepo = (v) => setSetting('default_repo', v);

  return (
    <section className="view">
      <div className="view-head">
        <h2>Config</h2>
      </div>

      {/* ---------- Preferences editor ---------- */}
      <h3 className="section-title">Preferences</h3>
      <form className="card settings-card" onSubmit={saveSettings}>
        <div className="settings-grid">
          <h4 className="settings-group-title">Defaults</h4>
          <Field label="Default harness">
            <select className="input" value={settings.default_harness} onChange={(e) => setSetting('default_harness', e.target.value)}>
              {HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </Field>
          <Field label="Default provider">
            <select className="input" value={settings.default_provider} onChange={(e) => setSetting('default_provider', e.target.value)}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Default model">
            <SettingsModelSelect provider={settings.default_provider} model={settings.default_model} onChange={(m) => setSetting('default_model', m)} models={models} />
          </Field>
          <Field label="Base branch" hint="branch new specs run against">
            <input className="input mono" value={settings.base_branch} onChange={(e) => setSetting('base_branch', e.target.value)} placeholder="main" />
          </Field>

          <h4 className="settings-group-title">LLM</h4>
          <Field label="LLM provider">
            <select className="input" value={settings.llm_provider} onChange={(e) => setSetting('llm_provider', e.target.value)}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="LLM model">
            <SettingsModelSelect provider={settings.llm_provider} model={settings.llm_model} onChange={(m) => setSetting('llm_model', m)} models={models} />
          </Field>

          <h4 className="settings-group-title">Repo</h4>
          <Field label="Default repo (connections)">
            <select
              className="input mono"
              value={connOptions.some((c) => c.url === settings.default_repo) ? settings.default_repo : ''}
              onChange={(e) => setRepo(e.target.value)}
            >
              <option value="">(none)</option>
              {connOptions.map((c) => <option key={c.id} value={c.url}>{c.name || c.url}</option>)}
            </select>
          </Field>
          <Field label="Or repo URL" hint="owner/repo or full https/git url">
            <input className="input mono" value={settings.default_repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo or https://…" />
          </Field>
          <Field label="Repo root">
            <input className="input mono" value={settings.repo_root} onChange={(e) => setSetting('repo_root', e.target.value)} placeholder="e.g. /srv/specflow/repos" />
          </Field>

          <h4 className="settings-group-title">Runtime</h4>
          <Field label="Primary channel">
            <input className="input mono" value={settings.primary_channel} onChange={(e) => setSetting('primary_channel', e.target.value)} placeholder="channel name" />
          </Field>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={savingSettings}>
            {savingSettings ? 'Saving…' : 'Save Preferences'}
          </button>
        </div>
      </form>

      {/* ---------- Harness availability ---------- */}
      <div className="view-head section-head-inline">
        <h3 className="section-title-standalone">Harnesses <span className="muted small">(CLI availability on server)</span></h3>
        <button className="btn small ghost" disabled={availLoading} onClick={refreshHarnessAvail}>
          {availLoading ? '…' : 'Refresh'}
        </button>
      </div>
      <div className="card config-card conns-card">
        {availLoading && !harnessAvail.length ? (
          <p className="muted">Probing installed CLIs…</p>
        ) : (
          <div className="conns-list">
            {harnessAvail.map((h) => (
              <div key={h.id} className="conn-row">
                <div className="conn-main">
                  <span className="config-name">{h.label}</span>
                  <span className="mono small muted conn-url">bin: {h.binary}</span>
                  {h.available && h.version && <span className="chip small mono">{h.version}</span>}
                </div>
                <div className="conn-actions">
                  {h.available
                    ? <span className="badge status-success">✓ installed</span>
                    : (
                      <>
                        <span className="badge status-failed">✗ not found</span>
                        {h.install && (
                          <button
                            type="button"
                            className="btn small ghost"
                            title={h.install}
                            onClick={() => { navigator.clipboard?.writeText(h.install); onNotify(`Install command copied for ${h.label}`, 'success'); }}
                          >
                            Copy install
                          </button>
                        )}
                      </>
                    )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- Git Connections ---------- */}
      <div className="view-head section-head-inline">
        <h3 className="section-title-standalone">Git Connections</h3>
        <button className="btn small ghost" onClick={() => setFormOpen((o) => !o)}>
          {formOpen ? 'Cancel' : '+ Add connection'}
        </button>
      </div>

      {formOpen && (
        <form className="card form conn-form" onSubmit={addConn}>
          <div className="row">
            <Field label="Name *">
              <input className="input" value={newConn.name} onChange={(e) => setNewConn((n) => ({ ...n, name: e.target.value }))} placeholder="e.g. Acme repo" />
            </Field>
            <Field label="URL / ID *">
              <input className="input mono" value={newConn.url} onChange={(e) => setNewConn((n) => ({ ...n, url: e.target.value }))} placeholder="owner/repo or https://…" />
            </Field>
            <Field label="Base branch">
              <input className="input mono" value={newConn.base_branch} onChange={(e) => setNewConn((n) => ({ ...n, base_branch: e.target.value }))} placeholder="main" />
            </Field>
          </div>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={() => setFormOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={adding}>{adding ? 'Adding…' : 'Add connection'}</button>
          </div>
        </form>
      )}

      <div className="card config-card conns-card">
        {connLoading && !connections.length ? (
          <p className="muted">Loading connections…</p>
        ) : connections.length === 0 ? (
          <p className="muted">No git connections yet. Add one to pin repos for specs.</p>
        ) : (
          <div className="conns-list">
            {connections.map((c) => {
              const st = testing[c.id];
              const tr = testResult[c.id];
              return (
                <div key={c.id} className="conn-row">
                  <div className="conn-main">
                    <span className="config-name">{c.name}</span>
                    <span className="mono small muted conn-url">{displayUrl(c)}</span>
                    {c.base_branch && <span className="chip small">{c.base_branch}</span>}
                    {st === 'ok' && <span className="badge status-success">✓ {tr?.heads?.length ?? 0} heads</span>}
                    {st === 'error' && <span className="badge status-failed">✕ {tr?.error || 'failed'}</span>}
                  </div>
                  <div className="conn-actions">
                    <button className="btn small ghost" disabled={st === 'busy'} onClick={() => testConn(c)}>
                      {st === 'busy' ? '…' : 'Test'}
                    </button>
                    <button className="btn small danger" onClick={() => deleteConn(c)}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---------- MCP tool connections ---------- */}
      <div className="view-head section-head-inline">
        <h3 className="section-title-standalone">MCP Connections <span className="muted small">(tools available to all pipeline nodes)</span></h3>
        <button className="btn small ghost" onClick={() => setMcpFormOpen((o) => !o)}>
          {mcpFormOpen ? 'Cancel' : '+ Add MCP'}
        </button>
      </div>

      {mcpFormOpen && (
        <form className="card form conn-form" onSubmit={addMcp}>
          {presets.length > 0 && (
            <Field label="Use a preset" hint="pick a template, paste any API key, add">
              <div className="preset-row">
                <select className="input" value={selectedPreset} onChange={(e) => (e.target.value ? applyPreset(e.target.value) : clearPreset())}>
                  <option value="">— choose a preset —</option>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {selectedPreset && (
                  <p className="muted small preset-desc">{presets.find((p) => p.id === selectedPreset)?.description}</p>
                )}
              </div>
            </Field>
          )}

          {Object.keys(presetEnv).length > 0 && (
            <div className="preset-env">
              <p className="muted small">
                Tip: paste a value, or reference an encrypted secret as <code>{'${secret:KEY}'}</code> (configure below).
              </p>
              {Object.entries(presetEnv).map(([k, v]) => {
                const meta = (presets.find((p) => p.id === selectedPreset)?.env || []).find((e) => e.var === k);
                return (
                  <label className="field" key={k}>
                    <span>{meta?.label || k} {meta?.optional ? '(optional)' : '*'}</span>
                    <input
                      type={meta?.kind === 'password' ? 'password' : 'text'}
                      className="input mono"
                      value={v}
                      onChange={(e) => setPresetEnv((p) => ({ ...p, [k]: e.target.value }))}
                      placeholder={k}
                      autoComplete="off"
                    />
                  </label>
                );
              })}
            </div>
          )}

          <div className="row">
            <Field label="Name *">
              <input className="input" value={newMcp.name} onChange={(e) => setNewMcp((n) => ({ ...n, name: e.target.value }))} placeholder="e.g. jira / slack / git" />
            </Field>
            <Field label="Transport">
              <select className="input" value={newMcp.transport} onChange={(e) => setNewMcp((n) => ({ ...n, transport: e.target.value }))}>
                <option value="stdio">stdio (local command)</option>
                <option value="sse">remote (SSE / HTTP)</option>
              </select>
            </Field>
          </div>
          {newMcp.transport === 'stdio' ? (
            <div className="row">
              <Field label="Command *" hint="e.g. npx -y @modelcontextprotocol/server-filesystem /path">
                <input className="input mono" value={newMcp.command} onChange={(e) => setNewMcp((n) => ({ ...n, command: e.target.value }))} placeholder="npx -y mcp-server …" />
              </Field>
              <Field label="Args (space/comma separated)">
                <input className="input mono" value={newMcp.args} onChange={(e) => setNewMcp((n) => ({ ...n, args: e.target.value }))} placeholder="/path /another" />
              </Field>
            </div>
          ) : (
            <Field label="URL *" hint="streamable HTTP / SSE endpoint">
              <input className="input mono" value={newMcp.url} onChange={(e) => setNewMcp((n) => ({ ...n, url: e.target.value }))} placeholder="https://mcp.example.com/sse" />
            </Field>
          )}
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={() => { setMcpFormOpen(false); clearPreset(); }}>Cancel</button>
            <button type="submit" className="btn primary" disabled={addingMcp}>{addingMcp ? 'Adding…' : 'Add MCP'}</button>
          </div>
        </form>
      )}

      <div className="card config-card conns-card">
        {mcpLoading && !mcps.length ? (
          <p className="muted">Loading MCP connections…</p>
        ) : mcps.length === 0 ? (
          <p className="muted">No MCP connections yet. Add a server (git, Jira, Slack, filesystem…) to expose its tools to every pipeline node.</p>
        ) : (
          <div className="conns-list">
            {mcps.map((c) => {
              const st = testingMcp[c.id];
              const tr = mcpTestResult[c.id];
              return (
                <div key={c.id} className="conn-row">
                  <div className="conn-main">
                    <span className="config-name">{c.name}</span>
                    <span className="mono small muted conn-url">
                      {c.transport === 'stdio' ? c.command : c.url}
                    </span>
                    <span className="chip small">{c.transport}</span>
                    {c.enabled === 0 && <span className="badge">disabled</span>}
                    {st === 'ok' && <span className="badge status-success">✓ {tr?.tools?.length ?? 0} tools</span>}
                    {st === 'error' && <span className="badge status-failed">✕ {tr?.error || 'failed'}</span>}
                    {st === 'ok' && tr?.tools?.length > 0 && (
                      <div className="conn-tools">
                        {tr.tools.slice(0, 8).map((t) => <span key={t.name} className="chip small mono">{t.name}</span>)}
                        {tr.tools.length > 8 && <span className="muted small">+{tr.tools.length - 8} more</span>}
                      </div>
                    )}
                  </div>
                  <div className="conn-actions">
                    <button className="btn small ghost" disabled={st === 'busy'} onClick={() => testMcp(c)}>
                      {st === 'busy' ? '…' : 'Test'}
                    </button>
                    <button className="btn small danger" onClick={() => deleteMcp(c)}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---------- Secrets vault ---------- */}
      <div className="view-head section-head-inline">
        <h3 className="section-title-standalone">Secrets <span className="muted small">(encrypted)</span></h3>
        <button className="btn small ghost" onClick={() => setSecFormOpen((o) => !o)}>
          {secFormOpen ? 'Cancel' : '+ Add secret'}
        </button>
      </div>

      {secFormOpen && (
        <form className="card form conn-form" onSubmit={addSecret}>
          <div className="row">
            <Field label="Key *" hint="e.g. github_pat, SLACK_BOT_TOKEN">
              <input className="input mono" value={newSecret.key} onChange={(e) => setNewSecret((s) => ({ ...s, key: e.target.value }))} placeholder="my_api_key" />
            </Field>
            <Field label="Value *" hint="stored encrypted (AES-256-GCM)">
              <input type="password" className="input mono" value={newSecret.value} onChange={(e) => setNewSecret((s) => ({ ...s, value: e.target.value }))} placeholder="••••••••" autoComplete="off" />
            </Field>
          </div>
          <Field label="Note (optional)">
            <input className="input" value={newSecret.note} onChange={(e) => setNewSecret((s) => ({ ...s, note: e.target.value }))} placeholder="what is this for?" />
          </Field>
          <p className="muted small">
            Reference from MCP preset env as <code>{'${secret:KEY}'}</code>, e.g. <code>${'{'}secret:github_pat{'}'}</code>.
          </p>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={() => setSecFormOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={addingSecret}>{addingSecret ? 'Storing…' : 'Store secret'}</button>
          </div>
        </form>
      )}

      <div className="card config-card conns-card">
        {secretsLoading && !secrets.length ? (
          <p className="muted">Loading secrets…</p>
        ) : secrets.length === 0 ? (
          <p className="muted">No secrets stored. Add one (e.g. a GitHub PAT or Slack token) to use in MCP connections or agents.</p>
        ) : (
          <div className="conns-list">
            {secrets.map((s) => (
              <div key={s.key} className="conn-row">
                <div className="conn-main">
                  <span className="config-name mono">{s.key}</span>
                  <span className="muted small">•••••••• (encrypted)</span>
                  {s.note && <span className="chip small">{s.note}</span>}
                </div>
                <div className="conn-actions">
                  <span className="muted small">updated {s.updated_at ? s.updated_at.slice(0, 16) : ''}</span>
                  <button className="btn small danger" onClick={() => deleteSecret(s)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- Channel toggles (unchanged) ---------- */}
      <h3 className="section-title">Channels</h3>
      <div className="card config-card">
        <div className="config-row">
          <span className="muted small">Primary Channel</span>
          <span className="mono primary-chip">{primary || '— none —'}</span>
        </div>
        {channels.length === 0 ? (
          <p className="muted">No channels registered.</p>
        ) : (
          <div>
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
          </div>
        )}
      </div>

      {/* ---------- Model Catalog (unchanged) ---------- */}
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