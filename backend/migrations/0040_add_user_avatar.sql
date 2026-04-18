-- Add avatarUrl column to users for user-uploaded profile pictures.
-- Issue #385 / BUG-05.
--
-- Kept separate from github_avatar_url (set 0035) so we don't overwrite the
-- OAuth-cached avatar when a user uploads their own. The frontend renders
-- in priority: user-uploaded > github-cached > initials.
--
-- MVP stores data URL (base64-encoded image) inline. Fine for <=1MB images
-- (our client-side cap) + demo-scale user counts. OCI Object Storage
-- migration tracked separately — only the column name stays put.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url text;

-- No index needed — avatar_url is only read alongside the user row.
