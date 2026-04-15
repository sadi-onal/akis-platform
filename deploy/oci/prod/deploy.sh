#!/bin/bash
# =============================================================================
# AKIS Production Deploy Script
# =============================================================================
# This script is copied to the server and executed during deployment.
# It handles GHCR pull fallback, local build, migrations, and compose up.
#
# Arguments:
#   $1 - EXPECTED_COMMIT (git sha to deploy)
#
# Required environment on server:
#   - /opt/akis/.env with all required variables
#   - /opt/akis/backend-src with backend source (copied before this runs)
#   - /opt/akis/docker-compose.yml (copied before this runs)
#
# Exit codes:
#   0 - Success
#   1 - Failure (build or compose failed)
# =============================================================================

set -o pipefail  # Capture pipe failures

EXPECTED_COMMIT="$1"
if [ -z "$EXPECTED_COMMIT" ]; then
    echo "ERROR: EXPECTED_COMMIT argument required"
    exit 1
fi

cd /opt/akis

BACKEND_VERSION="${EXPECTED_COMMIT}"
BACKEND_IMAGE="ghcr.io/omeryasironal/akis-platform-devolopment/akis-backend"
BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
DEPLOY_EXIT=0
DEPLOY_START=$(date +%s)

# Timing helper — prints elapsed time for each step
step_timer() {
    local start=$1
    local elapsed=$(( $(date +%s) - start ))
    echo "  [${elapsed}s elapsed]"
}

echo "=============================================="
echo "=== AKIS Production Deploy Script ==="
echo "=============================================="
echo "Target commit: ${BACKEND_VERSION}"
echo "Build time: ${BUILD_TIME}"
echo "Working directory: $(pwd)"
echo ""

# -----------------------------------------------------------------------------
# Step 1: Check if image already exists locally (e.g. from docker load)
# -----------------------------------------------------------------------------
STEP1_START=$(date +%s)
echo ">>> Step 1: Checking for pre-loaded image..."
IMAGE_EXISTS=false
PULL_SUCCESS=false

if docker image inspect "${BACKEND_IMAGE}:${BACKEND_VERSION}" &>/dev/null; then
    echo "Image ${BACKEND_IMAGE}:${BACKEND_VERSION} already exists locally"
    echo "  (Loaded via deploy_prebuilt.sh or previous build)"
    echo "  Skipping GHCR pull and local build"
    IMAGE_EXISTS=true
    PULL_SUCCESS=true
else
    echo "Image not found locally, will attempt GHCR pull or local build"
fi
step_timer $STEP1_START
echo ""

# -----------------------------------------------------------------------------
# Step 2: Try GHCR login + pull (skip if image already loaded)
# -----------------------------------------------------------------------------
STEP2_START=$(date +%s)
echo ">>> Step 2: Attempting GHCR pull..."

if [ "$IMAGE_EXISTS" = "true" ]; then
    echo "Skipping GHCR pull — image already loaded"
else
    # Try ephemeral GHCR login if credentials are provided
    if [ -n "${GHCR_USERNAME:-}" ] && [ -n "${GHCR_READ_TOKEN:-}" ]; then
        echo "GHCR credentials provided, attempting login..."
        if echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin 2>&1; then
            echo "GHCR login successful"
            # Now try to pull the image
            if docker pull "${BACKEND_IMAGE}:${BACKEND_VERSION}" 2>&1; then
                echo "GHCR pull successful"
                PULL_SUCCESS=true
            else
                echo "GHCR pull failed (image may not exist yet)"
            fi
            # Logout to avoid storing credentials
            docker logout ghcr.io 2>/dev/null || true
        else
            echo "GHCR login failed"
        fi
    else
        echo "No GHCR credentials provided, attempting anonymous pull..."
        if docker pull "${BACKEND_IMAGE}:${BACKEND_VERSION}" 2>&1; then
            echo "GHCR pull successful (public image)"
            PULL_SUCCESS=true
        else
            echo "GHCR pull failed (no credentials or image not found)"
        fi
    fi
fi
step_timer $STEP2_START
echo ""

# -----------------------------------------------------------------------------
# Step 3: Fallback to server-side build if pull failed and no pre-loaded image
# -----------------------------------------------------------------------------
STEP3_START=$(date +%s)
echo ">>> Step 3: Check if local build needed..."

if [ "$IMAGE_EXISTS" = "true" ]; then
    echo "Skipping local build — image pre-loaded"
