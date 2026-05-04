#!/usr/bin/env bash
# AKIS Platform — start local dev environment
# - Starts Postgres + Adminer in Docker
# - Runs DB migrations
# - Starts backend (port 3000) and frontend (port 5173) in background
#
# Usage: ./scripts/dev-up.sh
# Stop:  ./scripts/dev-down.sh
# Logs:  tail -f backend.log frontend.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${BLUE}▶${NC}  $*"; }
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
fail() { echo -e "${RED}✗${NC}  $*"; exit 1; }

# 1. Preflight
command -v docker  >/dev/null || fail "Docker not found"
command -v pnpm    >/dev/null || fail "pnpm not found"
docker info >/dev/null 2>&1   || fail "Docker daemon not running"
[ -L backend/.env ] || [ -f backend/.env ] || fail "backend/.env missing"

# 2. Start DB
log "Starting Postgres + Adminer (docker-compose.dev.yml)"
docker compose -f docker-compose.dev.yml up -d

log "Waiting for Postgres to be ready"
for i in {1..30}; do
  if docker exec akis-dev-db pg_isready -U postgres >/dev/null 2>&1; then
    ok "Postgres ready"
    break
  fi
  sleep 1
  [ $i -eq 30 ] && fail "Postgres not ready after 30s"
done

# 3. Migrations
log "Running DB migrations"
pnpm -C backend db:migrate >/tmp/akis-dev-migrate.log 2>&1 \
  && ok "Migrations applied" \
  || fail "Migration failed (see /tmp/akis-dev-migrate.log)"

# 4. Backend
log "Starting backend on :3000"
nohup pnpm -C backend dev > backend.log 2>&1 &
echo $! > .backend.pid
ok "Backend PID $(cat .backend.pid) — log: backend.log"

# 5. Frontend
log "Starting frontend on :5173"
nohup pnpm -C frontend dev > frontend.log 2>&1 &
echo $! > .frontend.pid
ok "Frontend PID $(cat .frontend.pid) — log: frontend.log"

echo ""
ok "AKIS local environment is running:"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:3000/health"
echo "   Adminer:  http://localhost:8080  (server=db, user=postgres, pass=postgres, db=akis_v2)"
echo ""
echo "   Stop with: ./scripts/dev-down.sh"
