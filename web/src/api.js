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

  getConfig: () => request('/api/config'),
  setChannel: (name, enabled) => request(`/api/channels/${encodeURIComponent(name)}`, { method: 'POST', body: { enabled } }),
};

export default api;