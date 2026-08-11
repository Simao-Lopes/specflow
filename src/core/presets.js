// SpecFlow pipeline presets — complete, ready-to-run industry pipelines that
// combine the method library into end-to-end flows. Seeded into the Pipelines
// section on first run so a team can select one and go (then customise it).
//
// Each step references a `method` from src/methods/catalog.js (template id) or
// a custom action ("<phase>:<name>"); the backend resolves harness/prompt. For
// `custom` harness steps a sensible default command is provided where possible.

const stub = { iterations: 1, on_failure: 'continue', verify: [], prompt: '' };
const st = (name, method, extra = {}) => ({ id: slug(name), name, method, ...stub, ...extra });

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export const PIPELINE_PRESETS = [
  {
    name: 'GitHub Spec Kit: Full Flow',
    description: 'The canonical SDD loop (Microsoft/GitHub): specification, technical plan, spec-first implementation, integration tests, then code review.',
    steps: [
      st('Specify', 'plan-spec'),
      st('Plan', 'plan-technical'),
      st('Implement', 'code-spec-first'),
      st('Test', 'test-integration', { harness: 'custom', command: 'npm test --silent', on_failure: 'stop', iterations: 3 }),
      st('Review', 'review-code', { iterations: 2 }),
    ],
  },
  {
    name: 'TDD: Red → Green → Refactor',
    description: 'Strict test-driven development: a plan, TDD coding, unit tests as the gate, then code review.',
    steps: [
      st('Plan', 'plan-sketch'),
      st('TDD Implement', 'code-tdd', { iterations: 3, on_failure: 'stop' }),
      st('Unit Tests', 'test-unit', { harness: 'custom', command: 'npm test --silent', on_failure: 'stop', iterations: 3 }),
      st('Review', 'review-code'),
    ],
  },
  {
    name: 'Security-First (OWASP)',
    description: 'For security-sensitive changes: plan with an ADR, conventional implementation, contract + e2e tests, then a mandatory OWASP security review.',
    steps: [
      st('Plan w/ ADR', 'plan-adr'),
      st('Implement', 'code-conventional', { iterations: 3, on_failure: 'stop' }),
      st('Contract Tests', 'test-contract', { harness: 'custom', command: 'npm test', on_failure: 'stop', iterations: 3 }),
      st('E2E', 'test-e2e', { harness: 'custom', command: 'npm run test:e2e', on_failure: 'stop' }),
      st('Security Review', 'review-security', { iterations: 2, on_failure: 'stop' }),
    ],
  },
  {
    name: 'Performance-Aware (Simão)',
    description: 'Implementation that is held to a performance bar: integration + e2e tests, then an explicit performance review before merge.',
    steps: [
      st('Specify', 'plan-spec'),
      st('Technical Plan', 'plan-technical'),
      st('Implement', 'code-direct', { iterations: 3, on_failure: 'stop' }),
      st('Integration', 'test-integration', { harness: 'custom', command: 'npm test', on_failure: 'stop', iterations: 3 }),
      st('Performance Review', 'review-performance', { iterations: 2, on_failure: 'stop' }),
    ],
  },
  {
    name: 'Docs + Release',
    description: 'Ship a change with its documentation: implement, update docs, write changelog + API reference, then a light review.',
    steps: [
      st('Specify', 'plan-spec'),
      st('Implement', 'code-direct', { iterations: 2, on_failure: 'stop' }),
      st('Update Docs', 'docs-update'),
      st('Changelog', 'docs-changelog'),
      st('API Reference', 'docs-api'),
      st('Review', 'review-read'),
    ],
  },
  {
    name: 'MVP Quick Start',
    description: 'The leanest path to a shippable slice: a sketch plan, direct implementation, and a smoke test. Bypasses heavy review.',
    steps: [
      st('Plan', 'plan-sketch'),
      st('Build', 'code-direct', { iterations: 2, on_failure: 'stop' }),
      st('Smoke Test', 'test-smoke', { harness: 'custom', command: 'npm start --check && curl -sf localhost:3000/health || exit 1', on_failure: 'stop' }),
    ],
  },
];