elif [ "$PULL_SUCCESS" = "false" ]; then
    echo "=== Building image locally (fallback) ==="

    if [ ! -d /opt/akis/repo-src ]; then
        # Fallback: check legacy backend-src directory
        if [ -d /opt/akis/backend-src ]; then
            echo "WARNING: Using legacy backend-src (no pipeline code)"
            cd /opt/akis/backend-src
        else
            echo "ERROR: /opt/akis/repo-src not found!"
            exit 1
        fi
    else
        cd /opt/akis/repo-src
    fi

    # Docker cache is used for unchanged layers (node_modules, system deps).
    # BUILD_COMMIT arg changes each deploy, busting cache from that layer onward.
    echo "Building with cache (commit arg busts from COPY src onward)..."
    DOCKERFILE="Dockerfile.backend"
    if [ ! -f "$DOCKERFILE" ]; then
        # Fallback: use legacy backend/Dockerfile
        echo "WARNING: Dockerfile.backend not found, using backend/Dockerfile"
        DOCKERFILE="backend/Dockerfile"
        cd backend 2>/dev/null || true
    fi
    if docker build \
        -f "$DOCKERFILE" \
        --build-arg BUILD_COMMIT="${BACKEND_VERSION}" \
        --build-arg BUILD_TIME="${BUILD_TIME}" \
        --build-arg APP_VERSION="0.2.0" \
        -t "${BACKEND_IMAGE}:${BACKEND_VERSION}" \
        -t "${BACKEND_IMAGE}:latest" \
        . 2>&1; then
        echo "Local build successful"
    else
        echo "ERROR: Local build FAILED"
        DEPLOY_EXIT=1
    fi
    cd /opt/akis
else
    echo "Skipping local build - using GHCR image"
fi
step_timer $STEP3_START
echo ""

# Exit early if build failed
if [ "$DEPLOY_EXIT" != "0" ]; then
    echo "=== Deployment FAILED at build step ==="
    exit ${DEPLOY_EXIT}
fi

# -----------------------------------------------------------------------------
# Step 4: Update .env with the target version
# -----------------------------------------------------------------------------
STEP4_START=$(date +%s)
echo ">>> Step 4: Updating .env..."
if grep -q '^BACKEND_VERSION=' .env 2>/dev/null; then
    sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${BACKEND_VERSION}/" .env
else
    echo "BACKEND_VERSION=${BACKEND_VERSION}" >> .env
fi
# Ensure GITHUB_REPOSITORY matches the image repo (docker-compose.yml uses this)
EXPECTED_REPO="omeryasironal/akis-platform-devolopment"
if grep -q '^GITHUB_REPOSITORY=' .env 2>/dev/null; then
    sed -i "s|^GITHUB_REPOSITORY=.*|GITHUB_REPOSITORY=${EXPECTED_REPO}|" .env
else
    echo "GITHUB_REPOSITORY=${EXPECTED_REPO}" >> .env
fi
export BACKEND_VERSION="${BACKEND_VERSION}"
export GITHUB_REPOSITORY="${EXPECTED_REPO}"
echo "BACKEND_VERSION set to: ${BACKEND_VERSION}"
echo "GITHUB_REPOSITORY set to: ${EXPECTED_REPO}"
step_timer $STEP4_START
echo ""

# -----------------------------------------------------------------------------
# Step 5: Run database migrations with smart error handling
# Only benign errors (enum already exists) are allowed; others fail the deploy
# -----------------------------------------------------------------------------
STEP5_START=$(date +%s)
echo ">>> Step 5: Running migrations..."
MIGRATION_LOG="/tmp/migration_output_$$.log"

# Run migrations and capture output
docker compose run --rm --pull never backend pnpm db:migrate > "$MIGRATION_LOG" 2>&1
MIGRATION_EXIT=$?

# Show migration output (redacted)
echo "--- Migration output (last 50 lines) ---"
tail -50 "$MIGRATION_LOG" | grep -v -E '(PASSWORD|SECRET|KEY|TOKEN)=' || true
echo "--- End migration output ---"

if [ "$MIGRATION_EXIT" = "0" ]; then
    echo "Migrations completed successfully"
