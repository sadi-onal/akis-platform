---
name: worktree-coordinator
description: Manages parallel work via git worktrees. Creates worktrees with naming ../akis-<short-tag>, symlinks shared dotfiles, registers them in state, and cleans up after merge.
tools: Bash, Read
---

# Worktree Coordinator

Parallelism enabler. Invoked by the orchestrator after the user has explicitly approved running 2+ tasks in parallel. Reads the `superpowers:using-git-worktrees` skill for protocol; this file just lays out the AKIS-specific conventions.

## Naming

- Path: `../akis-<short-tag>` (one level up from repo root). Examples: `../akis-fr-chat-3`, `../akis-pdp-fix-04`. Short, lowercase, hyphenated.
- Branch: same `<short-tag>` prefix to make `git branch -a` readable.

## Setup procedure (per worktree)

1. `git worktree add -b <branch-name> ../akis-<short-tag> <base>` — base is usually current HEAD.
2. Symlink shared assets so each worktree feels like a complete checkout:
   - `.claude/` → symlink (so all agents/skills/state stay shared and edits in one worktree are seen everywhere)
   - `backend/.env` → symlink (single source of secrets — the user has one valid env, don't fork it)
   - `.env`, `.env.local` at root if present → symlink
   - `node_modules/` → DO NOT symlink. Each worktree should `pnpm -C backend install` / `pnpm -C frontend install` independently to avoid Vite/tsx caching weirdness.
3. Append to `.claude/state/orchestrator.json#worktrees`:
   ```json
   { "path": "../akis-<short-tag>", "branch": "<branch-name>", "task": "<taskId>", "createdAt": "ISO8601", "status": "active" }
   ```

## Teardown procedure

After the worktree's branch has been merged (or abandoned with user approval):

1. Confirm clean: `git -C ../akis-<short-tag> status --porcelain` returns empty.
2. `git worktree remove ../akis-<short-tag>` (use `--force` only if the user explicitly OKs).
3. `git branch -d <branch-name>` for merged branches; `-D` only with explicit user approval.
4. Mark `status: "removed"` in state JSON; don't drop the entry — it's audit trail.

## Hard limits

- Never create more than 3 worktrees in one initiative without re-asking the user. They're cheap on disk but expensive on cognitive load.
- Never create a worktree based on `main` or `production` without checking with the user — base on the current feature branch unless told otherwise.
- Never run `worktree remove --force` on a worktree with uncommitted changes. Surface the dirty state and let the user decide.
