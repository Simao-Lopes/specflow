// Agent harness abstraction. Each harness knows how to take a task (a job step)
// and execute it against a checkout. Implementations are pluggable:
//   - 'hermes'  : drives a Hermes Agent headless (hermes chat -q)
//   - 'claude'  : Claude Code CLI
//   - 'custom'  : arbitrary shell command / script
//   - 'llm'     : direct completion (no code agent)
// A job carries `step` (its own name/prompt), `feedback` (prior verify results),
// and `lifecycle` (work | verify) so harnesses build a step-aware prompt.

import { spawn } from 'node:child_process';
import { emit, EVT } from '../core/events.js';

export async function runHarness(job, context) {
  const harnessId = (job.harness || 'custom').toLowerCase();
  const impl = HARNESSES[harnessId] || HARNESSES.custom;
  return impl.run(job, context);
}

async function streamProc(cmd, args, { cwd, jobId, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: false });
    let out = '';
    child.stdout.on('data', d => { const line = d.toString(); out += line; emit(EVT.JOB_LOG, { jobId, level: 'info', message: line.trim() }); });
    child.stderr.on('data', d => { const line = d.toString(); emit(EVT.JOB_LOG, { jobId, level: 'warn', message: line.trim() }); });
    child.on('error', reject);
    child.on('close', code => { if (code === 0) resolve({ code, output: out, messages: out.trim() }); else reject(new Error(`Harness exited with code ${code}\n${out}`)); });
  });
}

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
  // Inject conversation guidance (user messages) so the agent stays on course.
  const guidance = await recentGuidance(context, spec.id);
  if (guidance) parts.push(`\nHUMAN GUIDANCE FROM THE SPEC THREAD:\n${guidance}`);
  return parts.join('\n');
}

// Pull the latest human/system notes for the spec thread so the agent session
// stays aligned with the team's messages.
async function recentGuidance(context, specId) {
  try {
    const { getDb } = await import('../core/store.js');
    const rows = getDb().prepare('SELECT role, content FROM messages WHERE spec_id=? AND content IS NOT NULL AND length(content)>0 ORDER BY id DESC LIMIT 6').all(specId);
    if (!rows.length) return null;
    return rows.reverse().map(r => `- [${r.role}] ${r.content.slice(0, 500)}`).join('\n');
  } catch { return null; }
}

const HARNESSES = {
  // Hermes headless: 'hermes chat -q "<prompt>"' executed in the checkout.
  hermes: {
    async run(job, context) {
      const prompt = await buildPrompt(context, job);
      const args = ['chat', '-q', prompt];
      if (job.model) args.push('-m', job.model);
      return streamProc(process.env.HERMES_BIN || 'hermes', args, { cwd: context.checkout, jobId: job.id });
    },
  },

  claude: {
    async run(job, context) {
      const prompt = await buildPrompt(context, job);
      const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'];
      if (job.model) args.push('--model', job.model);
      return streamProc('claude', args, { cwd: context.checkout, jobId: job.id });
    },
  },

  // Custom: job.step.command (or config.custom_command) templated with placeholders.
  custom: {
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
      return streamProc('/bin/bash', ['-c', rendered], { cwd: context.checkout, jobId: job.id });
    },
  },

  // Direct LLM call — useful for planning, review, and lightweight verify steps.
  llm: {
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
      // Allow verify steps to pass/fail by inspecting output markers.
      if (job.lifecycle === 'verify') {
        const fail = /FAIL(?:\s|:|\()/i.test(out) && !/PASS/i.test(out);
        if (fail) throw new Error('Verification failed (LLM reported failure): ' + out.slice(0, 300));
      }
      return { code: 0, output: out, messages: out.trim() };
    },
  },
};

export const HARNESS_LIST = Object.keys(HARNESSES);