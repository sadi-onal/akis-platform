#!/bin/bash
# =============================================================================
# AKIS Pre-Built Image Deployment
# =============================================================================
# Builds the Docker image LOCALLY using buildx (cross-compile for ARM64),
# transfers it as a tarball to the OCI server, and deploys.
#
# This is faster than server-side build on OCI Free Tier (1 OCPU, 6GB RAM)
# because modern Macs cross-compile ARM64 images much faster.
#
# Usage:
#   ./scripts/deploy_prebuilt.sh --host IP --user USER --key PATH [options]
#
# Required Parameters:
#   --host IP       OCI VM IP address or domain
#   --user USER     SSH username (e.g., ubuntu, opc)
#   --key PATH      Path to SSH private key file
#
# Optional Parameters:
#   --skip-quality       Skip quality gates (when already run locally)
#   --skip-tests         Alias for --skip-quality
#   --skip-backup        Skip pre-deploy database backup
#   --force              Continue on failures
#   --confirm            Execute deployment (dry-run without this)
#   --help               Show this help message
#
# Exit Codes:
#   0 - Success
#   1 - Preflight failure
#   2 - Build failure
#   3 - Deploy failure
#   4 - Verification failure
#
# Examples:
#   # Dry-run (preview commands)
#   ./scripts/deploy_prebuilt.sh --host 141.147.25.123 --user ubuntu --key ~/.ssh/akis-oci
#
#   # Full deploy (local build + transfer)
#   ./scripts/deploy_prebuilt.sh --host 141.147.25.123 --user ubuntu --key ~/.ssh/akis-oci --confirm
#
#   # Fast deploy (skip quality gates, already ran them)
#   ./scripts/deploy_prebuilt.sh --host 141.147.25.123 --user ubuntu --key ~/.ssh/akis-oci \
#     --skip-quality --confirm
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
SSH_HOST=""
SSH_USER=""
SSH_KEY=""
SKIP_QUALITY=false
SKIP_BACKUP=false
FORCE=false
CONFIRM=false

# Timing helpers
DEPLOY_START=$(date +%s)
phase_start() {
  PHASE_START=$(date +%s)
}
phase_end() {
  local elapsed=$(( $(date +%s) - PHASE_START ))
  echo -e "${BLUE}[${elapsed}s elapsed]${NC}"
}

# Image config
BACKEND_IMAGE="ghcr.io/omeryasironal/akis-platform-devolopment/akis-backend"
IMAGE_TARBALL="/tmp/akis-backend.tar"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --host)
      SSH_HOST="$2"
      shift 2
      ;;
    --user)
      SSH_USER="$2"
      shift 2
      ;;
    --key)
      SSH_KEY="$2"
      shift 2
      ;;
    --skip-quality)
      SKIP_QUALITY=true
      shift
      ;;
    --skip-tests)
      SKIP_QUALITY=true
      shift
      ;;
    --skip-backup)
      SKIP_BACKUP=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --confirm)
      CONFIRM=true
      shift
      ;;
    --help)
      head -n 47 "$0" | tail -n 43 | sed 's/^# //'
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Run with --help for usage information"
      exit 1
      ;;
  esac
done

# Dry-run helper
dry_run() {
  if [ "$CONFIRM" = false ]; then
    echo -e "${BLUE}[DRY-RUN]${NC} Would execute: $*"
    return 0
  else
    eval "$@"
  fi
}

# Error handler
error_exit() {
  echo -e "${RED}ERROR: $1${NC}"
  echo ""
  if [ -n "${2:-}" ]; then
    echo "WHAT TO DO NEXT:"
    echo "$2"
  fi
  exit "${3:-1}"
}

# Cleanup handler — remove local tarball on exit
cleanup() {
  rm -f "${IMAGE_TARBALL}" 2>/dev/null || true
}
trap cleanup EXIT

