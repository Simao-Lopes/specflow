// SpecFlow methods library.
//
// Every pipeline step is method-driven: pick an INDUSTRY TEMPLATE (ordered
// simplest -> most complex) or a CUSTOM ACTION defined in a folder inside the
// repo the service runs. A method is a named, reusable behaviour that supplies
// a default harness + a prompt template (and for custom actions, a command).
//
// Phases mirror GitHub Spec Kit (Microsoft):
//   specify (what/why) -> plan (how) -> tasks/implement -> test -> review.
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../../templates');
let _fileCache = {};

// Load a real template/command file's content (cached). Templates live in
// /templates/<methodology>/... and are the AUTHENTIC prompts — e.g. the actual
// GitHub Spec Kit spec/plan/tasks templates and command definitions. A method
// with a `file` field ships that exact content to the agent.
function loadTemplateFile(relPath) {
  if (!relPath) return '';
  if (_fileCache[relPath]) return _fileCache[relPath];
  const abs = isAbsolute(relPath) ? relPath : resolve(TEMPLATES_DIR, relPath);
  let text = '';
  try { if (existsSync(abs)) text = readFileSync(abs, 'utf8'); } catch { text = ''; }
  _fileCache[relPath] = text;
  return text;
}

// ---------------------------------------------------------------------------
// Industry templates — ordered by increasing rigour/complexity per phase.
// `tpl` is a prompt template with {feature}, {description}, {acceptance},
// {phase} placeholders. `harness`: llm | hermes | claude | custom.
// ---------------------------------------------------------------------------
// Default models used when an LLM template has no provider/model set.
const METHODS_LLM_DEFAULT = {
  gemini: 'gemini-3.5-flash-lite',
  openrouter: 'deepseek/deepseek-chat',
  nvidia: 'nvidia/llama-3.1-nemotron-70b-instruct',
  ollama: 'qwen3:30b-a3b',
};

function getEnv(k) {
  try { return process.env[k] || ''; } catch { return ''; }
}

