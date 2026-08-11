// Agent harness abstraction. Each harness knows how to take a task (a job)
// and execute it against a checkout. Implementations are pluggable:
//   - 'hermes'   : drives a Hermes instance (headless) via CLI flags
//   - 'claude'   : Claude Code CLI
//   - 'custom'   : arbitrary shell command / script

import { spawn } from 'node:child_process';
import { emit, EVT } from '../core/events.js';

export async function runHarness(job, context) {
  const harnessId = (job.harness || 'custom').toLowerCase();
  const impl = HARNESSES[harnessId] || HARNESSES.custom;
  return impl.run(job, context);
}

async function streamProc(cmd, args, { cwd, jobId, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env   : { ...process.env, ...env },
      shell : false,
    });

    let out = '';
    child.stdout.on('data', d => {
      const line = d.toString();
      out += line;
      emit(EVT.JOB_LOG, { jobId, level: 'info', message: line.trim() });
    });
    child.stderr.on('data', d => {
      const line = d.toString();
      emit(EVT.JOB_LOG, { jobId, level: 'warn', message: line.trim() });
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ code, output: out });
      else reject(new Error(`Harness exited with code ${code}\n${out}`));
    });
  });
}

async function buildPrompt(context, job) {
  const spec = context.spec;
  return [
    'You are implementing a feature for a software project.',
    '',
    `FEATURE: ${spec.title}`,
    '',
    `DESCRIPTION:\n${spec.description || '(none)'}`,
    '',
    `ACCEPTANCE CRITERIA:\n${spec.acceptance_criteria || '(none)'}`,
    '',
    `Working repository: ${job.repo || context.repo}`,
    `Branch: ${job.branch}`,
    '',
    'Please implement this feature, commit your changes with a clear message,',
    'and report what you did. Follow the conventions already present in the repo.',
  ].join('\n');
}

const HARNESSES = {
  // Hermes headless: 'hermes chat -q "<prompt>"' executed in the checkout.
  // Workdir is set via the spawn cwd option (not a CLI flag).
  hermes: {
    async run(job, context) {
      const prompt = await buildPrompt(context, job);
      const args = ['chat', '-q', prompt];
      if (job.model) args.push('-m', job.model);
      return streamProc(process.env.HERMES_BIN || 'hermes', args, {
        cwd   : context.checkout,
        jobId : job.id,
      });
    },
  },

  // Claude Code CLI: claude -p "prompt" --dangerously-skip-permissions
  claude: {
    async run(job, context) {
      const prompt = await buildPrompt(context, job);
      const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'];
      if (job.model) args.push('--model', job.model);
      return streamProc('claude', args, {
        cwd   : context.checkout,
        jobId : job.id,
      });
    },
  },

  // Custom: job.harness_config.command templated with {checkout} {prompt_file}
  custom: {
    async run(job, context) {
      const cmd = job.harness_config?.command || context.config?.custom_command;
      if (!cmd) throw new Error('Custom harness requires a command in config');
      // Write prompt to a temp file so arbitrary tools can read it
      const fs = await import('node:fs');
      const promptPath = `${context.checkout}/.specflow_prompt.md`;
      fs.writeFileSync(promptPath, await buildPrompt(context, job));
      const rendered = cmd
        .replaceAll('{checkout}', context.checkout)
        .replaceAll('{prompt_file}', promptPath)
        .replaceAll('{branch}', job.branch);
      // Execute via bash -c to support pipes & args
      return streamProc('/bin/bash', ['-c', rendered], {
        cwd   : context.checkout,
        jobId : job.id,
      });
    },
  },

  // Direct LLM call (no code agent) — useful for review/planning or simple tasks
  llm: {
    async run(job, context) {
      const { chatComplete } = await import('../llm/providers.js');
      const prompt = await buildPrompt(context, job);
      const out = await chatComplete({
        provider : job.provider || context.config?.provider || 'openrouter',
        model    : job.model || context.config?.model,
        messages : [{ role: 'system', content: 'You are an autonomous coding assistant.' }, { role: 'user', content: prompt }],
        config   : context.config,
      });
      emit(EVT.JOB_LOG, { jobId: job.id, level: 'info', message: out });
      return { code: 0, output: out };
    },
  },
};

export const HARNESS_LIST = Object.keys(HARNESSES);