---
description: Start implementation from an approved PDP doc (writes code + tests, gates before PR)
allowed-tools: [Read, Write, Edit, Bash, Agent, Skill]
argument-hint: <fr-id-or-f-id>
---

Begin (or continue) implementation of a single requirement from the approved PDP package.

`$ARGUMENTS` is the requirement anchor — `FR-3.5`, `NFR-2.1`, or a feature/roadmap ID like `F-01`. Required.

## What to do

1. **Validate input.** If `$ARGUMENTS` is empty, list available anchor IDs (scan `docs/product/01-requirements.md`, `docs/product/02-roadmap.md`, etc.) and stop.
2. **Confirm the source doc is approved.** Read `.claude/state/pdp-progress.json`:
   - For `FR-*` / `NFR-*` → `01-requirements` must be `approved`.
   - For `F-*` → `02-roadmap` must be `approved`.
   - If the gating doc is not `approved`, abort and tell the user to run `/pdp-next <doc>` first. Do NOT bypass.
3. **Locate the requirement spec.** Grep the PDP markdown files for the anchor (e.g. `\bFR-3\.5\b`). Read the surrounding section so the implementer has full context. If the anchor is not found, abort.
4. **Dispatch the `code-implementer` agent** (Agent tool). Pass:
   - the requirement anchor and quoted spec text,
   - relevant CLAUDE.md conventions (test posture, package scoping, env rules),
   - explicit instruction: every commit message must reference the anchor (e.g. `feat(api): add foo (FR-3.5)`).
   The agent owns code, tests, and commits inside `backend/` / `frontend/`.
5. **Run gate-check after every implementer commit.** Invoke the `gate-check` skill (which dispatches the `gate-keeper` agent). It must run typecheck + lint + tests + acceptance + commit-link audit for both packages touched.
6. **Decide based on gate result:**
   - PASS → propose a PR (gh pr create) with title referencing the anchor and a body that quotes the requirement and lists the commits. Do NOT push without user confirmation.
   - FAIL → surface the failing gate verbatim, mark the implementation `blocked` in `.claude/state/orchestrator.json` if that file exists, and stop. Never auto-fix; let the user direct the next step.
7. **Update progress state** (best-effort): if `.claude/state/orchestrator.json` exists, append the anchor + commit SHAs + gate result to its `tasks` / `gates` sections using the atomic tmp+mv pattern. Skip silently if the file is absent.

## Guardrails
- Never commit changes yourself; the `code-implementer` agent commits.
- Never run `--no-verify` on commits; respect the FR-link pre-commit hook.
- Never push to `main`; PR target is `main`, source is whatever feature branch the implementer creates.
- Stay inside `backend/` / `frontend/` / `docs/` (for ADRs). Do not edit `.claude/` from this command — that's Layer B and out of scope here.
