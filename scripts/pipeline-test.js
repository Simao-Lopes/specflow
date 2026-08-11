// Pipeline test: proves iterate-until-pass. Plan (llm) succeeds; Code runs once;
// Test fails on first verify, then a retry marker makes it pass -> Code should re-run
// (iteration 2) and the whole pipeline should SUCCEED.
import 'dotenv/config';
import { initStore, getDb } from '../src/core/store.js';
import { createSpec, runJob } from '../src/core/core.js';
import { rmSync } from 'node:fs';

async function main() {
  const DB = './data/specflow-pipeline-test.db';
  initStore(DB);
  for (const t of ['jobs','job_logs','job_steps','specs','messages']) getDb().prepare(`DELETE FROM ${t}`).run();

  const steps = [
    {
      id: 'plan', name: 'Plan', harness: 'llm', provider: 'gemini', model: 'gemini-3.5-flash-lite',
      iterations: 1, on_failure: 'continue', verify: [], prompt: 'Reply with exactly PLAN_DONE.',
    },
    {
      id: 'code', name: 'Code', harness: 'custom',
      iterations: 3, on_failure: 'stop',
      command: 'echo "CODE:$(cat {checkout}/tries.txt 2>/dev/null || echo 0)"',
      // Test fails the first time (creates tries.txt=1 marker) then succeeds.
      verify: [
        { id: 'test', name: 'Test', harness: 'custom',
          command: 'if [ ! -f {checkout}/tries.txt ]; then echo 1 > {checkout}/tries.txt; echo "VERIFY_FAIL_ATTEMPT1"; exit 1; else echo "OK"; exit 0; fi',
          iterations: 1, on_failure: 'stop', prompt: '' },
      ],
    },
  ];

  const spec = createSpec({ title: 'iterate-pass-test', description: 'prove recovery', type: 'feature', steps });
  console.log('Spec:', spec.id);
  const jobId = await runJob({ specId: spec.id });
  console.log('Job:', jobId);

  for (let i = 0; i < 60; i++) {
    const r = getDb().prepare('SELECT status,error FROM jobs WHERE id=?').get(jobId);
    if (r.status === 'succeeded' || r.status === 'failed') {
      console.log('FINAL:', r.status, r.error || '');
      const ss = getDb().prepare('SELECT step_id,attempt,status FROM job_steps WHERE job_id=?').all(jobId);
      for (const s of ss) console.log(`  [${s.step_id}] attempt=${s.attempt} ${s.status}`);
      const logs = getDb().prepare("SELECT message FROM job_logs WHERE job_id=? AND (message LIKE '%[Test]%' OR message LIKE '%Iteration%' OR message LIKE '%passed%' OR message LIKE '%Step:%') ORDER BY id").all(jobId);
      console.log('--- key logs ---');
      for (const l of logs) console.log(' ', l.message);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  rmSync(DB, { force: true }); rmSync(DB+'-wal', { force: true }); rmSync(DB+'-shm', { force: true });
}

main().catch(e => { console.error('TEST FAIL:', e?.message || e); process.exit(1); });