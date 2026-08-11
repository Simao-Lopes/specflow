// MCP (Model Context Protocol) tool connections.
//
// Lets SpecFlow connect to MCP servers (git, Jira, Slack, filesystem, …) so any
// pipeline node can call their tools. Each connection is a named server with a
// transport:
//   stdio   -> a local command (spawn)
//   sse     -> a remote URL (Streamable HTTP / SSE)
//
// Enabled connections are introspected (handshake + tools/list) and their tools
// injected into step prompts as "available MCP tools", so every pipeline can use
// every configured MCP.

import { getDb } from './store.js';
import { emit, EVT } from './events.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_PRESETS } from './mcpPresets.js';

export function listMcpPresets() {
  return MCP_PRESETS;
}

// ---- DB helpers ----

export function listMcpConnections() {
  return getDb().prepare('SELECT id,name,transport,command,url,args,env,enabled,created_at FROM mcp_connections ORDER BY name COLLATE NOCASE').all().map((r) => ({ ...r, args: safeParse(r.args), env: safeParseObj(r.env) }));
}

export function getMcpConnection(id) {
  const r = getDb().prepare('SELECT * FROM mcp_connections WHERE id=?').get(id);
  return r ? { ...r, args: safeParse(r.args), env: safeParseObj(r.env) } : null;
}

export function addMcpConnection(input) {
  const id = input.id || randomUUID().slice(0, 8);
  if (!input.name) throw new Error('name is required');
  const transport = input.transport || (input.url ? 'sse' : 'stdio');
  if (transport === 'stdio' && !input.command) throw new Error('command is required for stdio transport');
  if (transport !== 'stdio' && !input.url) throw new Error('url is required for remote transport');
  getDb().prepare('INSERT INTO mcp_connections (id,name,transport,command,url,args,env,enabled) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, input.name, transport, input.command || '', input.url || '', JSON.stringify(Array.isArray(input.args) ? input.args : []), JSON.stringify(input.env || {}), input.enabled !== false ? 1 : 0);
  const row = getMcpConnection(id);
  emit(EVT.CONFIG_UPDATED, { mcp: row });
  return row;
}

export function updateMcpConnection(id, patch) {
  if (!getMcpConnection(id)) throw new Error('Connection not found');
  const fields = ['name', 'transport', 'command', 'url', 'enabled'];
  const sets = [], vals = {};
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f}=@${f}`); vals[f] = patch[f]; }
  }
  if (patch.args !== undefined) { sets.push('args=@args'); vals.args = JSON.stringify(Array.isArray(patch.args) ? patch.args : []); }
  if (patch.env !== undefined) { sets.push('env=@env'); vals.env = JSON.stringify(patch.env || {}); }
  if (sets.length) { vals.id = id; getDb().prepare(`UPDATE mcp_connections SET ${sets.join(',')} WHERE id=@id`).run(vals); }
  const row = getMcpConnection(id);
  emit(EVT.CONFIG_UPDATED, { mcp: row });
  return row;
}

export function deleteMcpConnection(id) {
  getDb().prepare('DELETE FROM mcp_connections WHERE id=?').run(id);
  emit(EVT.CONFIG_UPDATED, { mcpDeleted: id });
}

// ---- MCP client ----

function makeTransport(c) {
  if (c.transport === 'stdio') {
    return new StdioClientTransport({ command: c.command, args: c.args || [], env: { ...process.env, ...(c.env || {}) }, stderr: 'pipe' });
  }
  const url = new URL(c.url);
  return new StreamableHTTPClientTransport(url);
}

// Connect, run tools/list, disconnect. Returns { ok, name, tools: [{name,description}] }
export async function testMcpConnection(id, { timeoutMs = 12000 } = {}) {
  const c = getMcpConnection(id);
  if (!c) throw new Error('Connection not found');
  const client = new Client({ name: 'specflow', version: '0.1.0' });
  let transport;
  try {
    transport = makeTransport(c);
    const timer = setTimeout(() => { try { transport?.close?.(); client?.close?.(); } catch {} }, timeoutMs);
    await client.connect(transport);
    const result = await client.listTools();
    clearTimeout(timer);
    const tools = (result && result.tools || []).map((t) => ({ name: t.name, description: t.description || '' }));
    await client.close().catch(() => {});
    return { ok: true, id: c.id, name: c.name, tools };
  } catch (e) {
    try { await client.close().catch(() => {}); } catch {}
    return { ok: false, id: c.id, name: c.name, error: e?.message || String(e) };
  }
}

// Introspect to cache tools per enabled connection (best-effort, cached).
const _toolsCache = new Map(); // id -> { ts, tools }
export async function refreshMcpTools({ force = false } = {}) {
  const out = [];
  for (const c of listMcpConnections()) {
    if (!c.enabled) continue;
    const cached = _toolsCache.get(c.id);
    if (!force && cached && Date.now() - cached.ts < 60000) { out.push({ id: c.id, name: c.name, tools: cached.tools, ok: true }); continue; }
    const r = await testMcpConnection(c.id);
    if (r.ok) _toolsCache.set(c.id, { ts: Date.now(), tools: r.tools });
    out.push(r);
  }
  return out;
}

// Build a markdown block listing enabled MCP servers + their tools for injection
// into step prompts.
export async function mcpToolsContext() {
  const servers = await refreshMcpTools();
  const enabled = servers.filter((s) => s.ok);
  if (!enabled.length) return '';
  const lines = ['## Available MCP tools (callable via your tool harness)', ''];
  for (const s of enabled) {
    lines.push(`### MCP server: ${s.name}`);
    if (!s.tools || !s.tools.length) { lines.push('  (connects, no tools advertised)'); continue; }
    for (const t of s.tools) {
      const desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      lines.push(`- \`${s.name}.${t.name}\`: ${desc || 'no description'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return []; }
}
function safeParseObj(s) {
  try { const v = JSON.parse(s); return (v && typeof v === 'object') ? v : {}; } catch { return {}; }
}