# =============================================================================
# Banner
# =============================================================================
echo "=============================================="
echo "AKIS Pre-Built Image Deployment"
echo "=============================================="

# =============================================================================
# Phase 1: Preflight Checks
# =============================================================================
echo ""
echo "Phase 1: Preflight checks"
echo "-------------------------------------------"
phase_start

# Validate required arguments
if [ -z "$SSH_HOST" ]; then
  error_exit "Missing required argument: --host" \
    "Specify the OCI VM IP address or domain with --host" 1
fi

if [ -z "$SSH_USER" ]; then
  error_exit "Missing required argument: --user" \
    "Specify the SSH username with --user" 1
fi

if [ -z "$SSH_KEY" ]; then
  error_exit "Missing required argument: --key" \
    "Specify the path to SSH private key with --key" 1
fi

# Expand tilde in SSH_KEY path
SSH_KEY="${SSH_KEY/#\~/$HOME}"

# Validate SSH key exists
if [ ! -f "$SSH_KEY" ]; then
  error_exit "SSH key file not found: $SSH_KEY" \
    "Verify the key path is correct" 1
fi

# Determine expected commit
if ! EXPECTED_FULL=$(git rev-parse HEAD 2>/dev/null); then
  error_exit "Failed to determine git HEAD" \
    "Ensure you are in the devagents repository root" 1
fi

EXPECTED_SHORT=$(echo "$EXPECTED_FULL" | cut -c1-7)
IMAGE_TAG="${BACKEND_IMAGE}:${EXPECTED_SHORT}"

echo "Target commit: ${EXPECTED_SHORT} (full: ${EXPECTED_FULL})"
echo "Image tag: ${IMAGE_TAG}"
echo "SSH target: ${SSH_USER}@${SSH_HOST}"
echo "SSH key: ${SSH_KEY}"

if [ "$CONFIRM" = false ]; then
  echo -e "${YELLOW}Deployment mode: DRY-RUN (use --confirm to execute)${NC}"
else
  echo -e "${GREEN}Deployment mode: CONFIRMED${NC}"
fi

# Check git working tree
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  if [ "$CONFIRM" = true ]; then
    echo -e "${YELLOW}Warning: Git working tree is dirty (uncommitted changes)${NC}"
    if [ "$FORCE" = false ]; then
      error_exit "Refusing to deploy dirty working tree" \
        "Commit your changes or use --force to override" 1
    fi
    echo -e "${YELLOW}Continuing anyway (--force specified)${NC}"
  else
    echo -e "${YELLOW}Warning: Git working tree is dirty${NC}"
  fi
else
  echo "Git working tree clean"
fi

# Verify required files exist
REQUIRED_FILES=(
  "deploy/oci/prod/deploy.sh"
  "deploy/oci/prod/docker-compose.yml"
  "deploy/oci/prod/Caddyfile"
  "Dockerfile.backend"
  "backend/package.json"
  "backend/tsconfig.json"
)

for file in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    error_exit "Required file not found: $file" \
      "Ensure you are in the devagents repository root" 1
  fi
done

echo "Required files present"

# Check docker buildx is available
if ! docker buildx version &>/dev/null; then
  error_exit "docker buildx is not available" \
    "Install Docker Desktop or docker buildx plugin" 1
fi

echo "docker buildx available"

# Test SSH connectivity
echo "Testing SSH connectivity..."
if [ "$CONFIRM" = true ]; then
  if ! ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
    "${SSH_USER}@${SSH_HOST}" "echo ok" &>/dev/null; then
    error_exit "SSH connection failed" \
      "1. Verify host is reachable: ping ${SSH_HOST}
   2. Verify SSH key has correct permissions: chmod 600 ${SSH_KEY}
   3. Verify key is authorized on server" 1
  fi
  echo "SSH connectivity verified"
else
  echo "[DRY-RUN] Would test SSH connectivity"
fi

phase_end

