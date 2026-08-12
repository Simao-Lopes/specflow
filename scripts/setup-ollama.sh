#!/usr/bin/env bash
#
# SpecFlow bootstrap for a FULLY-LOCAL setup using Ollama.
# No API keys, no cloud. Requires: node + a running Ollama (https://ollama.com)
# with a model you've pulled (e.g. `ollama pull qwen3`).
#
#   bash scripts/setup-ollama.sh <owner/repo> [repo_root] [ollama_model]
#   bash scripts/setup-ollama.sh myorg/myapp ./work qwen3:14b
#
set -euo pipefail

REPO="${1:?usage: bash scripts/setup-ollama.sh <owner/repo> [repo_root] [ollama_model]}"
ROOT="${2:-./work}"
MODEL="${3:-qwen3:14b}"

echo "▶ Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "✗ node not found."; exit 1; }
if ! command -v ollama >/dev/null 2>&1; then
  echo "⚠ 'ollama' CLI not found. Install it (https://ollama.com) and run 'ollama serve'."
  echo "  You can still set up; jobs will fail until Ollama is available."
fi
echo "  ✓ node $(node -v)"
echo "  model: ${MODEL}"

echo "▶ Installing dependencies..."
npm install --silent

echo "▶ Writing .env (fully local, no API keys)..."
cat > .env <<EOF
SPECFLOW_PORT=9120
SPECFLOW_DB=./data/specflow.db
SPECFLOW_REPO_ROOT=${ROOT}
# Fully local via Ollama — no cloud keys.
EOF

echo "▶ Creating dirs..."
mkdir -p data "${ROOT}"

echo "▶ Configuring default harness=llm + provider=ollama + model=${MODEL}..."
node --input-type=module <<EOF
import 'dotenv/config';
import { initStore } from './src/core/store.js';
import { updateSettings } from './src/core/settings.js';
import { instantiatePresets } from './src/core/core.js';
initStore(process.env.SPECFLOW_DB || './data/specflow.db');
updateSettings({ default_harness: 'llm', llm_provider: 'ollama', llm_model: '${MODEL}' });
instantiatePresets();
console.log('  ✓ default harness = llm (provider ollama, model ${MODEL})');
EOF

echo ""
echo "🎉 Done! Start it:"
echo "    npm start"
echo "    → http://localhost:9120/ui/"
echo ""
echo "Make sure Ollama is running:  ollama serve   (and: ollama pull ${MODEL})"
echo "Then: New Spec → repo '${REPO}' → any pipeline → Run."