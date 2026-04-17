-- Repair pipelines table schema drift.
--
-- Some environments (including the live prod DB as of 2026-04-17) were
-- repaired manually by c5d0ea1 "fix(migrations): repair journal for
-- 0027-0038, add pipelines table" in a way that left the pipelines table
-- created without a couple of columns the application code reads.
-- Without these columns, `GET /api/pipelines` fails with PG 42703
-- `column "trace_enabled" does not exist` (and then `repo_context`).
--
-- This migration is idempotent: ADD COLUMN IF NOT EXISTS is a no-op on
-- environments where the columns are already present (e.g. fresh DBs
-- created from 0035b in a later image).

ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "trace_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "repo_context" jsonb;
