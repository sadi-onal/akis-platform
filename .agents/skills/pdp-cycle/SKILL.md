---
name: pdp-cycle
description: One PDP document's full lifecycle — write → self-review → commit → user review → approve. Use when starting any of the 7 PDP files (00-README, 01-requirements, 02-ux, 03-architecture, 04-quality, 05-findings, 06-roadmap).
---

# PDP Cycle (per doc)

The PDP set is built one doc at a time. Each doc passes through the same 7 steps before moving on. Don't skip steps — the whole point of the structure is that a tired drafter and an over-eager reviewer both have a guard rail.

## Protocol

- [ ] **1. Confirm preconditions.** The previous doc in numerical order is `approved` (check `.Codex/state/pdp-progress.json`). Exception: `00-README.md` and `05-findings.md` can be drafted out of order — `00` is umbrella, `05` is gap analysis and benefits from late-cycle context. The orchestrator confirms or asks the user.
- [ ] **2. Dispatch `pdp-writer`.** It reads `docs/THESIS_FOCUS.md`, `docs/PRODUCT_DIRECTION.md`, `docs/AKIS_VISION.md`, plus any already-drafted PDP docs. It writes the new file under `docs/product/`, commits with `docs(pdp): NN-<name> — <summary>`, and updates state to `drafted`.
- [ ] **3. Dispatch `pdp-reviewer`.** It re-reads the committed doc and writes structured findings into `pdp-progress.json` under `docs.<docId>.findings[]`. Categories: placeholder, contradiction, ambiguity, scope-leak, missing-ac, id, xref. Doc status moves to `awaiting-review`.
- [ ] **4. Surface to user.** Main session prints: doc path, commit SHA, finding count by severity (`blocker / warning / nit`), and the verbatim list of `blocker`-level findings. Asks the user one of: approve as-is, accept-with-fixes (writer makes fixes in a follow-up commit), reject (writer rewrites).
- [ ] **5. (Conditional) Revision loop.** If user picks accept-with-fixes or reject, dispatch `pdp-writer` again with the user's instructions plus the reviewer's findings. New commit, status flips back to `drafted`, then `pdp-reviewer` re-runs. Loop until user approves or explicitly skips a finding.
- [ ] **6. Mark approved.** Main session updates `.Codex/state/pdp-progress.json#docs.<docId>.status` to `approved`, records `approved_at` timestamp, and the user's approval note (verbatim, even if just "ok").
- [ ] **7. Hand back to orchestrator.** Orchestrator decides next doc or pauses initiative. If 7/7 approved, the PDP is "frozen" (further changes need a new PDP-revision initiative, not silent edits).

## State schema (pdp-progress.json)

```json
{
  "version": 1,
  "docs": {
    "01-requirements": {
      "status": "pending | drafted | awaiting-review | approved",
      "commit": "<sha or null>",
      "drafter": "pdp-writer",
      "drafted_at": "ISO8601",
      "reviewer": "pdp-reviewer",
      "reviewed_at": "ISO8601",
      "findings": [],
      "approved_at": null,
      "approval_note": null
    }
  }
}
```

## Anti-patterns

- Don't dispatch `pdp-writer` and `pdp-reviewer` in parallel for the same doc — review needs the committed file.
- Don't approve a doc while it has `blocker`-severity findings unless the user explicitly waives them with reasoning recorded in `approval_note`.
- Don't refactor IDs across docs mid-cycle. New IDs append; existing IDs stay.
