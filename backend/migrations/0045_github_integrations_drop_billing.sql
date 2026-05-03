-- Issue: GitHub OAuth dual-flow architecture failure + plan/billing removal.
--
-- Two changes in a single migration since they ship together (PR rebuilds the
-- account-management surface end-to-end):
--
-- 1) GitHub integration is now a standalone concept, separate from social login.
--    `oauth_accounts` keeps its role as the login-provider table; the new
--    `github_integrations` table stores the broader-scoped token used by the
--    pipeline (repo/workflow operations).
--
-- 2) Plan/billing infrastructure (Stripe + tiers + quotas) is removed. The
--    project is graduation-only — there's no real billing — and the previous
--    quota gate in pipeline.routes.ts was the wrong abstraction. Every account
--    is unlimited from now on. Usage tracking still exists at the pipeline-
--    metrics level, just no enforcement.
--
-- Idempotent: each statement guards itself so a partially-applied DB recovers.

-- UP -------------------------------------------------------------------------

-- 1) Create github_integrations table ---------------------------------------

CREATE TABLE IF NOT EXISTS "github_integrations" (
  "user_id"             uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "provider_account_id" text NOT NULL,
  "login"               text NOT NULL,
  "avatar_url"          text,
  "scope"               text NOT NULL,
  "access_token"        text NOT NULL,
  "connected_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_github_integrations_login"
  ON "github_integrations" ("login");

-- 2) Drop billing infrastructure --------------------------------------------

-- CASCADE handles FK chain: subscriptions → plans, etc.
DROP TABLE IF EXISTS "billing_notifications" CASCADE;
DROP TABLE IF EXISTS "user_billing_overrides" CASCADE;
DROP TABLE IF EXISTS "workspace_billing_settings" CASCADE;
DROP TABLE IF EXISTS "usage_counters" CASCADE;
DROP TABLE IF EXISTS "subscriptions" CASCADE;
DROP TABLE IF EXISTS "plans" CASCADE;

DROP TYPE IF EXISTS "subscription_status" CASCADE;
DROP TYPE IF EXISTS "plan_tier" CASCADE;

-- 3) Remove legacy plaintext PAT column -------------------------------------
-- users.github_token was the original (pre-OAuth) GitHub PAT field. With OAuth
-- and now the github_integrations table, it's both unused and a credential
-- liability. github_username + github_avatar_url stay (cached display data).

ALTER TABLE "users" DROP COLUMN IF EXISTS "github_token";

-- DOWN -----------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_github_integrations_login;
-- DROP TABLE IF EXISTS github_integrations;
-- ALTER TABLE users ADD COLUMN github_token text;
-- (Billing tables intentionally not restored — they were removed, not paused.)
