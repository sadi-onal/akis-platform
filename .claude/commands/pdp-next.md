---
description: Start writing the next PDP doc (or revise current one based on user feedback)
allowed-tools: [Read, Write, Edit, Bash, Skill]
argument-hint: [doc-id]
---

Drive the PDP (Product Definition Package) write/review loop forward by one step.

`$ARGUMENTS` may be a specific doc-id (e.g. `03-architecture`, `05-findings`) or empty (default = next unstarted doc).

## What to do

1. Read `.claude/state/pdp-progress.json`. If missing, initialise it with the canonical 7-doc list (00-umbrella, 01-requirements, 02-roadmap, 03-architecture, 04-acceptance, 05-findings, 06-glossary) all `not_started`, then continue.
2. Resolve the target doc:
   - If `$ARGUMENTS` is non-empty → use that doc-id. Validate it exists in the progress JSON; if not, print available IDs and stop.
   - If `$ARGUMENTS` is empty → pick the first doc whose status is `not_started`. If all are at least `drafted`, pick the first one whose status is `revising` or `awaiting_review` for follow-up. If everything is `approved`, congratulate and stop.
3. Honor the **per-doc approval gate**: never advance to doc N+1 while doc N is not `approved`. If the user asks for a later doc while an earlier one is still in flight, warn and confirm before proceeding.
4. Invoke the `pdp-cycle` skill with the resolved doc-id and current progress state. The skill knows the templates and writing protocol.
5. If the skill needs a writer (status is `not_started` or `revising`) and a `pdp-writer` subagent exists under `.claude/agents/`, dispatch it via the Agent tool with the doc-id and any prior reviewer feedback. The writer is responsible for producing/updating `docs/product/<doc-id>.md` and committing it (commit-link audit handled by hooks/gates, not this command).
6. After the writer returns, update `.claude/state/pdp-progress.json` (use the atomic tmp+mv pattern). Mark status as appropriate:
   - first draft → `drafted`
   - sent to reviewer → `awaiting_review`
   - reviewer signed off → `approved`
7. Surface a tight summary to the user: which doc, new status, what's next, anything blocking. If the doc is still in `awaiting_review`, remind the user to read it and reply with `Approve` or `Changes: ...`.

## Guardrails
- Do not touch backend/, frontend/, or any product code.
- Do not start doc N+1 if doc N is still `drafted` / `awaiting_review` / `revising` unless the user explicitly says "skip ahead".
- The `pdp-writer` agent is the only one that should write files under `docs/product/`. Never write the doc yourself.
