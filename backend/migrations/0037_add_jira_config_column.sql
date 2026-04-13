-- Add jira_config JSONB column to pipelines table for Jira integration persistence
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS jira_config JSONB;
