#!/usr/bin/env bash
#
# SpecFlow bootstrap for a CLAUDE-CODE-ONLY setup.
#
# One command, no API keys. If you have `claude` (Claude Code CLI) and `node`
# installed, this gets a working SpecFlow where every pipeline step is run by
# Claude Code. Claude brings its own auth — you do NOT need OpenRouter/Gemini/
# NVIDIA keys.
#
#   bash scripts/setup-claude.sh <owner/repo> [optional: repo_root]
#
# Example:
#   bash scripts/setup-claude.sh myorg/myapp
#
set -euo pipefail

REPO="${1:?usage: bash scripts/setup-claude.sh <owner/repo> [repo_root]}"
ROOT="${2:-./work}"

echo "▶ Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "✗ node not found. Install Node 18+ first."; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "✗ 'claude' CLI not found. Install Claude Code (see https://docs.anthropic.com/claude-code)."; exit 1; }
echo "  ✓ node $(node -v)"
echo "  ✓ claude $(claude --version 2>/dev/null || echo '(installed)')"

echo "▶ Installing dependencies..."
npm install --silent

echo "▶ Writing .env (Claude-only, no API keys needed)..."
cat > .env <<EOF
SPECFLOW_PORT=9120
SPECFLOW_DB=./data/specflow.db
SPECFLOW_REPO_ROOT=${ROOT}
# Claude-only: no OPENROUTER/GEMINI/NVIDIA keys required.
EOF

echo "▶ Creating dirs..."
mkdir -p data "${ROOT}"

echo "▶ Setting default harness to claude (so every step runs via Claude Code)..."
node --input-type=module <<'EOF'
import 'dotenv/config';
import { initStore } from './src/core/store.js';
import { updateSettings } from './src/core/settings.js';
import { instantiatePresets } from './src/core/core.js';
initStore(process.env.SPECFLOW_DB || './data/specflow.db');
updateSettings({ default_harness: 'claude' });
instantiatePresets(); // seeds the "Claude Code (all steps)" pipeline too
console.log('  ✓ default harness = claude');
console.log('  ✓ seeded pipelines (incl. "Claude Code (all steps)")');
EOF

echo ""
echo "▶ Available coding-agent CLIs on this server:"
node --input-type=module <<'EOF'
import { checkAvailability } from './src/harnesses/index.js';
const a = await checkAvailability();
const cli = a.filter(x => x.binary && x.binary !== '—');
for (const x of cli) {
  const mark = x.available ? '✓' : '✗';
  console.log(`  ${mark} ${x.label.padEnd(18)} ${x.binary}${x.version ? '  ('+x.version+')' : ''}`);
}
const missing = a.filter(x => x.available === false);
if (missing.length) console.log(`\n  (install ones you want: ${missing.map(x=>x.binary).join(', ')})`);
EOF

echo ""
echo "🎉 Done! Start it:"
echo "    npm start"
echo "    → http://localhost:9120/ui/"
echo ""
echo "Then: New Spec → repo '${REPO}' → pipeline 'Claude Code (all steps)' → Run."
echo ""
echo "NOTE: add GOOGLE_API_KEY=... to .env if you want plan/review steps to use"
echo "      the cheap Gemini provider instead of Claude."