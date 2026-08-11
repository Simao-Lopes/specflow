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
    const rows = getDb().prepare('SELECT role, content FROM messages WHERE spec_id=? AND content IS NOT NULL AND length(content)>0 ORDER BY id DESC LIMIT 6').all(specId);
    if (!rows.length) return null;
    return rows.reverse().map(r => `- [${r.role}] ${r.content.slice(0, 500)}`).join('\n');
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
    bin: () => process.env.HERMES_BIN || 'hermes',
    craft(prompt, job) {
      const args = ['chat', '-q', prompt];
      if (job.model) args.push('-m', job.model);
      return args;
    },
  },

  opencode: {
    label: 'OpenCode',
    description: 'OpenCode CLI, open-source coding agent.',
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
    bin: () => process.env.COPILOT_BIN || 'copilot',
    craft(prompt) {
      return ['-p', prompt];
    },
  },

  // Custom: job.step.command (or config.custom_command) templated with placeholders.
  custom: {
    label: 'Custom',
    description: 'Arbitrary shell command / script.',
    async run(job, context) {
      const cmd = job.step?.command || job.harness_config?.command || context.config?.custom_command;
      if (!cmd) throw new Error('Custom harness requires a `command` on the step (or custom_command in config)');
      const fs = await import('node:fs');
      const promptPath = `${context.checkout}/.specflow_prompt.md`;
      fs.writeFileSync(promptPath, await buildPrompt(context, job));
      const rendered = cmd
        .replaceAll('{checkout}', context.checkout)
        .replaceAll('{prompt_file}', promptPath)
        .replaceAll('{branch}', job.branch || '')
        .replaceAll('{job_id}', job.id);
      return runProc('/bin/bash', ['-c', rendered], { cwd: context.checkout, jobId: job.id });
    },
  },

  // Direct LLM call — useful for planning, review, and lightweight verify steps.
  llm: {
    label: 'Direct LLM',
    description: 'Direct completion (no code agent) — good for plan/review.',
    async run(job, context) {
      const { chatComplete } = await import('../llm/providers.js');
      const prompt = await buildPrompt(context, job);
      const provider = job.provider || context.config?.provider || 'openrouter';
      const out = await chatComplete({
        provider, model: job.model || context.config?.model,
        messages: [{ role: 'system', content: 'You are an autonomous engineering assistant.' }, { role: 'user', content: prompt }],
        config: context.config,
      });
      emit(EVT.JOB_LOG, { jobId: job.id, level: 'info', message: out.slice(0, 1200) });
      if (job.lifecycle === 'verify') {
        const fail = /FAIL(?:\s|:|\()/i.test(out) && !/PASS/i.test(out);
        if (fail) throw new Error('Verification failed (LLM reported failure): ' + out.slice(0, 300));
      }
      return { code: 0, output: out, messages: out.trim() };
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
  const harnessId = (job.harness || 'custom').toLowerCase();
  const impl = HARNESSES[harnessId] || HARNESSES.custom;
  return impl.run(job, context);
}

export const HARNESS_LIST = Object.keys(HARNESSES);
export const HARNESS_META = Object.fromEntries(
  Object.entries(HARNESSES).map(([id, d]) => [id, { label: d.label, description: d.description }])
);