// LLM provider registry — pluggable, data-driven. Mirror of Simão's Hermes
// provider inventory (see ~/.hermes/config.yaml). Any provider exposing an
// OpenAI-compatible /chat/completions endpoint can be added here.

const PROVIDER_ORDER = ['gemini', 'openrouter', 'nvidia', 'ollama', 'litellm'];

const PROVIDERS = {
  gemini: {
    name      : 'Google Gemini',
    baseUrl   : 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv : 'GOOGLE_API_KEY',
    kind      : 'gemini',
    models    : [
      'gemini-3.6-flash',        // Mirrors Hermes default
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
    ],
  },

  openrouter: {
    name      : 'OpenRouter',
    baseUrl   : 'https://openrouter.ai/api/v1',
    apiKeyEnv : 'OPENROUTER_API_KEY',
    models    : [
      'deepseek/deepseek-v4-flash-0731',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ],
  },

  nvidia: {
    name      : 'NVIDIA NIM',
    baseUrl   : 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv : 'NVIDIA_API_KEY',
    models    : [
      'z-ai/glm-5.2',
    ],
  },

  ollama: {
    name      : 'Ollama (local)',
    baseUrl   : 'http://localhost:11434/v1',
    apiKeyEnv : null,
    models    : [
      'qwen3:30b-a3b',
    ],
  },

  litellm: {
    name      : 'LiteLLM (local)',
    baseUrl   : 'http://localhost:4000/v1',
    apiKeyEnv : null,
    models    : [
      'primary',
      'deepseek',
      'nemotron',
      'gemini',
      'openrouter-free',
    ],
  },
};

function getProvider(id) {
  return PROVIDERS[id] || { name: id || 'openrouter', baseUrl: process.env.LLM_CUSTOM_BASE_URL, apiKeyEnv: 'LLM_API_KEY', models: [] };
}

export async function chatComplete({ provider = 'openrouter', model, messages, config = {} }) {
  const p = getProvider(provider);
  if (p.kind === 'gemini') return chatGemini({ model: model || p.models[0], messages, config, p });

  const base = config.baseUrl || p.baseUrl;
  const apiKey = config.apiKey || keyFor(p);
  if (!base) throw new Error(`No base URL for provider "${provider}"`);
  if (p.apiKeyEnv && !apiKey) throw new Error(`No API key configured for provider "${provider}" (set ${p.apiKeyEnv})`);

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://space.tail1697a1.ts.net'; headers['X-Title'] = 'SpecFlow'; }

  const resp = await fetch(`${base}/chat/completions`, {
    method : 'POST',
    headers,
    body   : JSON.stringify({ model, messages, temperature: 0.3, ...(config.extraBody || {}) }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LLM ${provider} error ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Gemini (native API) uses a different shape.
async function chatGemini({ model, messages, config, p }) {
  const apiKey = config.apiKey || keyFor(p);
  if (!apiKey) throw new Error('No GOOGLE_API_KEY configured for Gemini');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role  : m.role === 'assistant' ? 'model' : 'user',
    parts : [{ text: m.content }],
  }));

  const resp = await fetch(url, {
    method  : 'POST',
    headers : { 'Content-Type': 'application/json' },
    body    : JSON.stringify({ systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LLM gemini error ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
}

function keyFor(p) {
  if (!p.apiKeyEnv) return null;
  const names = p.apiKeyEnv.includes(',')
    ? p.apiKeyEnv.split(',')
    : [p.apiKeyEnv];
  for (const n of names) {
    if (process.env[n]) return process.env[n];
    for (const [k, v] of Object.entries(process.env)) {
      if (k.toLowerCase() === n.toLowerCase() && v) return v;
    }
  }
  return null;
}

// Catalog consumed by /api/config + UI (per-provider, in stable order).
export const MODEL_CATALOG = Object.fromEntries(
  PROVIDER_ORDER.map(id => [id, PROVIDERS[id].models])
);

export const PROVIDER_LIST = PROVIDER_ORDER.map(id => ({ id, ...PROVIDERS[id] }));