---
name: gate-check
description: Run gate-keeper on an implementation before declaring done. Use after every code-implementer commit, before opening PR.
---

# Gate Check

Single source of "is this implementation actually done?". Wraps the `gate-keeper` agent with a fixed gate matrix and clear pass/fail rules.

## When to use

- Immediately after every `code-implementer` commit (orchestrator does this automatically — reaffirm here for clarity).
- Before any PR creation (`gh pr create`) — no green gate, no PR.
- After a worktree merge into the integration branch (parallel-implementation flow).

## Gate matrix

| # | Gate | Pass condition |
|---|------|----------------|
| 1 | Backend typecheck | `pnpm -C backend typecheck` exit 0 (skip if backend untouched) |
| 2 | Backend lint | `pnpm -C backend lint` exit 0 (skip if backend untouched) |
| 3 | Backend tests | `pnpm -C backend test` exit 0 (unit-only by default) |
| 4 | Frontend typecheck | `pnpm -C frontend typecheck` exit 0 (skip if frontend untouched) |
| 5 | Frontend lint | `pnpm -C frontend lint` exit 0 (skip if frontend untouched) |
| 6 | Frontend tests | `pnpm -C frontend test` exit 0 (Vitest --run) |
| 7 | FR-link | Commit message contains the FR-ID / F-ID |
| 8 | Acceptance criteria | Every AC bullet for the FR is `met` (or explicitly `untestable-yet`) |
| 9 | Scope discipline | `git show --stat HEAD` only touches files implied by the FR |

E2E (`pnpm -C frontend test:e2e`) is opt-in — only when the FR is UI-flow scoped. Document the choice in the gate report.

## Decision rules

- All gates `pass` or `skip` → green. Implementation is done; orchestrator may proceed.
- Any gate `fail` → red. Mark the originating task `blocked`. Surface failing gate's last 20 lines verbatim to the user. Do NOT open a PR.
- `untestable-yet` is allowed (e.g., real Stripe webhook, prod-only path). User decides whether it counts as done for this round.

## What gate-check is NOT

- Not an excuse for skipping local verification — `code-implementer` still runs typecheck/lint/test before committing. Gate-check re-runs them as a guard, not a substitute.
- Not a code review. It catches mechanical regressions, not design issues. Use `code-review` skill or a human reviewer for that.
- Not a release gate. Production deploy has its own checks (see `docs/ops/`); gate-check is per-implementation, not per-deploy.
