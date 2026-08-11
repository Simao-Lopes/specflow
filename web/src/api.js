// Thin fetch helper for the SpecFlow backend.
// All paths are RELATIVE (/api/...) so they work through the Vite dev proxy
// and when the built UI is served by the backend itself at /ui/.

async function request(path, options = {}) {
  const opts = {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  };
  if (options.body !== undefined && typeof options.body !== 'string') {
    opts.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      detail = JSON.parse(text).error || text;
    } catch { /* keep raw text */ }
    throw new Error(detail || `Request failed: ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

export const api = {
  listSpecs: () => request('/api/specs'),
  getSpec: (id) => request(`/api/specs/${id}`),
  createSpec: (body) => request('/api/specs', { method: 'POST', body }),
  updateSpec: (id, body) => request(`/api/specs/${id}`, { method: 'PATCH', body }),
  deleteSpec: (id) => request(`/api/specs/${id}`, { method: 'DELETE' }),
  runSpec: (id, body) => request(`/api/specs/${id}/run`, { method: 'POST', body }),

  listAgents: () => request('/api/agents'),
  upsertAgent: (body) => request('/api/agents', { method: 'PUT', body }),
  deleteAgent: (id) => request(`/api/agents/${id}`, { method: 'DELETE' }),

  listJobs: (specId) => request(`/api/jobs?specId=${encodeURIComponent(specId || '')}`),
  jobLogs: (jobId, limit = 500) => request(`/api/jobs/${jobId}/logs?limit=${limit}`),

  // Human gate: advance a paused job (action: approve | reject | retry).
  gateJob: (jobId, action, note) => request(`/api/jobs/${jobId}/gate`, { method: 'POST', body: { action, ...(note ? { note } : {}) } }),

  // Pipelines (first-class, reusable entities).
  listPipelines: () => request('/api/pipelines'),
  getPipeline: (id) => request(`/api/pipelines/${id}`),
  createPipeline: (body) => request('/api/pipelines', { method: 'POST', body }),
  updatePipeline: (id, body) => request(`/api/pipelines/${id}`, { method: 'PATCH', body }),
  deletePipeline: (id) => request(`/api/pipelines/${id}`, { method: 'DELETE' }),

  // Spec pipeline steps: resolves the spec's pipeline into a read-only steps array.
  getSpecSteps: (id) => request(`/api/specs/${id}/steps`),
  // Backward-compatible alias for the same endpoint.
  getSteps: (id) => request(`/api/specs/${id}/steps`),

  // Per-spec agent-session messages
  listMessages: (id) => request(`/api/specs/${id}/messages`),
  sendMessage: (id, content, role = 'user') => request(`/api/specs/${id}/messages`, { method: 'POST', body: { content, role } }),

  getConfig: () => request('/api/config'),
  setChannel: (name, enabled) => request(`/api/channels/${encodeURIComponent(name)}`, { method: 'POST', body: { enabled } }),

  // Editable preferences.
  getSettings: () => request('/api/settings'),
  updateSettings: (body) => request('/api/settings', { method: 'PUT', body }),

  // Git connections (named repos).
  listConnections: () => request('/api/connections'),
  addConnection: (body) => request('/api/connections', { method: 'POST', body }),
  deleteConnection: (id) => request(`/api/connections/${id}`, { method: 'DELETE' }),
  testConnection: (id) => request(`/api/connections/${id}/test`, { method: 'POST' }),

  // Pipeline step prompt versioning.
  promptVersions: (pid, sid) => request(`/api/pipelines/${pid}/steps/${sid}/prompt-versions`),
  savePromptVersion: (pid, sid, body) => request(`/api/pipelines/${pid}/steps/${sid}/prompt-versions`, { method: 'POST', body }),
  restorePromptVersion: (pid, sid, version) => request(`/api/pipelines/${pid}/steps/${sid}/prompt-versions/restore/${encodeURIComponent(version)}`, { method: 'POST' }),

  // Method library: industry templates + custom actions for pipeline steps.
  getMethods: () => request('/api/methods'),
};

export default api;