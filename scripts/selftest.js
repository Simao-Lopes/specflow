// End-to-end self-test: exercises the full pipeline
// (create spec -> run job -> checkout/branch -> harness -> gate -> commit -> PR)
// Harness-only: the spec carries its own repo; no separate "agent" entity.
import 'dotenv/config';
import { initStore, getDb } from '../src/core/store.js';
import { createSpec, runJob } from '../src/core/core.js';

async function main() {
  initStore('./data/specflow.db');
  const repo = 'https://github.com/Simao-Lopes/specflow-demo-target.git';

  // 1. Create spec pinned to a repo (no agent needed)
  const spec = createSpec({
    title: 'Add demo note to README',
    description: 'Append a short note documenting the SpecFlow-driven flow.',
    type: 'feature',
    repo,
    acceptance_criteria: 'README contains a line about SpecFlow demo',
  });
  console.log('Spec:', spec.id, spec.title, 'repo:', spec.repo);

  // 2. Run it
  const jobId = await runJob({ specId: spec.id });
  console.log('Job:', jobId, 'status', getDb().prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status);

  // 3. Poll until done (limit ~60s)
  for (let i = 0; i < 60; i++) {
    const row = getDb().prepare('SELECT status, pr_url, error FROM jobs WHERE id=?').get(jobId);
    if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
      console.log(`\nFinal status: ${row.status}`);
      console.log('PR URL:', row.pr_url || '(none)');
      if (row.error) console.log('Error:', row.error);
      const logs = getDb().prepare('SELECT level,message FROM job_logs WHERE job_id=? ORDER BY id').all(jobId);
      for (const l of logs) console.log(`  [${l.level}] ${l.message}`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(e => { console.error('SELFTEST FAIL:', e?.message || e); process.exit(1); });