---
description: Run gate-keeper verification on the current branch (typecheck + lint + tests + acceptance + commit-link audit)
allowed-tools: [Read, Bash]
argument-hint: [area]
---

Run the full gate suite and report PASS/FAIL — read-only, no fixes.

`$ARGUMENTS` is one of: `frontend`, `backend`, `both`. Default = `both`.

## What to do

1. Resolve scope from `$ARGUMENTS` (default `both`). Validate; if invalid, print accepted values and stop.
2. Invoke the `gate-check` skill. The skill is the source of truth for the gate definitions; this command just orchestrates and renders.
3. If a `gate-keeper` agent exists under `.claude/agents/`, dispatch it via the Agent tool with the resolved scope. Otherwise run the gates inline using bash:
   - **Backend** (when scope ∈ {backend, both}):
     - `pnpm -C backend typecheck`
     - `pnpm -C backend lint`
     - `pnpm -C backend test` (unit only — fast, gated by `SKIP_MCP_TESTS=true SKIP_DB_TESTS=true`)
   - **Frontend** (when scope ∈ {frontend, both}):
     - `pnpm -C frontend typecheck`
     - `pnpm -C frontend lint`
     - `pnpm -C frontend test`
   - **Acceptance** (always): if `docs/product/04-acceptance.md` exists, scan for unchecked acceptance items linked to the current branch's commits; report which are still open. If the doc is missing, mark this gate as `n/a`.
   - **Commit-link audit** (always): for every commit on the current branch since `main`, check the message contains an FR/NFR/F anchor (regex `\b(FR|NFR|F)-[0-9]+(\.[0-9]+)?\b`). Skip pure-doc / pure-tooling commits (touching only `.claude/` or `docs/` or `*.md`).
4. Render a results matrix:
   ```
   | Gate              | Backend | Frontend |
   |-------------------|---------|----------|
   | typecheck         | ✅       | ✅        |
   | lint              | ✅       | ❌        |
   | tests             | ✅       | ✅        |
   | acceptance        | n/a     | n/a      |
   | commit-link audit | ✅       | ✅        |
   ```
   Show one row per gate, one column per scoped area. Use `n/a` for skipped scopes.
5. Below the matrix, for each FAIL show the first ~30 lines of the failing command's stderr/stdout so the user can diagnose. Do NOT truncate the FR/NFR anchor list — show it in full.
6. Final line: overall verdict. `PASS` if every cell is ✅ or `n/a`; otherwise `FAIL` with the count of failing gates.

## Guardrails
- **NEVER attempt to fix a failing gate.** Reporting only.
- Do not write files.
- Do not modify state JSON (that's the orchestrator's job).
- If a gate's command is missing (e.g. no test script in a package), report it as `n/a` not FAIL.
