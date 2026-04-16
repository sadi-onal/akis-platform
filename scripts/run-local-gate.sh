#!/usr/bin/env bash
# Single-terminal local quality gate (backend + frontend unit + build).
# E2E: Playwright starts Vite via playwright.config; many specs mock /auth.
# If E2E flakes, run: pnpm -C frontend test:e2e -- --grep "auth-deep-links"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== backend: typecheck, lint, unit tests ==="
pnpm -C backend typecheck
pnpm -C backend lint
pnpm -C backend test:unit

echo "=== frontend: typecheck, lint, vitest, production build ==="
pnpm -C frontend typecheck
pnpm -C frontend lint
pnpm -C frontend test
pnpm -C frontend build

echo "=== frontend: Playwright E2E (chromium) ==="
pnpm -C frontend test:e2e

echo "=== LOCAL GATE: ALL STEPS PASSED ==="
