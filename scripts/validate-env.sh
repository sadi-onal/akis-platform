#!/bin/bash
# validate-env.sh — Check required environment variables before starting AKIS backend
# Usage: ./scripts/validate-env.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

errors=0
warnings=0

check_required() {
  local var_name=$1
  local description=$2
  if [ -z "${!var_name}" ]; then
    echo -e "${RED}[ERROR]${NC} $var_name is not set — $description"
    errors=$((errors + 1))
  else
    echo -e "${GREEN}[OK]${NC}    $var_name"
  fi
}

check_optional() {
  local var_name=$1
  local description=$2
  if [ -z "${!var_name}" ]; then
    echo -e "${YELLOW}[WARN]${NC}  $var_name is not set — $description"
    warnings=$((warnings + 1))
  else
    echo -e "${GREEN}[OK]${NC}    $var_name"
  fi
}

echo "=== AKIS Platform Environment Validation ==="
echo ""

echo "--- Required ---"
check_required "DATABASE_URL" "PostgreSQL connection string"
check_required "AUTH_JWT_SECRET" "JWT signing secret (min 32 chars)"
check_required "AI_KEY_ENCRYPTION_KEY" "AES-256 key for encrypting user secrets"

echo ""
echo "--- AI Provider ---"
check_optional "ANTHROPIC_API_KEY" "Default Anthropic API key for pipeline"
check_optional "AI_API_KEY" "Alternative AI API key"

echo ""
echo "--- GitHub ---"
check_optional "GITHUB_TOKEN" "Platform GitHub token for pipeline operations"
check_optional "GITHUB_OAUTH_CLIENT_ID" "GitHub OAuth app client ID"
check_optional "GITHUB_OAUTH_CLIENT_SECRET" "GitHub OAuth app client secret"

echo ""
echo "--- Google OAuth ---"
check_optional "GOOGLE_OAUTH_CLIENT_ID" "Google OAuth client ID"
check_optional "GOOGLE_OAUTH_CLIENT_SECRET" "Google OAuth client secret"

echo ""
echo "--- Email ---"
check_optional "RESEND_API_KEY" "Resend API key for email delivery"

echo ""
echo "--- Deployment ---"
check_optional "FRONTEND_URL" "Frontend URL for OAuth callbacks"
check_optional "BACKEND_URL" "Backend URL"
check_optional "CORS_ORIGINS" "Allowed CORS origins"

echo ""
echo "=== Result: $errors error(s), $warnings warning(s) ==="

if [ $errors -gt 0 ]; then
  echo -e "${RED}Environment validation FAILED. Fix required variables above.${NC}"
  exit 1
fi

echo -e "${GREEN}Environment validation passed.${NC}"