# =============================================================================
# Phase 2: Quality Gates (Optional)
# =============================================================================
echo ""
echo "Phase 2: Quality gates (typecheck/lint)"
echo "-------------------------------------------"
phase_start

if [ "$SKIP_QUALITY" = true ]; then
  echo "Skipped (--skip-quality specified)"
else
  # Backend typecheck
  echo "Running backend typecheck..."
  if [ "$CONFIRM" = true ]; then
    if ! pnpm -C backend typecheck; then
      if [ "$FORCE" = false ]; then
        error_exit "Backend typecheck failed" \
          "Fix type errors or use --force to continue" 2
      fi
      echo -e "${YELLOW}Backend typecheck failed but continuing (--force)${NC}"
    else
      echo "Backend typecheck passed"
    fi
  else
    echo "[DRY-RUN] Would run: pnpm -C backend typecheck"
  fi

  # Backend lint
  echo "Running backend lint..."
  if [ "$CONFIRM" = true ]; then
    if ! pnpm -C backend lint; then
      if [ "$FORCE" = false ]; then
        error_exit "Backend lint failed" \
          "Fix lint errors or use --force to continue" 2
      fi
      echo -e "${YELLOW}Backend lint failed but continuing (--force)${NC}"
    else
      echo "Backend lint passed"
    fi
  else
    echo "[DRY-RUN] Would run: pnpm -C backend lint"
  fi

  # Frontend typecheck
  echo "Running frontend typecheck..."
  if [ "$CONFIRM" = true ]; then
    if ! pnpm -C frontend typecheck; then
      if [ "$FORCE" = false ]; then
        error_exit "Frontend typecheck failed" \
          "Fix type errors or use --force to continue" 2
      fi
      echo -e "${YELLOW}Frontend typecheck failed but continuing (--force)${NC}"
    else
      echo "Frontend typecheck passed"
    fi
  else
    echo "[DRY-RUN] Would run: pnpm -C frontend typecheck"
  fi

  # Frontend lint
  echo "Running frontend lint..."
  if [ "$CONFIRM" = true ]; then
    if ! pnpm -C frontend lint; then
      if [ "$FORCE" = false ]; then
        error_exit "Frontend lint failed" \
          "Fix lint errors or use --force to continue" 2
      fi
      echo -e "${YELLOW}Frontend lint failed but continuing (--force)${NC}"
    else
      echo "Frontend lint passed"
    fi
  else
    echo "[DRY-RUN] Would run: pnpm -C frontend lint"
  fi
fi

phase_end

# =============================================================================
# Phase 3: Frontend Build
# =============================================================================
echo ""
echo "Phase 3: Frontend build"
echo "-------------------------------------------"
phase_start

# Check if frontend/dist exists and is up-to-date
NEEDS_BUILD=false

if [ ! -d "frontend/dist" ]; then
  echo "frontend/dist not found - build required"
  NEEDS_BUILD=true
elif [ ! -f "frontend/dist/index.html" ]; then
  echo "frontend/dist/index.html missing - build required"
  NEEDS_BUILD=true
else
  # Check if dist is stale (src newer than dist)
  if [ -n "$(find frontend/src -newer frontend/dist/index.html -print -quit 2>/dev/null)" ]; then
    echo "frontend/src has changes newer than dist - rebuild required"
    NEEDS_BUILD=true
  else
    echo "frontend/dist up-to-date (skipping rebuild)"
  fi
fi

if [ "$NEEDS_BUILD" = true ]; then
  echo "Building frontend..."
  if [ "$CONFIRM" = true ]; then
    if ! pnpm -C frontend build; then
      error_exit "Frontend build failed" \
        "Check build errors above" 2
    fi
    echo "Frontend build completed"
  else
    echo "[DRY-RUN] Would run: pnpm -C frontend build"
  fi
fi

