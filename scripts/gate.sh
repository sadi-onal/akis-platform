#!/usr/bin/env bash
# AKIS Platform — pre-commit quality gate.
# Runs typecheck, lint, unit tests, and production build for both
# backend and frontend. Fails fast on first error.
#
# Usage: ./scripts/gate.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

step() { echo -e "\n${BLUE}== $* ==${NC}"; }

step "backend: typecheck"
pnpm -C backend typecheck

step "backend: lint"
pnpm -C backend lint

step "backend: unit tests"
pnpm -C backend test:unit

step "frontend: typecheck"
pnpm -C frontend typecheck

step "frontend: lint"
pnpm -C frontend lint

step "frontend: tests"
pnpm -C frontend test

step "frontend: build"
pnpm -C frontend build

echo -e "\n${GREEN}✓ ALL GATES PASSED${NC}"
