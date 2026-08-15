// Agent harness abstraction.
//
// Each harness knows how to take a task (a job step) and execute it against a
// checkout using a CLI coding agent. Harnesses are table-driven: a declarative
// registry of the common coding-agent CLIs. Each entry gives the binary, how to
// build its argv, and a human description (used by the UI dropdown).
//
//   claude    : Claude Code CLI
//   hermes    : Hermes Agent headless
//   opencode  : OpenCode CLI
//   codex     : OpenAI Codex CLI
//   gemini    : Google Gemini CLI
//   aider     : Aider (pair-programming CLI)
//   qwen-code : Qwen Code CLI
//   github-copilot : GitHub Copilot CLI
//   custom    : arbitrary shell command / script
//   llm       : direct completion (no code agent)

import { spawn } from 'node:child_process';
import { emit, EVT } from '../core/events.js';

// --- shared prompt builder (same across all CLI harnesses) ---
async function buildPrompt(context, job) {
  const spec = context.spec;
  const step = job.step || {};
  const isVerify = job.lifecycle === 'verify';

  const parts = [];
  parts.push(isVerify
    ? 'You are a verification agent in a SpecFlow pipeline. Execute the verification described below against the repository and report clearly whether it passes.'
    : 'You are an autonomous agent implementing part of a software project (SpecFlow pipeline).');
  parts.push('');
  parts.push(`FEATURE: ${spec.title}`);
  parts.push(`DESCRIPTION:\n${spec.description || '(none)'}`);
  parts.push(`ACCEPTANCE CRITERIA:\n${spec.acceptance_criteria || '(none)'}`);
  parts.push(`CURRENT STEP: ${step.name || '?'}${isVerify ? ' (verification)' : ''}`);
  if (step.prompt) parts.push(`\nSTEP INSTRUCTIONS:\n${step.prompt}`);
  if (!isVerify) {
    parts.push(`\nWorking repository: ${job.repo || context.repo || '(scratch, no git)'}`);
    parts.push(`Branch: ${job.branch}`);
    parts.push('Please complete this step, keep changes minimal and conventional, and report what you did.');
  }
  if (job.feedback) parts.push(`\nFEEDBACK FROM PREVIOUS ATTEMPT:\n${job.feedback}`);
  const guidance = await recentGuidance(context, spec.id);
  if (guidance) parts.push(`\nHUMAN GUIDANCE FROM THE SPEC THREAD:\n${guidance}`);
  return parts.join('\n');
}

async function recentGuidance(context, specId) {
  try {
    const { getDb } = await import('../core/store.js');
    // Pull recent HUMAN + system feedback so the agent actually adapts to what
    // the user said (not just the last few messages, and not tool/system noise).
    const rows = getDb().prepare(
      "SELECT role, content FROM messages WHERE spec_id=? AND content IS NOT NULL AND length(content)>0 AND role IN ('user','system') ORDER BY id DESC LIMIT 20"
    ).all(specId);
    if (!rows.length) return null;
    return rows.reverse().map(r => `- [${r.role}] ${r.content.slice(0, 1200)}`).join('\n');
  } catch { return null; }
}

async function runProc(cmd, args, { cwd, jobId, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: false });
    let out = '';
    child.stdout.on('data', d => { const line = d.toString(); out += line; emit(EVT.JOB_LOG, { jobId, level: 'info', message: line.trim() }); });
    child.stderr.on('data', d => { const line = d.toString(); emit(EVT.JOB_LOG, { jobId, level: 'warn', message: line.trim() }); });
    child.on('error', reject);
    child.on('close', code => { if (code === 0) resolve({ code, output: out, messages: out.trim() }); else reject(new Error(`Harness exited with code ${code}\n${out}`)); });
  });
}