# Verify dist is not empty
if [ "$CONFIRM" = true ]; then
  if [ ! -f "frontend/dist/index.html" ]; then
    error_exit "frontend/dist/index.html not found after build" \
      "Frontend build may have failed silently" 2
  fi
fi

phase_end

# =============================================================================
# Phase 4: Local Docker Build (cross-compile for ARM64)
# =============================================================================
echo ""
echo "Phase 4: Local Docker build (cross-compile ARM64)"
echo "-------------------------------------------"
phase_start

BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

if [ "$CONFIRM" = true ]; then
  echo "Building ${IMAGE_TAG} for linux/amd64..."
  echo "  (Cross-compiling on local machine — faster than OCI Free Tier)"

  # Use docker buildx to cross-compile for ARM64.
  # --load loads the image into the local Docker daemon (required for docker save).
  # --platform linux/amd64 targets the OCI ARM64 server.
  if docker buildx build \
      --platform linux/amd64 \
      -f Dockerfile.backend \
      --build-arg BUILD_COMMIT="${EXPECTED_SHORT}" \
      --build-arg BUILD_TIME="${BUILD_TIME}" \
      --build-arg APP_VERSION="0.2.0" \
      -t "${IMAGE_TAG}" \
      -t "${BACKEND_IMAGE}:latest" \
      --load \
      . 2>&1; then
    echo "Local ARM64 build successful"
  else
    error_exit "Local Docker build failed" \
      "Check build errors above. Ensure docker buildx is configured for linux/amd64." 2
  fi

  # Save image as tarball for transfer
  echo "Saving image to tarball: ${IMAGE_TARBALL}"
  if docker save -o "${IMAGE_TARBALL}" "${IMAGE_TAG}" 2>&1; then
    TARBALL_SIZE=$(du -sh "${IMAGE_TARBALL}" | cut -f1)
    echo "Image saved: ${IMAGE_TARBALL} (${TARBALL_SIZE})"
  else
    error_exit "Failed to save Docker image to tarball" \
      "Check disk space and Docker daemon status" 2
  fi
else
  echo "[DRY-RUN] Would run: docker buildx build --platform linux/amd64 -f Dockerfile.backend -t ${IMAGE_TAG} --load ."
  echo "[DRY-RUN] Would run: docker save -o ${IMAGE_TARBALL} ${IMAGE_TAG}"
fi

phase_end

# =============================================================================
# Phase 5: Pre-Deploy Backup (on server)
# =============================================================================
echo ""
echo "Phase 5: Pre-deploy backup"
echo "-------------------------------------------"
phase_start

if [ "$SKIP_BACKUP" = true ]; then
  echo "Skipped (--skip-backup specified)"
else
  BACKUP_FILENAME="prebuilt-$(date +%Y%m%d-%H%M%S).sql"

  if [ "$CONFIRM" = true ]; then
    echo "Creating database backup: ${BACKUP_FILENAME}"

    # Create backup directory if needed
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
      "mkdir -p /opt/akis/backups" || true

    # Create backup (non-blocking on failure)
    if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
      "docker exec akis-prod-db pg_dump -U akis akis_prod > /opt/akis/backups/${BACKUP_FILENAME} 2>/dev/null"; then
      echo "Database backup created: ${BACKUP_FILENAME}"
    else
      echo -e "${YELLOW}Database backup failed (non-critical, continuing)${NC}"
    fi

    # Cleanup old backups (>7 days)
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
      "find /opt/akis/backups -name '*.sql' -mtime +7 -delete 2>/dev/null" || true
  else
    echo "[DRY-RUN] Would create backup: ${BACKUP_FILENAME}"
    echo "[DRY-RUN] Would cleanup backups older than 7 days"
  fi
fi

phase_end

# =============================================================================
# Phase 6: Transfer Image + Files
# =============================================================================
echo ""
echo "Phase 6: Transfer image + files"
echo "-------------------------------------------"
phase_start

