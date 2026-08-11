// One-shot setup: create data + work dirs, seed a default example spec, and
// print next steps. Idempotent.
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { initStore, getDb } from '../src/core/store.js';
import { buildServer } from '../src/api/server.js';

console.log('🔧 SpecFlow setup...');

const dbPath = process.env.SPECFLOW_DB || './data/specflow.db';
const repoRoot = process.env.SPECFLOW_REPO_ROOT || './work';
mkdirSync('data', { recursive: true });
mkdirSync(repoRoot, { recursive: true });
process.env.SPECFLOW_REPO_ROOT = process.env.SPECFLOW_REPO_ROOT || repoRoot;

// Init schema
initStore(dbPath);

// Seed a demo spec if none exists
const count = getDb().prepare('SELECT COUNT(*) AS n FROM specs').get().n;
if (count === 0) {
  getDb().prepare(`INSERT INTO specs (id,title,description,type,status,repo,acceptance_criteria)
                   VALUES ('demo','Demo spec: add health endpoint','Add a GET /health returning {"ok":true}.','feature','backlog',?, 'The endpoint returns 200 with a JSON body containing an ok field.')`)
     .run(process.env.SPECFLOW_DEMO_REPO || null);
  console.log('✅ Seeded a demo spec (id=demo).');
} else {
  console.log('ℹ️  Specs already present — skipped seeding.');
}

console.log(`\n✔ Store ready at ${dbPath}`);
console.log(`✔ Repos clone into ${repoRoot}`);
console.log('\nStart the server with:  npm start');
console.log('Open the UI at:        http://localhost:9120/ui/');
console.log('Create an agent:       node src/cli.js agent create --name bot --harness custom --repo <git-url>');