// -----------------------------------------------------------------------------
// Declarative harness definitions.
// Each craft(argv, job) returns the argv array to run the CLI with the prompt.
// `bin` may be overridden per-env (e.g. OPENCODE_BIN).
// -----------------------------------------------------------------------------
export const HARNESSES = {
  claude: {
    label: 'Claude Code',
    description: 'Claude Code CLI — brings its own auth, zero setup.',
    install: 'npm install -g @anthropic-ai/claude-code',
    bin: () => process.env.CLAUDE_BIN || 'claude',
    craft(prompt, job) {
      const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'];
      if (job.model) args.push('--model', job.model);
      return args;
    },
  },

  hermes: {
    label: 'Hermes Agent',
    description: 'Hermes Agent headless (hermes chat -q).',
    install: 'curl -LsSf https://hermes-agent.nousresearch.com/install.sh | sh || pipx install hermes-agent',
    bin: () => process.env.HERMES_BIN || 'hermes',
    craft(prompt, job) {
      const args = ['chat', '-q', prompt];
      if (job.model) args.push('-m', job.model);
      if (job.provider) args.push('--provider', job.provider);
      return args;
    },
  },

  opencode: {
    label: 'OpenCode',
    description: 'OpenCode CLI, open-source coding agent.',
    install: 'npm install -g opencode-ai',
    bin: () => process.env.OPENCODE_BIN || 'opencode',
    craft(prompt, job) {
      const args = ['run', prompt, '--yes', '--no-notifications'];
      if (job.model) args.push('--model', job.model);
      return args;
    },
  },

  codex: {
    label: 'OpenAI Codex',
    description: 'OpenAI Codex CLI (codex).',
    install: 'npm install -g @openai/codex',
    bin: () => process.env.CODEX_BIN || 'codex',
    craft(prompt, job) {
      const args = ['exec', '--skip-git-repo-check', '--yes', '--json', prompt];
      if (job.model) args.push('--model', job.model);
      return args;
    },
  },

  gemini: {
    label: 'Gemini CLI',
    description: 'Google Gemini CLI (gemini).',
    install: 'npm install -g @google/gemini-cli',
    bin: () => process.env.GEMINI_BIN || 'gemini',
    craft(prompt, job) {
      const args = ['-p', prompt];
      if (job.model) args.push('--model', job.model);
      return args;
    },
  },

  aider: {
    label: 'Aider',
    description: 'Aider — AI pair programming CLI.',
    install: 'python -m pip install -U aider-chat',
    bin: () => process.env.AIDER_BIN || 'aider',
    craft(prompt, job) {
      const args = ['--message', prompt, '--yes-always', '--no-check-update', '--no-git', '--no-auto-commits'];
      if (job.model) args.push('--model', job.model);
      return args;
    },
  },

  'qwen-code': {
    label: 'Qwen Code',
    description: 'Qwen Code CLI (qwen-code).',
    install: 'npm install -g @qwen-code/qwen-code',
    bin: () => process.env.QWEN_CODE_BIN || 'qwen-code',
    craft(prompt, job) {
      const args = ['--headless', prompt, '--yes'];
      if (job.model) args.push('--model', job.model);
      return args;
    },
  },

  // GitHub Copilot CLI. Interactive by nature; run in print mode ('copilot -p').
  'github-copilot': {
    label: 'GitHub Copilot CLI',
    description: 'GitHub Copilot CLI (copilot -p "…").',
    install: 'npm install -g @github/copilot',
    bin: () => process.env.COPILOT_BIN || 'copilot',
    craft(prompt) {
      return ['-p', prompt];
    },
  },
};

// Build the generic CLI runner for coprocessor harnesses (claude, codex, …).
for (const [id, def] of Object.entries(HARNESSES)) {
  if (def.craft && !def.run) {
    def.run = async function run(job, context) {
      const prompt = await buildPrompt(context, job);
      const argv = def.craft(prompt, job);
      const bin = def.bin();
      // The model may be the first-arg style (e.g. codex passes --model) — handled in craft.
      return runProc(bin, argv, { cwd: context.checkout, jobId: job.id });
    };
  }
}

export async function runHarness(job, context) {
  const harnessId = (job.harness || '').toLowerCase();
  const impl = HARNESSES[harnessId];
  if (!impl) {
    // Hard gate: SpecFlow dispatches ONLY to coding-agent CLI harnesses
    // (claude, hermes, codex, …). Text-only `llm` and bare shell `custom`
    // are intentionally not available.
    throw new Error(
      `Harness "${job.harness || '(none)'}" is not a supported CLI agent. ` +
      `SpecFlow only runs coding-agent harnesses: ${Object.keys(HARNESSES).join(', ')}.`
    );
  }
  return impl.run(job, context);
}

export const HARNESS_LIST = Object.keys(HARNESSES);
export const HARNESS_META = Object.fromEntries(
  Object.entries(HARNESSES).map(([id, d]) => [id, { label: d.label, description: d.description }])
);

// ---- Availability probe ----
// For each CLI harness, determine whether the binary resolves on the server
// (either via its <NAME>_BIN env override or on PATH). Uses `which` for PATH
// resolution. Returns { id, label, binary, available, version? }.
export async function checkAvailability() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runs = promisify(execFile);
  const which = async (bin) => {
    try { await runs('which', [bin], { env: process.env }); return true; } catch { return false; }
  };
  const version = async (bin) => {
    try {
      const { stdout } = await runs(bin, ['--version'], { timeout: 6000, env: process.env });
      return String(stdout || '').trim().slice(0, 40);
    } catch { return ''; }
  };

  const out = [];
  for (const [id, def] of Object.entries(HARNESSES)) {
    if (!def.bin) { out.push({ id, label: def.label, binary: '—', available: true, note: 'built-in', install: '' }); continue; }
    const bin = def.bin();
    const available = await which(bin.split(/\s+/)[0]);
    out.push({
      id, label: def.label, binary: bin, available,
      install: def.install || '',
      overridden: !!binEnvVar(id),
      version: available ? await version(bin.split(/\s+/)[0]) : '',
    });
  }
  return out;
}

function binEnvVar(id) {
  const map = { claude: 'CLAUDE_BIN', hermes: 'HERMES_BIN', opencode: 'OPENCODE_BIN', codex: 'CODEX_BIN', gemini: 'GEMINI_BIN', aider: 'AIDER_BIN', 'qwen-code': 'QWEN_CODE_BIN', 'github-copilot': 'COPILOT_BIN' };
  const varName = map[id];
  return varName ? !!process.env[varName] : false;
}