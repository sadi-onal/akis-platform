---
description: Show PDP package progress (drafted / awaiting review / approved per file)
allowed-tools: [Read, Bash]
argument-hint:
---

Render a snapshot of the Product Definition Package (PDP) writing progress.

## What to do

1. Read `.claude/state/pdp-progress.json`. If it does not exist, report "No PDP progress recorded yet — run `/pdp-next` to start the first doc." and stop.
2. Parse the JSON. Expected shape:
   ```json
   {
     "version": 1,
     "docs": [
       { "id": "00-umbrella", "path": "docs/product/00-README.md", "status": "approved", "lastAction": "2026-05-08T..." },
       { "id": "01-requirements", "path": "docs/product/01-requirements.md", "status": "approved", "lastAction": "..." },
       { "id": "02-roadmap", "path": "...", "status": "drafted", "lastAction": "..." },
       { "id": "03-architecture", "path": "...", "status": "not_started", "lastAction": null },
       ...
     ],
     "lastUpdated": "..."
   }
   ```
3. Render a Markdown table:
   ```
   | # | Doc | Path | Status | Last action |
   |---|-----|------|--------|-------------|
   ```
   Map status → emoji+label:
   - `not_started` → "⏳ Henüz başlanmadı"
   - `drafted` → "✍️ Taslak"
   - `awaiting_review` → "👀 İnceleme bekliyor"
   - `approved` → "✅ Onaylandı"
   - `revising` → "🔁 Revize ediliyor"
4. Below the table show counts (`X / 7 approved`, `Y drafted`, `Z awaiting review`) and `lastUpdated`.
5. If a `progress-tracker` agent exists under `.claude/agents/`, mention at the end: "For deeper drill-down, dispatch the `progress-tracker` agent." Otherwise skip that note.
6. Do NOT modify any files. This is a read-only command.

If `.claude/state/pdp-progress.json` is malformed, print the parse error and the raw contents so the user can fix it manually.