else
    echo "Migration exited with code ${MIGRATION_EXIT}"

    # Check if the error is ONLY a benign "enum label already exists" error
    # Benign patterns that we allow:
    #   - "enum label .* already exists"
    #   - "relation .* already exists" (for idempotent table/index creation)
    #   - "column .* of relation .* already exists"
    BENIGN_PATTERNS="(enum label .* already exists|relation .* already exists|column .* of relation .* already exists)"

    # Extract actual error lines (lines containing 'error:' or 'ERROR')
    ERROR_LINES=$(grep -iE '(^error:|error:)' "$MIGRATION_LOG" || true)

    if [ -z "$ERROR_LINES" ]; then
        echo "No explicit error lines found, treating as success"
    else
        # Check if ALL error lines match benign patterns
        NON_BENIGN=$(echo "$ERROR_LINES" | grep -ivE "$BENIGN_PATTERNS" || true)

        if [ -z "$NON_BENIGN" ]; then
            echo "All errors are benign (already exists), continuing deployment"
        else
            echo "NON-BENIGN MIGRATION ERRORS DETECTED:"
            echo "$NON_BENIGN"
            echo ""
            echo "Full migration log (last 40 lines):"
            tail -40 "$MIGRATION_LOG"
            rm -f "$MIGRATION_LOG"
            echo ""
            echo "=== Deployment FAILED due to migration errors ==="
            exit 1
        fi
    fi
fi

rm -f "$MIGRATION_LOG"
echo "Migration step done."
step_timer $STEP5_START
echo ""

# -----------------------------------------------------------------------------
# Step 6: Deploy backend with targeted recreation
# IMPORTANT: We do NOT --force-recreate all services. Only backend is recreated
# to avoid killing Caddy (which also serves classcheck.site and other co-hosted
# services on this VM). Caddy config is reloaded separately if changed.
# -----------------------------------------------------------------------------
STEP6_START=$(date +%s)
echo ">>> Step 6: Starting services (CRITICAL STEP)..."

# 6a: Ensure infrastructure services (db, caddy) are up without force-recreating them.
#     docker compose up -d (without --force-recreate) only recreates containers
#     whose config/image has changed. This is safe for Caddy and DB.
echo "Ensuring infrastructure services are running..."
if [ "$PULL_SUCCESS" = "false" ]; then
    docker compose up -d --no-recreate --pull never db caddy 2>&1 || true
else
    docker compose up -d --no-recreate db caddy 2>&1 || true
fi

# 6b: Force-recreate ONLY the backend container (new image, new config)
echo "Force-recreating backend with new image..."
if [ "$PULL_SUCCESS" = "false" ]; then
    if docker compose up -d --force-recreate --no-deps --pull never backend 2>&1; then
        echo "Backend recreated successfully"
    else
        echo "ERROR: Backend recreation FAILED"
        DEPLOY_EXIT=1
    fi
else
    if docker compose up -d --force-recreate --no-deps backend 2>&1; then
        echo "Backend recreated successfully"
    else
        echo "ERROR: Backend recreation FAILED"
        DEPLOY_EXIT=1
    fi
fi

# 6c: Reload Caddy config (in case Caddyfile changed) — zero-downtime reload
echo "Reloading Caddy configuration (zero-downtime)..."
if docker exec akis-prod-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1; then
    echo "Caddy config reloaded successfully"
else
    echo "Caddy reload failed (may need container restart if Caddyfile format changed)"
    # Fallback: recreate Caddy only if reload fails
    docker compose up -d --force-recreate caddy 2>&1 || true
fi

# 6d: Final ensure — bring up any remaining services
# IMPORTANT: Do NOT use --force-recreate here. The earlier steps already handled
# backend recreation and caddy reload. Running plain "up -d" only recreates
# containers whose config/image actually changed. This prevents killing Caddy
# mid-TLS-handshake or disrupting co-hosted services.
echo "Final service check..."
if [ "$PULL_SUCCESS" = "false" ]; then
    docker compose up -d --remove-orphans --pull never 2>&1 || true
else
    docker compose up -d --remove-orphans 2>&1 || true
fi
step_timer $STEP6_START
echo ""

# -----------------------------------------------------------------------------
# Step 7: Verify containers are running and show detailed status
# -----------------------------------------------------------------------------
echo ">>> Step 7: Verifying container status..."
echo ""
echo "--- Container Status ---"
docker compose ps
echo ""

echo "--- MCP Gateway Container Details ---"
MCP_CONTAINER="akis-prod-mcp"
if docker inspect "$MCP_CONTAINER" > /dev/null 2>&1; then
    MCP_STATE=$(docker inspect "$MCP_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    MCP_HEALTH=$(docker inspect "$MCP_CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo "no healthcheck")
    echo "Container: $MCP_CONTAINER"
    echo "  State:   $MCP_STATE"
    echo "  Health:  $MCP_HEALTH"
    if [ "$MCP_STATE" = "running" ]; then
        echo "  MCP Gateway is running"
    else
        echo "  MCP Gateway state: $MCP_STATE"
    fi
