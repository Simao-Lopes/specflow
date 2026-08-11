// Entry point: launches the SpecFlow API server + web UI.
import 'dotenv/config';
import { buildServer } from './server.js';

const port = Number(process.env.SPECFLOW_PORT || 9120);
const dbPath = process.env.SPECFLOW_DB || './data/specflow.db';

try {
  const { listen } = buildServer({ dbPath, port });
  const actualPort = await listen();
  console.log(`\n🚀 SpecFlow listening on http://0.0.0.0:${actualPort}`);
  console.log(`   Web UI : http://localhost:${actualPort}/ui/`);
  console.log(`   Health : http://localhost:${actualPort}/health`);
} catch (e) {
  console.error('Failed to start SpecFlow:', e?.message || e);
  process.exit(1);
}