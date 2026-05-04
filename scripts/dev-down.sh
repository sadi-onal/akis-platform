#!/usr/bin/env bash
# AKIS Platform — stop local dev environment
# Stops backend, frontend, and Docker DB.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

stop_pid_file() {
  local file="$1"
  local name="$2"
  if [ -f "$file" ]; then
    local pid
    pid=$(cat "$file")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      echo "✓ Stopped $name (PID $pid)"
    fi
    rm -f "$file"
  fi
}

stop_pid_file .backend.pid backend
stop_pid_file .frontend.pid frontend

# Also kill any orphaned tsx/vite processes from this repo
pkill -f "tsx watch.*$REPO_ROOT/backend" 2>/dev/null || true
pkill -f "vite.*$REPO_ROOT/frontend" 2>/dev/null || true

echo "▶ Stopping Docker services"
docker compose -f docker-compose.dev.yml down

echo "✓ AKIS local environment stopped"
