// LLM provider abstraction. Any provider exposing an OpenAI-compatible
// /chat/completions endpoint can plug in via the LLM_PROVIDERS config.

const API_BASES = {
  openrouter : 'https://openrouter.ai/api/v1',
  nvidia     : 'https://integrate.api.nvidia.com/v1',
  gemini     : 'https://generativelanguage.googleapis.com/v1beta',
  custom     : process.env.LLM_CUSTOM_BASE_URL || '',
};

export async function chatComplete({ provider = 'openrouter', model, messages, config = {} }) {
  if (provider === 'gemini') return chatGemini({ model: model || 'gemini-2.0-flash', messages, config });

  const base = config.baseUrl || API_BASES[provider] || API_BASES.openrouter;
  const apiKey = config.apiKey || getKeyFor(provider);
  if (!apiKey) throw new Error(`No API key configured for provider "${provider}"`);

  const resp = await fetch(`${base}/chat/completions`, {
    method  : 'POST',
    headers : {
      'Content-Type'  : 'application/json',
      'Authorization' : `Bearer ${apiKey}`,
      ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://space.tail1697a1.ts.net', 'X-Title': 'SpecFlow' } : {}),
    },
    body : JSON.stringify({
      model,
      messages,
      temperature : 0.3,
      ...(config.extraBody || {}),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LLM ${provider} error ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Gemini uses a different endpoint shape.
async function chatGemini({ model, messages, config }) {
  const apiKey = config.apiKey || getKeyFor('gemini');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  // Convert OpenAI-style messages (strip system -> systemInstruction)
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role    : m.role === 'assistant' ? 'model' : 'user',
    parts   : [{ text: m.content }],
  }));

  const resp = await fetch(url, {
    method  : 'POST',
    headers : { 'Content-Type': 'application/json' },
    body    : JSON.stringify({
      systemInstruction : system ? { parts: [{ text: system }] } : undefined,
      contents,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LLM gemini error ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
}

function getKeyFor(provider) {
  switch (provider) {
    case 'openrouter': return process.env.OPENROUTER_API_KEY;
    case 'nvidia'    : return process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;
    case 'gemini'    : return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    case 'fireworks' : return process.env.FIREWORKS_API_KEY;
    default          : return process.env.LLM_API_KEY;
  }
}

// Standard catalog of known-good model ids per provider (team can override in UI).
export const MODEL_CATALOG = {
  openrouter : [
    'deepseek/deepseek-chat-v3-0324',
    'google/gemini-2.0-flash',
    'anthropic/claude-3.5-sonnet',
  ],
  nvidia : [
    'nvidia/llama-3.1-nemotron-70b-instruct',
  ],
  gemini : [
    'gemini-2.0-flash',
    'gemini-1.5-pro',
  ],
};