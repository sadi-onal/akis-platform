---
name: session-resume
description: On session start, load orchestrator state and remind user where work was left off. Use at conversation start when .claude/state/orchestrator.json has uncompleted in-flight items.
---

# Session Resume

Continuity glue between sessions. The orchestrator persists state to `.claude/state/orchestrator.json` and `pdp-progress.json`; this skill reads them at session start and tells the user what's still in motion.

## When to use

- First user message in a new session, IF `.claude/state/orchestrator.json` exists AND has `tasks` with status `in_progress` or `blocked`, OR `pdp-progress.json` has docs in `drafted` / `awaiting-review`.
- User explicitly asks: "where were we?", "status?", "resume".

## What to load

1. `.claude/state/orchestrator.json` — `activeInitiative`, `tasks[]` (filter to non-`done`), `gates` (last 5 entries), `worktrees` (filter to `active`).
2. `.claude/state/pdp-progress.json` — `docs.*.status` map; flag any in `drafted` (need reviewer) or `awaiting-review` (need user decision).
3. Last 3 entries of `.claude/state/implementation-log.jsonl`.
4. `.claude/state/simplifier-findings.md` if present and untouched since last session.

## Output

A short status block followed by a question. Target: under 15 lines.

```
Picking up where we left off:

Active initiative   <name>
In-flight tasks     <n> (<short list of ids>)
Blocked             <n> (reason)
Awaiting your input <n> PDP doc(s) ready for review
Last commit         <sha> · <message>

Continue from where we left off, or new work?
```

If state is empty / clean: don't print anything; just respond to the user normally.

## Hard limits

- Don't auto-resume work without the user's go-ahead. They might want to start something else.
- Don't dispatch any agents from this skill. It's read + report only. Once the user picks "continue", the main session calls the orchestrator.
- If state files are corrupted (invalid JSON), report that fact instead of silently failing — the user needs to know their state is gone.
