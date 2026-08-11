#!/usr/bin/env bash
# Raise a SpecFlow instance on this box behind Tailscale.
# Usage: ./deploy/install.sh [port]
set -euo pipefail
PORT="${1:-9120}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "🔧 Installing SpecFlow on port ${PORT} ..."

# 1. Build backend deps + web UI
npm install
npm run setup
if [ ! -d web/dist ]; then
  (cd web && npm ci && npm run build)
fi

# 2. Write .env if absent
if [ ! -f .env ]; then
  cp .env.example .env
  # prompt for the essentials
  read -rp "OPENROUTER_API_KEY (leave blank if not used): " KEY
  [ -n "$KEY" ] && sed -i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=${KEY}|" .env
fi
# Ensure port is set
grep -q '^SPECFLOW_PORT=' .env && sed -i "s|^SPECFLOW_PORT=.*|SPECFLOW_PORT=${PORT}|" .env || echo "SPECFLOW_PORT=${PORT}" >> .env

# 3. Install systemd unit
UNIT="deploy/specflow.service"
sed -e "s|/home/ubuntu/specflow|${ROOT}|g" "$UNIT" > "/tmp/${USER}-specflow.service"
sudo cp "/tmp/${USER}-specflow.service" "/etc/systemd/system/specflow.service"
sudo systemctl daemon-reload
sudo systemctl enable specflow
sudo systemctl restart specflow

echo "✅ SpecFlow running. Wait a moment then check:"
echo "   curl -s http://localhost:${PORT}/health"
echo "   Web UI: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}/ui/"
echo "   Tailscale: http://$(tailscale ip -4 2>/dev/null | head -1):${PORT}/ui/"