else
    echo "  MCP Gateway container not found (GITHUB_TOKEN may be missing from .env)"
fi
echo ""

echo "--- Backend Container Details ---"
BACKEND_CONTAINER="akis-prod-backend"
if docker inspect "$BACKEND_CONTAINER" > /dev/null 2>&1; then
    CONTAINER_IMAGE=$(docker inspect "$BACKEND_CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || echo "unknown")
    CONTAINER_CREATED=$(docker inspect "$BACKEND_CONTAINER" --format '{{.Created}}' 2>/dev/null || echo "unknown")
    CONTAINER_STATE=$(docker inspect "$BACKEND_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    CONTAINER_HEALTH=$(docker inspect "$BACKEND_CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo "no healthcheck")

    echo "Container: $BACKEND_CONTAINER"
    echo "  Image:   $CONTAINER_IMAGE"
    echo "  Created: $CONTAINER_CREATED"
    echo "  State:   $CONTAINER_STATE"
    echo "  Health:  $CONTAINER_HEALTH"

    # Verify the container is running the expected version
    if echo "$CONTAINER_IMAGE" | grep -q "${BACKEND_VERSION}"; then
        echo "  Image tag matches expected commit: ${BACKEND_VERSION}"
    else
        echo "  WARNING: Image tag does not contain expected commit!"
        echo "     Expected: ${BACKEND_VERSION}"
        echo "     Got: $CONTAINER_IMAGE"
    fi
else
    echo "  Backend container not found!"
    DEPLOY_EXIT=1
fi
echo ""

# -----------------------------------------------------------------------------
# Step 8: Verify Caddy health (production canonical stack)
# -----------------------------------------------------------------------------
echo ">>> Step 8: Verifying Caddy health..."
echo "   Production deploy uses canonical /opt/akis/docker-compose.yml + /opt/akis/.env."
echo "   No manual docker-compose.override.yml edits are required for AKIS production."
# Quick check: if Caddy is healthy, routing should be operational
if docker compose ps caddy 2>/dev/null | grep -q "healthy"; then
    echo "Caddy is healthy — production routing should be operational"
else
    echo "Caddy is not yet healthy — production routing may still be starting up"
fi
echo ""

# -----------------------------------------------------------------------------
# Step 9: Clean up pm2 if no longer used
# -----------------------------------------------------------------------------
echo ">>> Step 9: Cleaning up pm2 (if present)..."
if command -v pm2 >/dev/null 2>&1; then
    echo "pm2 found, checking for running processes..."
    PM2_LIST=$(pm2 jlist 2>/dev/null || echo "[]")
    if [ "$PM2_LIST" != "[]" ] && [ -n "$PM2_LIST" ]; then
        echo "pm2 has running processes. Listing them:"
        pm2 list 2>/dev/null || true
        echo ""
        echo "Stopping all pm2 processes..."
        pm2 kill 2>/dev/null || true
        echo "pm2 processes stopped."
    else
        echo "No pm2 processes running."
    fi
    # Remove pm2 startup hook if it exists
    pm2 unstartup 2>/dev/null || true
    echo "pm2 cleanup done."
else
    echo "pm2 not installed, nothing to clean up."
fi
echo ""

# -----------------------------------------------------------------------------
# Step 10: Prune old images
# -----------------------------------------------------------------------------
echo ">>> Step 10: Pruning old images..."
docker image prune -f 2>/dev/null || true
echo ""

# -----------------------------------------------------------------------------
# Final status
# -----------------------------------------------------------------------------
TOTAL_ELAPSED=$(( $(date +%s) - DEPLOY_START ))
TOTAL_MIN=$(( TOTAL_ELAPSED / 60 ))
TOTAL_SEC=$(( TOTAL_ELAPSED % 60 ))

echo "=============================================="
echo "=== Deployment script completed ==="
echo "Target commit: ${BACKEND_VERSION}"
if [ "$IMAGE_EXISTS" = "true" ]; then
    echo "Image source: pre-loaded (docker load)"
elif [ "$PULL_SUCCESS" = "true" ]; then
    echo "Image source: GHCR pull"
else
    echo "Image source: server-side build"
fi
echo "Total time: ${TOTAL_MIN}m ${TOTAL_SEC}s"
echo "Exit code: ${DEPLOY_EXIT}"
if [ "$DEPLOY_EXIT" = "0" ]; then
    echo "Status: SUCCESS"
else
    echo "Status: FAILED"
fi
echo "=============================================="
exit ${DEPLOY_EXIT}
