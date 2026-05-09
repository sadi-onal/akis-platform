---
name: parallel-implementation
description: Dispatch 2+ independent implementation tasks via subagents. Use when the orchestrator identifies parallelizable work AND the user has approved parallelism.
---

# Parallel Implementation

Two-or-more `code-implementer` runs at once, each in its own git worktree, against tasks that share neither files nor product surface. Use sparingly — coordination cost is real.

## When to use

- Orchestrator has decomposed the initiative and finds 2+ tasks that satisfy ALL of:
  - Different file footprints (no overlapping `git diff` surface).
  - Independent FR/F-IDs (one's acceptance criteria don't depend on the other's).
  - No shared schema / shared types touched simultaneously.
- The user has approved parallelism for this initiative. Default is sequential — don't go parallel without explicit OK, because reviewing two PRs at once is harder for the user than one.

## Template

```
Initiative: <name>
Parallel branches:
  ../akis-<tag-1>  branch <tag-1>  task <id-1>  FR-<...>
  ../akis-<tag-2>  branch <tag-2>  task <id-2>  FR-<...>
  (max 3 branches per round; ask the user before exceeding)
```

## Procedure

1. Dispatch `worktree-coordinator` with the list of tags. It creates worktrees, symlinks `.claude/` and `backend/.env`, registers them in state.
2. Per worktree, dispatch one `code-implementer` instance with its scoped FR/F-ID. Run them concurrently as separate Agent invocations.
3. Per `code-implementer` commit, dispatch `gate-keeper` against that worktree. Gates pass before the branch is mergeable.
4. Integration: merge worktrees back into the initiative branch one at a time. After each merge, re-run `gate-keeper` on the integrated state — green-on-each-branch ≠ green-after-merge.
5. After all merged: `worktree-coordinator` tears down the worktrees.

## Conflict handling

- Lock-step merges: never merge branch B before branch A's gate is green on the integrated branch.
- If a textual merge conflict appears, surface it to the user. Don't auto-resolve; the user decides.
- If a semantic conflict appears (clean text merge, broken behavior, gate fails after merge), treat as a blocker and ask: revert one branch, or implement a stitching fix on the integrated branch.

## Hard limits

- No parallelism on the same `frId` — split it into ordered subtasks instead.
- No parallel writes to PDP docs. PDP cycle is strictly serial.
- No more than 3 active worktrees per initiative without re-asking the user.
