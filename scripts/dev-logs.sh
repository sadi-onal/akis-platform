#!/usr/bin/env bash
# AKIS Platform — tail backend + frontend logs in a unified, readable stream.
# Backend uses pino (JSON) — pino-pretty makes it human-readable.
# Frontend uses plain console output.
#
# Usage:
#   ./scripts/dev-logs.sh           # both logs, pretty-printed, prefixed [BE]/[FE]
#   ./scripts/dev-logs.sh backend   # backend only
#   ./scripts/dev-logs.sh frontend  # frontend only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

target="${1:-both}"

PRETTY_BIN="backend/node_modules/.bin/pino-pretty"
pretty() {
  if [ -x "$PRETTY_BIN" ]; then
    "$PRETTY_BIN" -t SYS:HH:MM:ss -i pid,hostname --singleLine
  else
    cat
  fi
}

prefix() {
  local tag="$1"
  awk -v tag="$tag" '{ printf "%s %s\n", tag, $0; fflush() }'
}

ensure_log() {
  [ -f "$1" ] || touch "$1"
}

case "$target" in
  backend)
    ensure_log backend.log
    tail -F backend.log | pretty
    ;;
  frontend)
    ensure_log frontend.log
    tail -F frontend.log
    ;;
  both|"")
    ensure_log backend.log
    ensure_log frontend.log
    # Two parallel streams, each prefixed so you can tell them apart.
    # On exit (Ctrl+C), kill both background tails so we don't leak.
    trap 'kill 0' INT TERM EXIT

    ( tail -F backend.log  | pretty | prefix '\033[36m[BE]\033[0m' ) &
    ( tail -F frontend.log         | prefix '\033[35m[FE]\033[0m' ) &
    wait
    ;;
  *)
    echo "Usage: $0 [backend|frontend|both]"
    exit 1
    ;;
esac
