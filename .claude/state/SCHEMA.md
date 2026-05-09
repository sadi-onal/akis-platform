# State file schemas

The `.claude/state/` directory holds **persistent tooling state** for AKIS development.
These files survive Claude Code sessions and act as the "memory" that lets the
`session-resume` skill pick up where the previous session left off.

There are four files, each with a different shape and access pattern:

| File | Format | Mutated by | Read by |
| --- | --- | --- | --- |
| `orchestrator.json` | JSON | `orchestrator` agent, `code-implementer` (writes `gates`) | `orchestrator`, `session-resume` skill, `/status` command |
| `pdp-progress.json` | JSON | `pdp-writer`, `pdp-reviewer` agents | `orchestrator`, `/pdp-next` command, `session-resume` |
| `implementation-log.jsonl` | JSONL (append-only) | `code-implementer`, `gate-keeper` | `orchestrator`, `/status`, `simplifier` |
| `simplifier-findings.md` | Markdown | `simplifier` agent (append) + you (triage) | everyone — it is a dialogue file |

JSON files are pretty-printed with 2-space indent. JSONL has one object per line, no commas, no enclosing array. Markdown is human-curated.

---

## `orchestrator.json`

The single source of truth for "what is the orchestrator currently working on."

```json
{
  "version": "1.0",
  "currentInitiative": {
    "id": "INIT-0001",
    "title": "PDP cycle — finish 02..06",
    "startedAt": "2026-05-09T18:00:00Z",
    "status": "in_progress"
  },
  "inFlightTasks": [
    {
      "id": "TSK-0042",
      "title": "Draft 02-ux",
      "owner": "pdp-writer",
      "status": "in_progress",
      "createdAt": "2026-05-09T18:00:00Z",
      "updatedAt": "2026-05-10T00:00:00Z",
      "blockedBy": [],
      "parentDocId": "02-ux"
    }
  ],
  "worktrees": [
    {
      "name": "wt-pdp-02",
      "path": "../akis-platform-wt-pdp-02",
      "branch": "docs/pdp-02-ux",
      "createdAt": "2026-05-09T18:00:00Z",
      "parentTaskId": "TSK-0042",
      "status": "active"
    }
  ],
  "gates": {
    "IMPL-F01-2026-05-10": {
      "implId": "IMPL-F01-2026-05-10",
      "ranAt": "2026-05-10T03:14:00Z",
      "results": {
        "typecheck": "PASS",
        "lint": "PASS",
        "frontendTest": "PASS",
        "backendTest": "PASS",
        "acceptance": "PASS",
        "frLink": "PASS"
      },
      "overall": "PASS"
    }
  },
  "lastUpdated": "2026-05-10T00:00:00Z"
}
```

Allowed enum values: `currentInitiative.status` ∈ `planning | in_progress | paused | done`. `inFlightTasks[].owner` is any agent name from `.claude/agents/`. `worktrees[].status` ∈ `active | merged | cleaned`. Gate results are tri-state strings `PASS | FAIL | SKIP` and `overall` ∈ `PASS | FAIL | PARTIAL`.

## `pdp-progress.json`

Per-document state for the seven PDP files (`docs/product/00-README` … `06-roadmap`). Each entry tracks the doc lifecycle: not_started → drafting → awaiting_review → approved (or revising back to drafting after review).

```json
{
  "documents": {
    "02-ux": {
      "status": "awaiting_review",
      "startedAt": "2026-05-09T18:00:00Z",
      "draftedAt": "2026-05-10T02:00:00Z",
      "revisionCount": 0,
      "pendingReview": {
        "findings": [
          { "severity": "blocking", "category": "FR-link", "message": "Section 4 has no FR reference", "location": "L120-L142" }
        ]
      }
    }
  }
}
```

`status` ∈ `not_started | drafting | awaiting_review | approved | revising`. `revisionCount` increments each time `pdp-reviewer` returns blocking findings.

## `implementation-log.jsonl`

One JSON object per line. Append-only — never edit prior lines, only add new ones at the bottom. Used to reconstruct the implementation history without re-running gates.

```jsonl
{"ts":"2026-05-10T03:14:00Z","implId":"IMPL-F01-2026-05-10","frId":"FR-12","commitSha":"a1b2c3d","gateResults":{"typecheck":"PASS","lint":"PASS","frontendTest":"PASS","backendTest":"PASS","acceptance":"PASS","frLink":"PASS"},"notes":"first pass, no flake"}
```

The `gate-keeper` skill writes one line per gate run; the `code-implementer` writes one line per commit.

## `simplifier-findings.md`

Human-readable Markdown with checkboxes. See the file's own header for the full dialogue convention. The simplifier **appends** findings under the right H2 section; you mark them `[x]` (acted) or `[~]` (rejected) in place.

---

## Backups & merge conflicts

JSON state files are line-stable enough to survive most git merges. If you hit a conflict, prefer **theirs + your additions appended** rather than dropping either side — these files are accumulative.
