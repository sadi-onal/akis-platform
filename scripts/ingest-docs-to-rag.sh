#!/bin/bash
# =============================================================================
# AKIS RAG Knowledge Base — Bulk Document Ingestion
# =============================================================================
# Reads project documentation files and uploads them to the knowledge API.
# Documents are ingested as "approved" so agents can immediately use them.
#
# Usage:
#   ./scripts/ingest-docs-to-rag.sh --api-url https://akisflow.com --token JWT_TOKEN
#   ./scripts/ingest-docs-to-rag.sh --api-url http://localhost:3000 --token JWT_TOKEN
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

API_URL=""
AUTH_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --token)   AUTH_TOKEN="$2"; shift 2 ;;
    *)         echo "Unknown: $1"; exit 1 ;;
  esac
done

if [ -z "$API_URL" ] || [ -z "$AUTH_TOKEN" ]; then
  echo "Usage: $0 --api-url URL --token JWT_TOKEN"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Files to ingest — core project documentation
DOC_FILES=(
  "CLAUDE.md"
  "docs/AGENTS.md"
  "docs/AGENT_VERIFICATION.md"
  "docs/API_SPEC.md"
  "docs/ARCHITECTURE.md"
  "docs/CONTINUATION_USE_CASES.md"
  "docs/DEPLOYMENT.md"
  "docs/ENV_SETUP.md"
  "docs/KNOWLEDGE_INTEGRITY.md"
  "docs/PIPELINE.md"
  "docs/ROADMAP.md"
  "docs/TESTING.md"
  "docs/UI_DESIGN_SYSTEM.md"
  "docs/USE_CASES.md"
  "docs/architecture/ADR-001-adversarial-review.md"
  "docs/architecture/ADR-002-fix-loop-pattern.md"
  "docs/architecture/ADR-003-holdout-testing.md"
  "docs/architecture/ADR-004-level3-pipeline-architecture.md"
  "docs/architecture/ADR-005-domain-agnostic-verification.md"
  "docs/learnings/CONVENTIONS.md"
  "docs/learnings/CRITIC_LEARNINGS.md"
  "docs/learnings/PIPELINE_LEARNINGS.md"
  "docs/learnings/PROTO_LEARNINGS.md"
  "docs/learnings/SCRIBE_LEARNINGS.md"
  "docs/learnings/TRACE_LEARNINGS.md"
  "docs/plans/AKIS_VISION.md"
  "docs/plans/AKIS_LEVEL3_MASTER_PLAN.md"
  "docs/dogfooding/DOGFOODING_GUIDE.md"
  "docs/deploy/OCI_DEPLOY.md"
  "docs/deploy/OCI_RUNBOOK.md"
)

echo -e "${CYAN}===============================================${NC}"
echo -e "${CYAN}AKIS RAG Knowledge Base — Document Ingestion${NC}"
echo -e "${CYAN}===============================================${NC}"
echo ""
echo "API: $API_URL"
echo "Documents: ${#DOC_FILES[@]} files"
echo ""

SUCCESS=0
SKIPPED=0
FAILED=0

for doc_path in "${DOC_FILES[@]}"; do
  full_path="${PROJECT_DIR}/${doc_path}"

  if [ ! -f "$full_path" ]; then
    echo -e "  ${YELLOW}SKIP${NC} $doc_path (file not found)"
    ((SKIPPED++))
    continue
  fi

  # Read file content
  content=$(cat "$full_path")
  title=$(basename "$doc_path" .md)

  # Escape content for JSON (handle newlines, quotes, backslashes)
  json_content=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$content")

  # Upload to knowledge API
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "${API_URL}/api/knowledge/documents/upload" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"title\": \"${title}\",
      \"content\": ${json_content},
      \"sourcePath\": \"${doc_path}\",
      \"status\": \"approved\",
      \"metadata\": {\"category\": \"project-docs\", \"ingestedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
    }" 2>/dev/null)

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [ "$http_code" = "201" ] || [ "$http_code" = "200" ]; then
    echo -e "  ${GREEN}OK${NC}   $doc_path (HTTP $http_code)"
    ((SUCCESS++))
  else
    echo -e "  ${RED}FAIL${NC} $doc_path (HTTP $http_code)"
    echo "       Response: $(echo "$body" | head -c 200)"
    ((FAILED++))
  fi
done

echo ""
echo -e "${CYAN}===============================================${NC}"
echo -e "Results: ${GREEN}${SUCCESS} uploaded${NC}, ${YELLOW}${SKIPPED} skipped${NC}, ${RED}${FAILED} failed${NC}"
echo -e "${CYAN}===============================================${NC}"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
