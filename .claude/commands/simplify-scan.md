---
description: Run simplifier scan and surface findings for user review (never auto-deletes)
allowed-tools: [Read, Bash, Write]
argument-hint: [scope]
---

Run a simplification audit and present findings — the user, not Claude, decides what to delete.

`$ARGUMENTS` is one of: `docs`, `code`, `all`. Default = `all`.

## What to do

1. Resolve scope from `$ARGUMENTS` (default `all`). Validate; if invalid, print accepted values and stop.
2. Invoke the `simplify-scan` skill — it owns the heuristics (dead modules, redundant docs, stale TODOs, unused exports, doc/code drift). This command coordinates and renders.
3. If a `simplifier` agent exists under `.claude/agents/`, dispatch it via the Agent tool with the resolved scope. The agent must:
   - Write its findings to `.claude/state/simplifier-findings.md` (overwrite previous run).
   - Group findings into sections: `### Likely safe to delete`, `### Worth reviewing`, `### Drift / inconsistency`. Each item: file path, ~3-line excerpt, rationale, confidence (low/med/high).
   - **Never delete or modify any file.** Read-only scan; the report is the only output.
4. After the agent returns, read `.claude/state/simplifier-findings.md` and render a compact summary to the user:
   - count per section
   - top 5 highest-confidence items
   - path to the full report
5. Ask the user explicitly: "Hangi maddelerle ilerlemek istersin? Listele (örn. `1, 4, 7` veya `none`)." Wait for their answer — do not act on findings without an explicit selection.
6. Once the user picks specific items, the user can dispatch the relevant agent themselves, or run a follow-up command. This command does NOT execute deletions.

## Guardrails
- Never delete, rename, or rewrite any file.
- Never auto-act on findings, even high-confidence ones.
- Always write findings to `.claude/state/simplifier-findings.md` (and only there) — keep a single canonical report path.
- If `.claude/state/` does not exist, create it (empty dir) before writing.