export const METHODS = {
  plan: [
    {
      id: 'plan-sketch', name: 'Sketch', complexity: 1,
      harness: 'llm',
      tpl: 'Quick plan for the feature. Feature: {description}. List 3-6 bullet steps to implement it. No code, keep it short.',
    },
    {
      id: 'plan-spec', name: 'Specify (what/why)', complexity: 2,
      harness: 'llm',
      file: 'spec-kit/commands/specify.md',
      source: 'github/spec-kit',
      tpl: `You are running the GitHub Spec Kit /specify command for feature: {description}. ` +
        `Follow the authoritative instruction below (verbatim) to produce a feature specification ` +
        `(prioritized user stories with acceptance scenarios, functional requirements, measurable ` +
        `success criteria, key entities, assumptions) written to a spec.md leaning on the spec template. ` +
        `Acceptance criteria: {acceptance}\n\n# Official /specify instruction\n\n` +
        `{{SOURCE}}`,
    },
    {
      id: 'plan-technical', name: 'Technical plan (how)', complexity: 3,
      harness: 'llm',
      file: 'spec-kit/commands/plan.md',
      source: 'github/spec-kit',
      tpl: `You are running the GitHub Spec Kit /plan command for feature: {description}. ` +
        `Execute the implementation planning workflow producing research.md, data-model.md, ` +
        `contracts/, and quickstart.md per the plan template, respecting the constitution. ` +
        `Acceptance criteria: {acceptance}\n\n# Official /plan instruction\n\n` +
        `{{SOURCE}}`,
    },
    {
      id: 'plan-adr', name: 'ADR + plan', complexity: 4,
      harness: 'llm',
      file: 'adr/adr-template.md',
      source: 'adr/madr',
      tpl: `You are producing an Architecture Decision Record (MADR/ADR.org format) for feature: {description}. ` +
        `Follow the canonical MADR template below (verbatim): status, date, decision drivers, considered ` +
        `options, decision outcome, and consequences — at least 2 alternatives considered. ` +
        `Then a short technical plan referencing the ADR. Acceptance: {acceptance}\n\n` +
        `# Official ADR template (MADR — Architecture Decision Records)\n\n{{SOURCE}}`,
    },
    {
      id: 'plan-cosmos', name: 'Full design doc (cosmos-style)', complexity: 5,
      harness: 'llm',
      file: 'spec-kit/plan-template.md',
      source: 'github/spec-kit',
      tpl: `You are writing a comprehensive design/implementation plan for feature: {description}. ` +
        `Follow the canonical plan template below (verbatim): technical context, constitution check, ` +
        `project structure, complexity tracking. Acceptance: {acceptance}\n\n` +
        `# Official plan template (GitHub Spec Kit)\n\n{{SOURCE}}`,
    },
  ],

  code: [
    {
      id: 'code-direct', name: 'Direct implement', complexity: 1,
      harness: 'hermes',
      tpl: 'Implement the feature described. Feature: {description}. Acceptance: {acceptance}. Minimal, conventional, focused changes.',
    },
    {
      id: 'code-tdd', name: 'Test-driven (red→green→refactor)', complexity: 2,
      harness: 'hermes',
      file: 'tdd/red-green-refactor.md',
      source: 'kent beck / TDD',
      tpl: `Implement via strict TDD for: {description}. Acceptance: {acceptance}. ` +
        `Follow the canonical TDD workflow below (verbatim): the Three Laws and Red-Green-Refactor ` +
        `cycle — one failing test first, minimal code to pass, then refactor. ` +
        `Only consider the feature done when the test passes. Acceptance: {acceptance}\n\n` +
        `# Test-Driven Development — Red·Green·Refactor\n\n{{SOURCE}}`,
    },
    {
      id: 'code-spec-first', name: 'Spec-first implement (Spec Kit)', complexity: 3,
      harness: 'hermes',
      file: 'spec-kit/commands/implement.md',
      source: 'github/spec-kit',
      tpl: `You are running the GitHub Spec Kit /implement command for feature: {description}. ` +
        `Implement the project from the spec/plan/tasks per the authoritative instruction below. ` +
        `Follow it verbatim (phases, checklists, commit discipline). Acceptance: {acceptance}\n\n` +
        `# Official /implement instruction\n\n{{SOURCE}}`,
    },
    {
      id: 'code-conventional', name: 'Conventional commits + structure', complexity: 4,
      harness: 'hermes',
      file: 'conventional-commits/spec.md',
      source: 'conventionalcommits.org',
      tpl: `Implement: {description}. Acceptance: {acceptance}. ` +
        `Follow the Conventional Commits specification below (verbatim) for commit messages — ` +
        `feat/fix/docs/refactor with scope and optional body/breaking-change markers. Keep commits structured ` +
        `and logical. Acceptance: {acceptance}\n\n# Conventional Commits Specification (v1.0.0)\n\n{{SOURCE}}`,
    },
    {
      id: 'code-parallel', name: 'Multi-variant exploration', complexity: 5,
      harness: 'llm',
      tpl: `For feature: {description}, produce 2-3 alternative implementation strategies/approaches with trade-offs (e.g. performance vs simplicity, or two different architectures). Acceptance: {acceptance}. Present options without committing to code.`,
    },
  ],

  docs: [
    {
      id: 'docs-update', name: 'Update docs', complexity: 1,
      harness: 'llm',
      tpl: 'Update the project documentation to reflect: {description}. Acceptance: {acceptance}. Keep changes accurate and concise; update README and relevant guides if they are affected.',
    },
    {
      id: 'docs-changelog', name: 'Changelog + release notes', complexity: 2,
      harness: 'llm',
      file: 'changelog/keep-a-changelog.md',
      source: 'keepachangelog.com',
      tpl: `Write changelog/release-note entries for: {description}. Acceptance: {acceptance}. ` +
        `Follow the Keep-a-Changelog methodology below (verbatim): Added/Changed/Deprecated/Removed/` +
        `Fixed/Security sections, un-released vs released, human-readable. Acceptance: {acceptance}\n\n` +
        `# Keep a Changelog (official)\n\n{{SOURCE}}`,
    },
    {
      id: 'docs-api', name: 'API reference (OpenAPI/docstrings)', complexity: 3,
      harness: 'llm',
      tpl: 'Document the API surface for: {description}. Acceptance: {acceptance}. Produce/update OpenAPI schemas or docstrings for every public endpoint/function, with examples.',
    },
    {
      id: 'docs-migration', name: 'Migration & upgrade guide', complexity: 4,
      harness: 'llm',
      tpl: 'Write a migration/upgrade guide for: {description}. Acceptance: {acceptance}. Cover breaking changes, required steps, and rollback.',
    },
    {
      id: 'docs-deep', name: 'Deep technical documentation', complexity: 5,
      harness: 'llm',
      tpl: 'Write deep technical documentation for: {description}. Acceptance: {acceptance}. Include architecture diagrams (text/ASCII), design rationale, data flows, and operational runbooks.',
    },
  ],

  test: [
    {
      id: 'test-smoke', name: 'Smoke check', complexity: 1,
      harness: 'custom',
      command: '{checkout}/{smoke}', // placeholder; overridden by user command usually
      file: 'test-pyramid/pyramid.md',
      source: 'martinfowler.com',
      tpl: `Smoke-test the change for: {description}. Acceptance: {acceptance}. ` +
        `Run the relevant command and confirm it does not crash. Test selection follows the ` +
        `Test Pyramid (Martin Fowler) below. Follow it verbatim.\n\n# The Test Pyramid (Martin Fowler)\n\n{{SOURCE}}`,
    },
    {
      id: 'test-unit', name: 'Unit tests', complexity: 2,
      harness: 'custom',
      command: '',
      file: 'test-pyramid/pyramid.md',
      source: 'martinfowler.com',
      tpl: `Write/run UNIT tests for the change: {description}. Acceptance: {acceptance}. ` +
        `These are the base of the Test Pyramid (Martin Fowler) below — many low-level unit tests ` +
        `covering the new logic in isolation. Follow it verbatim. Acceptance: {acceptance}\n\n` +
        `# The Test Pyramid (Martin Fowler)\n\n{{SOURCE}}`,
    },
    {
      id: 'test-contract', name: 'Contract / API tests', complexity: 3,
      harness: 'custom',
      command: '',
      file: 'test-pyramid/pyramid.md',
      source: 'martinfowler.com',
      tpl: `Add/run CONTRACT tests for: {description}. Acceptance: {acceptance}. ` +
        `The Test Pyramid below describes the intermediate subcutaneous/service layer — ` +
        `verify the public API surface against expected behaviour without the UI. Follow it verbatim.\n\n` +
        `# The Test Pyramid (Martin Fowler)\n\n{{SOURCE}}`,
    },
    {
      id: 'test-integration', name: 'Integration tests', complexity: 4,
      harness: 'custom',
      command: '',
      file: 'test-pyramid/pyramid.md',
      source: 'martinfowler.com',
      tpl: `Write/run INTEGRATION tests for: {description}. Acceptance: {acceptance}. ` +
        `Exercise real components together (DB, services, network) — the middle service layer of the ` +
        `Test Pyramid below. Follow it verbatim. Acceptance: {acceptance}\n\n` +
        `# The Test Pyramid (Martin Fowler)\n\n{{SOURCE}}`,
    },
    {
      id: 'test-e2e', name: 'End-to-end + property', complexity: 5,
      harness: 'custom',
      command: '',
      file: 'test-pyramid/pyramid.md',
      source: 'martinfowler.com',
      tpl: `Add/run END-TO-END + property-based tests for: {description}. Acceptance: {acceptance}. ` +
        `The Test Pyramid below warns that broad-stack E2E are brittle/slow — use them sparingly as ` +
        `the top of the pyramid, cover full user paths, and back them with unit tests. Follow it verbatim.\n\n` +
        `# The Test Pyramid (Martin Fowler)\n\n{{SOURCE}}`,
    },
  ],

  review: [
    {
      id: 'review-read', name: 'Read-through', complexity: 1,
      harness: 'llm',
      tpl: 'Read the changes made for: {description}. Acceptance: {acceptance}. Summarise what changed and flag anything obviously wrong or missing. Keep it light.',
    },
    {
      id: 'review-code', name: 'Code review (best practices)', complexity: 2,
      harness: 'llm',
      file: 'spec-kit/commands/checklist.md',
      source: 'github/spec-kit',
      tpl: `You are running the GitHub Spec Kit /checklist command to review feature quality for: {description}. ` +
        `Follow the authoritative instruction below (verbatim) — generate and validate a requirements/implementation checklist. ` +
        `Acceptance: {acceptance}\n\n# Official /checklist instruction\n\n{{SOURCE}}`,
    },
    {
      id: 'review-security', name: 'Security review (OWASP)', complexity: 3,
      harness: 'llm',
      file: 'owasp/threat-modeling.md',
      source: 'owasp.org',
      tpl: `Security-review the changes for: {description} using OWASP threat modeling (STRIDE). ` +
        `Follow the OWASP Threat Modeling Cheat Sheet below (verbatim): model the system, identify ` +
        `threats (spoofing/tampering/repudiation/info disclosure/DoS/elevation), rank them, define ` +
        `mitigations. Rate each finding by severity and give a go/no-go. Acceptance: {acceptance}\n\n` +
        `# OWASP Threat Modeling Cheat Sheet\n\n{{SOURCE}}`,
    },
    {
      id: 'review-performance', name: 'Performance review', complexity: 4,
      harness: 'llm',
      tpl: 'Performance-review the changes for: {description}. Look for O(N²)/hot paths, N+1 queries, unnecessary allocation, blocking I/O, and caching opportunities. Acceptance: {acceptance}. Quantify expected impact where possible.',
    },
    {
      id: 'review-architecture', name: 'Architecture + compliance review', complexity: 5,
      harness: 'llm',
      tpl: `Architecture and compliance review for: {description}. Assess fit vs the repo's documented architecture/constitution, layering, coupling, extensibility, and any standards. Acceptance: {acceptance}. Produce a structured decision record noting trade-offs.`,
    },
  ],
};

