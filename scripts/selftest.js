// End-to-end self-test: exercises the full pipeline
// (create agent -> create spec -> run job -> checkout/branch -> harness -> commit -> PR)
import 'dotenv/config';
import { initStore, getDb } from '../src/core/store.js';
import { upsertAgent, createSpec, runJob } from '../src/core/core.js';
import { parseRepoUrl } from '../src/git/git.js';

async function main() {
  initStore('./data/specflow.db');
  const repo = 'https://github.com/Simao-Lopes/specflow-demo-target.git';

  // 1. Configure a custom harness command (appends a note to README)
  getDb().prepare(`INSERT INTO config (key,value) VALUES ('custom_command', ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run('echo "\\n\\n> **SpecFlow demo change** implemented by test harness." >> {checkout}/README.md');

  // 2. Register agent
  const agent = upsertAgent({
    name: 'demo-agent', harness: 'custom', repo, auto_pr: 1, active: 1,
  });
  console.log('Agent:', agent.id, agent.harness, agent.repo);

  // 3. Create spec
  const spec = createSpec({
    title: 'Add demo note to README',
    description: 'Append a short note documenting the SpecFlow-driven flow.',
    type: 'feature',
    repo,
    acceptance_criteria: 'README contains a line about SpecFlow demo',
  });
  console.log('Spec:', spec.id, spec.title);

  // 4. Run it (sync through custom queue won't finish before we check; check queue)
  const jobId = await runJob({ specId: spec.id });
  console.log('Job:', jobId, 'status', getDb().prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status);

  // 5. Poll until done (limit ~60s)
  for (let i = 0; i < 60; i++) {
    const row = getDb().prepare('SELECT status, pr_url, error FROM jobs WHERE id=?').get(jobId);
    if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
      console.log(`\nFinal status: ${row.status}`);
      console.log('PR URL:', row.pr_url || '(none)');
      if (row.error) console.log('Error:', row.error);
      // dump logs
      const logs = getDb().prepare('SELECT level,message FROM job_logs WHERE job_id=? ORDER BY id').all(jobId);
      for (const l of logs) console.log(`  [${l.level}] ${l.message}`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(e => { console.error('SELFTEST FAIL:', e?.message || e); process.exit(1); });