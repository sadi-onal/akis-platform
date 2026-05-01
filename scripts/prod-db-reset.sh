#!/usr/bin/env bash
#
# prod-db-reset.sh
#
# DESTRUCTIVE: Truncate every user-owned table in the production database.
# Schema (drizzle migrations table) is preserved so the app keeps booting.
#
# RUN THIS ON THE OCI VM (or any host where the akis-prod-db container is
# reachable). Locally it does nothing useful — there is no akis-prod-db
# container in dev.
#
# Steps it performs:
#   1. Verifies you really want to do this (typed confirmation).
#   2. Optional: dumps every table's row count to stdout BEFORE truncating
#      so there is a paper trail.
#   3. Issues a single TRUNCATE statement covering every data table with
#      RESTART IDENTITY + CASCADE so foreign keys + sequences reset cleanly.
#   4. Verifies post-truncate row counts (all zero).
#
# After the reset:
#   - All users gone. Every account must re-sign up.
#   - All workflows / pipelines / messages gone.
#   - All OAuth links + integration credentials + API keys gone.
#   - Migration history (drizzle table) preserved → no need to re-run migrations.
#
# Usage:
#   ssh ubuntu@oci-akis-prod
#   cd /opt/akis
#   sudo ./scripts/prod-db-reset.sh
#
set -euo pipefail

CONTAINER="${PROD_DB_CONTAINER:-akis-prod-db}"
DB_USER="${PROD_DB_USER:-postgres}"
DB_NAME="${PROD_DB_NAME:-akis}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

bold "AKIS production database reset"
echo
yellow "Container: ${CONTAINER}"
yellow "Database:  ${DB_NAME}"
yellow "User:      ${DB_USER}"
echo

red "This will delete EVERYTHING in production:"
red "  - All users + email verification tokens"
red "  - All workflows, pipelines, conversation history"
red "  - All OAuth account links (GitHub, Google, Atlassian)"
red "  - All AI keys, integrations, billing records"
red "  - All audit logs"
echo
red "There is no undo."
echo

read -r -p "Type the literal phrase >>RESET PROD<< to continue: " confirm
if [[ "${confirm}" != "RESET PROD" ]]; then
  red "Aborted."
  exit 1
fi
echo

# Tables to truncate. Mirrors backend Drizzle schema (backend/src/db/*.ts +
# backend/src/pipeline/db/*.ts) as of v0.6.5. Excludes only:
#   - drizzle.__drizzle_migrations (migration ledger)
TABLES=$(cat <<'TBL'
agent_activities
agent_configs
agent_triggers
audit_log
billing_notifications
chat_retrieval_anchors
conversation_messages
conversation_threads
crew_messages
crew_runs
crew_tasks
dev_messages
dev_sessions
email_verification_tokens
feedback
integration_credentials
invite_tokens
job_ai_calls
job_artifacts
job_audits
job_comments
job_plans
job_posts
job_sources
job_traces
jobs
knowledge_chunks
knowledge_documents
knowledge_provenance
knowledge_sources
knowledge_tags
matches
oauth_accounts
pipelines
plan_candidate_builds
plan_candidates
plans
portfolios
profiles
proposals
skills
studio_sessions
subscriptions
thread_tasks
thread_trust_snapshots
usage_counters
user_ai_keys
user_billing_overrides
users
webhook_deliveries
workspace_billing_settings
TBL
)

# Comma-separated list for the TRUNCATE statement.
TRUNCATE_LIST=$(echo "$TABLES" | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g')

run_psql() {
  docker exec -i "${CONTAINER}" psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" "$@"
}

bold "Step 1/3 — pre-reset row counts (audit trail)"
run_psql <<SQL
SELECT relname AS table, n_live_tup AS rows
FROM pg_stat_user_tables
WHERE relname IN ('${TABLES//$'\n'/\',\'}')
ORDER BY n_live_tup DESC NULLS LAST, relname;
SQL
echo

bold "Step 2/3 — TRUNCATE"
run_psql <<SQL
BEGIN;
TRUNCATE TABLE ${TRUNCATE_LIST}
  RESTART IDENTITY
  CASCADE;
COMMIT;
SQL
green "TRUNCATE committed."
echo

bold "Step 3/3 — post-reset row counts (should all be zero)"
run_psql <<SQL
SELECT relname AS table, n_live_tup AS rows
FROM pg_stat_user_tables
WHERE relname IN ('${TABLES//$'\n'/\',\'}')
  AND n_live_tup > 0
ORDER BY n_live_tup DESC, relname;
SQL
echo

green "Done. Production database is empty (schema + migration ledger preserved)."
green "Next: visit akisflow.com → sign up fresh."
