#!/usr/bin/env bash
# AKIS Platform — tail backend + frontend logs in a single stream.
# Backend uses pino (JSON) — pino-pretty makes it human-readable.
# Frontend uses plain console output.
#
# Usage:
#   ./scripts/dev-logs.sh           # both logs
#   ./scripts/dev-logs.sh backend   # backend only
#   ./scripts/dev-logs.sh frontend  # frontend only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

target="${1:-both}"

# Use pino-pretty from backend/node_modules if installed; otherwise raw tail.
PRETTY="cat"
if [ -x "backend/node_modules/.bin/pino-pretty" ]; then
  PRETTY="backend/node_modules/.bin/pino-pretty -t SYS:HH:MM:ss -i pid,hostname"
fi

case "$target" in
  backend)
    [ -f backend.log ] || { echo "backend.log not found — start with ./scripts/dev-up.sh"; exit 1; }
    tail -F backend.log | $PRETTY
    ;;
  frontend)
    [ -f frontend.log ] || { echo "frontend.log not found — start with ./scripts/dev-up.sh"; exit 1; }
    tail -F frontend.log
    ;;
  both|"")
    [ -f backend.log ] || touch backend.log
    [ -f frontend.log ] || touch frontend.log
    # tail -F prefixes each line with the file name when multiple files are given.
    tail -F backend.log frontend.log
    ;;
  *)
    echo "Usage: $0 [backend|frontend|both]"
    exit 1
    ;;
esac