if [ "$CONFIRM" = true ]; then
  # Transfer the Docker image tarball
  echo "Transferring Docker image tarball to server..."
  if scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
    "${IMAGE_TARBALL}" "${SSH_USER}@${SSH_HOST}:/tmp/akis-backend.tar"; then
    echo "Image tarball transferred"
  else
    error_exit "Failed to transfer Docker image tarball" \
      "Check SSH connectivity and disk space on server" 3
  fi

  # Load the image on the server
  echo "Loading Docker image on server..."
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
    "docker load -i /tmp/akis-backend.tar && rm /tmp/akis-backend.tar" 2>&1; then
    echo "Docker image loaded on server"
  else
    error_exit "Failed to load Docker image on server" \
      "Check docker daemon status on server" 3
  fi

  # Transfer deploy config files
  echo "Copying deploy.sh..."
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
    deploy/oci/prod/deploy.sh "${SSH_USER}@${SSH_HOST}:/opt/akis/deploy.sh"
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
    "chmod +x /opt/akis/deploy.sh"

  echo "Copying docker-compose.yml..."
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
    deploy/oci/prod/docker-compose.yml "${SSH_USER}@${SSH_HOST}:/opt/akis/docker-compose.yml"

  echo "Copying Caddyfile..."
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
    deploy/oci/prod/Caddyfile "${SSH_USER}@${SSH_HOST}:/opt/akis/Caddyfile"

  # Transfer frontend dist
  echo "Creating frontend dist tarball..."
  tar -czf /tmp/frontend-dist-$$.tar.gz -C frontend/dist .

  echo "Copying frontend dist..."
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
    /tmp/frontend-dist-$$.tar.gz "${SSH_USER}@${SSH_HOST}:/tmp/frontend-dist.tar.gz"

  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
    "sudo rm -rf /opt/akis/frontend && \
     sudo mkdir -p /opt/akis/frontend && \
     sudo tar -xzf /tmp/frontend-dist.tar.gz -C /opt/akis/frontend && \
     sudo chown -R ${SSH_USER}:${SSH_USER} /opt/akis/frontend && \
     rm /tmp/frontend-dist.tar.gz"

  rm /tmp/frontend-dist-$$.tar.gz

  echo "All files transferred"
else
  echo "[DRY-RUN] Would transfer: ${IMAGE_TARBALL} -> server:/tmp/akis-backend.tar"
  echo "[DRY-RUN] Would run on server: docker load -i /tmp/akis-backend.tar"
  echo "[DRY-RUN] Would copy: deploy/oci/prod/deploy.sh -> /opt/akis/deploy.sh"
  echo "[DRY-RUN] Would copy: deploy/oci/prod/docker-compose.yml -> /opt/akis/docker-compose.yml"
  echo "[DRY-RUN] Would copy: deploy/oci/prod/Caddyfile -> /opt/akis/Caddyfile"
  echo "[DRY-RUN] Would copy: frontend dist -> /opt/akis/frontend/"
fi

phase_end

# =============================================================================
# Phase 7: Remote Execution
# =============================================================================
echo ""
echo "Phase 7: Remote execution"
echo "-------------------------------------------"
phase_start

if [ "$CONFIRM" = true ]; then
  # deploy.sh will detect the image already exists and skip build/pull.
  echo ">>> Executing /opt/akis/deploy.sh ${EXPECTED_SHORT}"
  echo "  (Image already loaded — deploy.sh will skip build)"
  echo ""

  SSH_CMD="cd /opt/akis && /opt/akis/deploy.sh '${EXPECTED_SHORT}'"

  # Execute deploy script on server with secret redaction
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
    "$SSH_CMD" 2>&1 | grep -v -E '(PASSWORD|SECRET|KEY|TOKEN)='; then
    echo ""
    echo "Deploy script completed successfully"
  else
    DEPLOY_EXIT=${PIPESTATUS[0]}
    echo ""
    echo -e "${RED}Deploy script failed with exit code: ${DEPLOY_EXIT}${NC}"
    echo ""
    echo "WHAT TO DO NEXT:"
    echo "  1. Check container status: ssh -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} 'cd /opt/akis && docker compose ps'"
    echo "  2. Check backend logs: ssh -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} 'cd /opt/akis && docker compose logs --tail=100 backend'"
    exit 3
  fi
