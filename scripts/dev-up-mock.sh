#!/usr/bin/env bash
# AKIS Platform — start local dev environment in DOGFOOD_MODE.
#
# Convenience wrapper for `./scripts/dev-up.sh --mock`. Use this for the
# token-free, GitHub-free local exercise:
#   - AI: real Anthropic key from .env (real generated code)
#   - GitHub: stubbed via DOGFOOD_MODE (no real push, no OAuth setup needed)
#
# Stop:  ./scripts/dev-down.sh
# Docs:  docs/runbook/dogfood-mode.md
#
# Normal dev (real GitHub + real AI):
#   ./scripts/dev-up.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${REPO_ROOT}/scripts/dev-up.sh" --mock "$@"
