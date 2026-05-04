#!/usr/bin/env bash
# AKIS Platform — stop local dev environment.
# Kills anything listening on backend (:3000) and frontend (:5173) ports,
# regardless of which session/path started them. This is intentional:
# port-based killing catches stale processes from previous Claude sessions
# or from before the project was renamed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Kill whoever is bound to a port (safer than tracking PIDs in files).
kill_port() {
  local port="$1"
  local name="$2"
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "✓ Killing $name on :$port (PIDs: $pids)"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

kill_port 3000 backend
kill_port 5173 frontend

# Belt-and-suspenders: also kill any tsx/vite watchers tied to *any* AKIS path.
# Catches the case where a watcher was spawned but never bound a port yet.
pkill -9 -f "tsx watch src/server.ts" 2>/dev/null || true
pkill -9 -f "node.*vite/bin/vite\.js" 2>/dev/null || true

# Clean up stale PID files
rm -f .backend.pid .frontend.pid

echo "▶ Stopping Docker services"
docker compose -f docker-compose.dev.yml down

echo "✓ AKIS local environment stopped"
