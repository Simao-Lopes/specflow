#!/usr/bin/env bash
#
# SpecFlow bootstrap for a GEMINI-ONLY setup.
# Just one key: GOOGLE_API_KEY. The llm harness (plan/review/test) uses Gemini
# directly; the "Code" step can use hermes/claude/codex if installed, or gemini's
# llm provider.
#
#   bash scripts/setup-gemini.sh <owner/repo> <GOOGLE_API_KEY> [repo_root] [model]
#   bash scripts/setup-gemini.sh myorg/myapp AIza...skjdk2 kjlds
#
set -euo pipefail

REPO="${1:?usage: bash scripts/setup-gemini.sh <owner/repo> <GOOGLE_API_KEY> [repo_root] [model]}"
API_KEY="${2:?GOOGLE_API_KEY is required as arg 2}"
ROOT="${3:-./work}"
MODEL="${4:-gemini-3.5-flash-lite}"

echo "▶ Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "✗ node not found."; exit 1; }
echo "  ✓ node $(node -v)"

echo "▶ Installing dependencies..."
npm install --silent

echo "▶ Writing .env (Gemini-only, your API key)..."
umask 077
cat > .env <<EOF
SPECFLOW_PORT=9120
SPECFLOW_DB=./data/specflow.db
SPECFLOW_REPO_ROOT=${ROOT}
GOOGLE_API_KEY=${API_KEY}
EOF
umask 022

echo "▶ Creating dirs..."
mkdir -p data "${ROOT}"

echo "▶ Configuring default harness=llm + provider=gemini + model=${MODEL}..."
node --input-type=module <<EOF
import 'dotenv/config';
import { initStore } from './src/core/store.js';
import { updateSettings } from './src/core/settings.js';
import { instantiatePresets } from './src/core/core.js';
initStore(process.env.SPECFLOW_DB || './data/specflow.db');
updateSettings({ default_harness: 'llm', llm_provider: 'gemini', llm_model: '${MODEL}' });
instantiatePresets();
console.log('  ✓ default harness = llm (provider gemini, model ${MODEL})');
EOF

echo ""
echo "🎉 Done! Start it:"
echo "    npm start"
echo "    → http://localhost:9120/ui/"
echo ""
echo "NOTE: plan/review/test steps use Gemini (llm harness). For the 'Code' step,"
echo "      either install a coding-agent CLI (claude/codex/opencode) and set the"
echo "      step's harness, or use a fully-custom step with provider gemini."