else
  echo "[DRY-RUN] Would execute on server:"
  echo "  cd /opt/akis"
  echo "  /opt/akis/deploy.sh '${EXPECTED_SHORT}'"
  echo "  (Image already loaded — deploy.sh will skip build)"
fi

phase_end

# =============================================================================
# Phase 8: Post-Deploy Verification
# =============================================================================
echo ""
echo "Phase 8: Post-deploy verification"
echo "-------------------------------------------"
phase_start

if [ "$CONFIRM" = true ]; then
  echo "Waiting 15 seconds for stabilization..."
  sleep 15

  echo "Running smoke tests..."
  echo ""

  # Run smoke tests (use production domain, not IP — Caddy expects domain)
  PROD_DOMAIN="akisflow.com"
  if curl -sf "https://${PROD_DOMAIN}/health" > /dev/null && \
     curl -sf "https://${PROD_DOMAIN}/ready" > /dev/null && \
     curl -sf "https://${PROD_DOMAIN}/version" > /dev/null; then
    echo ""
    echo "All smoke tests passed"
  else
    SMOKE_EXIT=$?
    echo ""
    echo -e "${RED}Smoke tests failed with exit code: ${SMOKE_EXIT}${NC}"

    # Collect diagnostics
    echo ""
    echo "=== DEPLOYMENT FAILURE DIAGNOSTICS ==="
    echo ""
    echo "--- Container Status ---"
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
      "cd /opt/akis && docker compose ps" || true

    echo ""
    echo "--- Backend Container Image ---"
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
      "docker inspect akis-prod-backend --format 'Image: {{.Config.Image}}\nCreated: {{.Created}}' 2>/dev/null" || true

    echo ""
    echo "--- Backend Logs (last 100 lines, secrets redacted) ---"
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
      "cd /opt/akis && docker compose logs --tail=100 backend 2>&1 | grep -v -E '(PASSWORD|SECRET|KEY|TOKEN)='" || true

    echo ""
    echo "=== END DIAGNOSTICS ==="
    exit 4
  fi
else
  PROD_DOMAIN="akisflow.com"
  echo "[DRY-RUN] Would wait 15 seconds for stabilization"
  echo "[DRY-RUN] Would run smoke tests against https://${PROD_DOMAIN}"
fi

phase_end

# =============================================================================
# Phase 9: Summary
# =============================================================================
TOTAL_ELAPSED=$(( $(date +%s) - DEPLOY_START ))
TOTAL_MIN=$(( TOTAL_ELAPSED / 60 ))
TOTAL_SEC=$(( TOTAL_ELAPSED % 60 ))

echo ""
echo "=============================================="
echo "Pre-Built Deployment Summary"
echo "=============================================="
echo "Expected commit: ${EXPECTED_SHORT}"
echo "Image tag: ${IMAGE_TAG}"
echo "Total time: ${TOTAL_MIN}m ${TOTAL_SEC}s"
if [ "$CONFIRM" = true ]; then
  echo "Deployed commit: ${EXPECTED_SHORT}"
  echo "Verification: PASSED"
  echo ""
  echo -e "${GREEN}Deployment Status: SUCCESS${NC}"
  echo ""
  echo "Verification URLs:"
  echo "  https://akisflow.com/health"
  echo "  https://akisflow.com/ready"
  echo "  https://akisflow.com/version"
else
  echo ""
  echo -e "${YELLOW}DRY-RUN COMPLETE${NC}"
  echo ""
  echo "To execute this deployment, add --confirm to the command."
fi
echo "=============================================="

exit 0