// Phase → expected description in each step's prompt (used by the UI grouping).
export const PHASE_LABELS = {
  plan: 'Plan',
  code: 'Code',
  test: 'Test / Verify',
  review: 'Review',
  docs: 'Docs',
};

// Where the service looks for custom actions, relative to the repo root the
// service runs with. Structure:
//   <repoRoot>/.specflow/actions/<phase>/<method-name>.<sh|py|js>
export function customActionsDir(repoRoot) {
  return join(repoRoot, '.specflow', 'actions');
}

// Scan for custom actions defined in the repo the service runs in.
// Returns a flat catalog keyed by phase: { plan: [{id,name,command,phase}], ... }.
export function listCustomActions({ repoRoot } = {}) {
  const out = Object.fromEntries(Object.keys(METHODS).map((p) => [p, []]));
  if (!repoRoot) return out;
  const base = customActionsDir(resolveRoot(repoRoot));
  if (!existsSync(base)) return out;

  for (const phase of Object.keys(out)) {
    const dir = join(base, phase);
    if (!existsSync(dir)) continue;
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      const p = join(dir, f);
      let isDir = false;
      try { isDir = statSync(p).isDirectory(); } catch { continue; }
      // Support a single executable file (foo.sh / foo.py) or a folder foo/{run.*,run.sh}
      let name = f, command = '';
      const ext = f.split('.').pop();
      if (isDir) {
        const runner = ['run.sh', 'run.py', 'run.js', 'run'].find((r) => existsSync(join(p, r)));
        if (!runner) continue;
        name = f;
        command = `bash ${join(p, runner)}`;
        if (runner.endsWith('.py')) command = `python3 ${join(p, runner)}`;
        if (runner.endsWith('.js')) command = `node ${join(p, runner)}`;
      } else if (['sh', 'py', 'js'].includes(ext)) {
        name = f.replace(/\.(sh|py|js)$/, '');
        command = ext === 'sh' ? `bash ${p}` : ext === 'py' ? `python3 ${p}` : `node ${p}`;
      } else {
        continue;
      }
      out[phase].push({ id: `${phase}:${name}`, name, phase, command, custom: true });
    }
    out[phase].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

// Resolve a step's method to concrete execution config.
// step.method is either a template id ("plan-sketch") or a custom id ("plan:foo"),
// or null/omitted meaning a fully custom step.
export function resolveMethod(step, ctx = {}) {
  const m = step?.method;
  if (!m) return null; // full custom step — use step's own harness/command/prompt

  // Explicit custom id form: "<phase>:<name>"
  if (m.includes(':')) {
    const [phase, slug] = m.split(':');
    const customs = listCustomActions(ctx);
    const custom = (customs[phase] || []).find((c) => c.id === m);
    if (custom) {
      return {
        source: 'custom', phase, id: custom.id, name: custom.name,
        harness: 'custom', command: custom.command,
        prompt: `[Custom action ${custom.name}] ${step?.prompt || ''}`.trim(),
      };
    }
  }

  // Built-in template id — look it up across ALL phases by id (phase is
  // encoded in the template itself, not guessed from the step name).
  for (const [phase, list] of Object.entries(METHODS)) {
    const tpl = list.find((t) => t.id === m);
    if (tpl) {
      const resolved = {
        source: 'template', phase, id: tpl.id, name: tpl.name, harness: tpl.harness,
        command: tpl.command || '',
        prompt: fillTemplate(tpl.tpl, step),
      };
      // LLM-based templates need a working provider/model by default so they run
      // even if the step didn't specify one. Prefer an explicit local setup.
      if (tpl.harness === 'llm') {
        resolved.provider = step?.provider || getEnv('SPECFLOW_LLM_PROVIDER') || 'gemini';
        resolved.model = step?.model || getEnv('SPECFLOW_LLM_MODEL') || schemaModel(resolved.provider);
      }
      return resolved;
    }
  }
  return null;
}

function schemaModel(provider) {
  const m = (METHODS_LLM_DEFAULT || {})[provider];
  return m || (provider === 'openrouter' ? 'deepseek/deepseek-chat' : null);
}

// Flattened template list for the UI, grouped by phase, with complexity label.
export function templateCatalog() {
  const out = {};
  for (const [phase, list] of Object.entries(METHODS)) {
    out[phase] = list.map((t) => ({ id: t.id, name: t.name, complexity: t.complexity, harness: t.harness }));
  }
  return out;
}

// Resolve a pipeline step's EFFECTIVE prompt for display/editing/exeuction.
// If the step has a stored prompt (step.prompt) it WINS — that is the verified,
// user-controlled prompt actually sent to the agent. Otherwise, for a method
// step, fall back to the filled method template. For a fully custom step with
// no prompt, return ''.
export function resolvedStepPrompt(step, { spec } = {}) {
  if (step?.prompt != null && String(step.prompt).trim() !== '') return String(step.prompt);
  return resolvedMethodPrompt(step, { spec });
}

// Resolve ONLY the method template prompt (ignoring any stored step.prompt) —
// used to refresh stale materialized prompts after a template upgrade.
export function resolvedMethodPrompt(step, { spec } = {}) {
  const resolved = resolveMethod({ ...step, _spec: spec || { title: step?.name || step?.id || 'the feature' } }, {});
  return resolved && resolved.prompt != null ? resolved.prompt : '';
}

// Materialize the effective prompt onto each step (and its verify sub-agents)
// so it is STORED and VISIBLE, not implied by a method. Returns a new steps
// array where every step.prompt is set to its effective prompt.
export function materializePrompts(steps, { spec } = {}) {
  return (Array.isArray(steps) ? steps : []).map((s) => {
    const out = { ...s };
    out.prompt = resolvedStepPrompt(s, { spec });
    if (Array.isArray(s.verify) && s.verify.length) {
      out.verify = s.verify.map((v) => ({ ...v, prompt: resolvedStepPrompt(v, { spec }) }));
    }
    return out;
  });
}

// The RAW method template for a step (with {placeholders} visible), or '' if
// the step is fully custom. Used to show exactly what the method prompts look
// like before fill-in.
export function rawTemplate(step) {
  if (!step?.method) return '';
  for (const list of Object.values(METHODS)) {
    const t = list.find((x) => x.id === step.method);
    if (t && t.tpl) return t.tpl; // raw template with {placeholders} intact
  }
  return '';
}

function fillTemplate(tpl, step) {
  const spec = step?._spec || {};
  // Inline any authentic methodology command/template content referenced by the
  // method via {file: 'methodology/...'}. The `{{SOURCE}}` marker is replaced
  // with the exact file content so the agent gets the real, canonical prompt.
  if (typeof tpl === 'string' && tpl.includes('{{SOURCE}}')) {
    const file = methodFile(step?.method);
    if (file) tpl = String(tpl).replace('{{SOURCE}}', file);
  }
  return String(tpl || '')
    .replaceAll('{feature}', spec.title || (step?.name || 'the feature'))
    .replaceAll('{description}', spec.description || '')
    .replaceAll('{acceptance}', spec.acceptance_criteria || '(not specified)')
    .replaceAll('{phase}', step?.phase || 'step');
}

function methodFile(methodId) {
  if (!methodId) return '';
  for (const list of Object.values(METHODS)) {
    const t = list.find((x) => x.id === methodId);
    if (t && t.file) return loadTemplateFile(t.file);
  }
  return '';
}

function guessPhase(step) {
  const n = (step?.name || step?.id || '').toLowerCase();
  if (n.includes('test') || n.includes('verify') || n.includes('check')) return 'test';
  if (n.includes('plan') || n.includes('spec') || n.includes('design') || n.includes('adr')) return 'plan';
  return 'code';
}

function resolveRoot(p) {
  // ensure absolute so folder scanning is unambiguous
  return isAbsolute(p) ? p : resolve(p);
}