---
description: Dispatch parallel subagents for independent tasks (uses worktrees if scope warrants)
allowed-tools: [Agent, Bash, Read]
argument-hint: <brief-1> | <brief-2> [| <brief-3>]
---

Run 2 or 3 independent task briefs in parallel via subagents (with git worktrees when scope warrants).

`$ARGUMENTS` is a `|`-separated list of natural-language task briefs. Examples:
- `add /healthz endpoint | add CSS lint rule for unused tokens`
- `bump frontend axios | bump backend pino | regenerate openapi types`

## What to do

1. **Split** `$ARGUMENTS` on `|`, trim whitespace, drop empty entries. Reject if count < 2 or > 3 — explain the constraint and stop.
2. **Independence audit.** For each brief, identify the likely files / packages it touches. If two briefs collide on the same file, package, or migration sequence, abort with a clear message: "Brief #N and Brief #M both touch X; run them sequentially instead." Do not soldier through colliding briefs.
3. **Decide on worktrees.** If briefs touch different packages (`backend/` vs `frontend/`) or independent subdirs, prefer worktrees so each subagent has an isolated workspace. If everything is in `.claude/` or pure docs, plain in-place dispatch is fine.
4. **Invoke the `parallel-implementation` skill** with the resolved brief list and worktree decision. The skill knows how to set up worktrees (or delegate to a `worktree-coordinator` agent if one exists) and which agent to spawn per brief (typically `code-implementer`, possibly `pdp-writer` for doc-only briefs).
5. **Dispatch agents in parallel.** Use the Agent tool with one call per brief, all in the same response so the runtime executes them concurrently. Pass each agent: its brief, its scope, its workspace path (if worktree), and the standing rule that every commit must include an FR/NFR/F anchor or be doc-only.
6. **Integrate.** After all agents return:
   - Verify each subagent's branch passes `gate-check` (dispatch `gate-keeper` per branch if available).
   - Summarize per brief: status, branch/worktree path, commits, gate result.
   - Surface conflicts or gate failures verbatim. Do not auto-merge worktrees back; ask the user.
7. **Cleanup is the user's call.** Don't tear down worktrees automatically — the user may want to inspect them.

## Guardrails
- Never run more than 3 parallel briefs (cognitive ceiling for the user reviewing results).
- Never dispatch parallel agents on the same files / packages.
- If a brief is doc-only, it can run in-place (no worktree) but still goes through its own subagent so the work is observable.
- Do not commit or push from this command; subagents own their own commits.
