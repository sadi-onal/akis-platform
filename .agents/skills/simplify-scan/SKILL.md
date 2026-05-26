---
name: simplify-scan
description: Periodic codebase + docs sweep for stale, duplicate, or off-target content. Use when orchestrator schedules it (every N implementations or weekly), or on user request.
---

# Simplify Scan

Hygiene pass. Surfaces what looks stale, duplicate, dead, unused, or contradicted-by-code, so the user can prune intentionally. Never auto-deletes.

## When to use

- After every ~10 entries in `.Codex/state/implementation-log.jsonl` (orchestrator counts and triggers).
- Weekly cadence (orchestrator may schedule via cron skill if user opts in).
- On explicit user request: "/simplify-scan", "do a sweep", "what's stale?".
- Before freezing a PDP version (catches drift between PDP claims and shipped code).

## Scan categories

1. **Stale docs** — `*.md` last touched > 60 days AND not referenced by any other file's name.
2. **Duplicates / contradictions** — same FR or concept defined in two docs with diverging wording.
3. **Dead code** — exported symbols with zero importers (account for dynamic imports / lazy loading; mark `confidence: low` when uncertain).
4. **Unused dependencies** — `package.json` entries with no `import`/`require` references.
5. **PDP-vs-code drift** — `06-roadmap.md` items already shipped (ought to be `done`), or claims in `05-findings.md` no longer true.

## Output format

`simplifier` agent writes to `.Codex/state/simplifier-findings.md`:

```markdown
# Simplifier Findings — <ISO date>

Total: NN findings (high: A · medium: B · low: C)
Categories: stale-doc D · duplicate E · dead-code F · unused-dep G · pdp-drift H

## Finding 01: <one-line title>
- Category: ...
- Confidence: high | medium | low
- Location: <path>
- Evidence: <grep / git output>
- Suggested action: <delete | merge | reclassify | keep>
- Risk if acted on: <what breaks>
```

## User-confirmation protocol

Main session, when presenting findings:

1. Print the file path and total counts. Don't dump all findings — show the high-confidence ones first, ask the user to expand low-confidence on demand.
2. For each finding the user wants to act on, dispatch the appropriate agent (e.g., `code-implementer` to delete dead code with a proper FR/F-ID; `pdp-writer` to reclassify a roadmap item).
3. Findings the user ignores stay in the file with a `status: dismissed` annotation appended next time the simplifier runs (avoids repeated nagging).

## Anti-patterns

- NEVER let the simplifier delete files. It's report-only. Removal is the user's call, executed by `code-implementer` with an FR/F-ID anchor.
- Don't run the simplifier mid-implementation. Wait for an idle moment between tasks.
- Don't include `node_modules/`, `dist/`, `migrations/`, `.next/`, screenshots, or generated types in the scan. They're noise.
