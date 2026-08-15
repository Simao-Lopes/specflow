#!/usr/bin/env node
// SpecFlow CLI — drive the flow from the terminal.
// Usage:
//   specflow spec list|create|show|run <id>|status
//   specflow agent list|create
//   specflow job logs <id>
//   specflow config show|channel
import 'dotenv/config';

async function main() {
  const baseUrl = process.env.SPECFLOW_API || 'http://localhost:9120';
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const api = (path) => `${baseUrl}${path}`;

  const help = () => console.log(`
SpecFlow CLI
  specflow spec list
  specflow spec create --title "..." [--desc ...] [--type feature]
  specflow spec show <id>
  specflow spec run <id> [--harness custom|hermes|claude|llm]
  specflow agent list
  specflow agent create --name X --harness custom --repo git@...:o/r.git
  specflow job logs <jobId>
  specflow channels
`);

  try {
    switch (cmd) {
      case 'spec': return await specCmd(sub, rest, api);
      case 'job': return await jobCmd(sub, rest, api);
      case 'channels': {
        const r = await fetch(api('/api/channels')); console.log(JSON.stringify(await r.json(), null, 2)); return;
      }
      default: return help();
    }
  } catch (e) {
    console.error('Error:', e?.message || e);
    process.exit(1);
  }
}

async function specCmd(sub, rest, api) {
  if (sub === 'list') {
    const r = await fetch(api('/api/specs'));
    const specs = await r.json();
    console.table(specs.map(s => ({ id: s.id, title: s.title, type: s.type, status: s.status, repo: s.repo })));
    return;
  }
  if (sub === 'create') {
    const p = parseArgs(rest);
    const body = { title: p.title, description: p.desc || p.description, type: p.type || 'feature', repo: p.repo || null, acceptance_criteria: p.criteria || '' };
    if (!body.title) throw new Error('--title is required');
    const r = await fetch(api('/api/specs'), { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    console.log('Created spec:', JSON.stringify(await r.json(), null, 2));
    return;
  }
  if (sub === 'show') {
    const r = await fetch(api(`/api/specs/${rest[0]}`));
    if (r.status === 404) return console.log('Spec not found');
    console.log(JSON.stringify(await r.json(), null, 2));
    return;
  }
  if (sub === 'run') {
    const id = rest[0];
    const p = parseArgs(rest.slice(1));
    const r = await fetch(api(`/api/specs/${id}/run`), { method: 'POST', headers: hdr(), body: JSON.stringify({ harness: p.harness, model: p.model, provider: p.provider }) });
    console.log('Job started:', JSON.stringify(await r.json()));
    return;
  }
  if (sub === 'status') { await specCmd('list', rest, api); return; }
  throw new Error('Unknown spec subcommand');
}

async function jobCmd(sub, rest, api) {
  if (sub === 'logs') {
    const r = await fetch(api(`/api/jobs/${rest[0]}/logs?limit=500`));
    const logs = await r.json();
    for (const l of logs) console.log(`[${l.level}] ${l.message}`);
    return;
  }
  throw new Error('Unknown job subcommand');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}
function hdr() { return { 'Content-Type': 'application/json' }; }

main();