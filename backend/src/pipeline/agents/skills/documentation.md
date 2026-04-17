---
name: documentation
description: README and code comment discipline. Apply when writing project docs or deciding whether to comment code.
agents: scribe, proto
tier: opt-scribe, opt-proto
version: 1
---

# Documentation

## README structure (MVP baseline)

A good project README answers, in order:

1. **What it is** — one sentence, concrete
2. **Why it exists** — the problem it solves
3. **Getting started** — exact commands to run (`npm install && npm run dev`)
4. **Features** — the current capabilities, not roadmap
5. **Tech stack** — one line
6. **Structure** — top-level folders and their purpose, if non-obvious

Turkish project-facing README: sections in Turkish ("Kurulum", "Özellikler", "Teknoloji Yığını"). Code blocks stay in English.

## What a README must NOT do

- List features that do not yet work ("coming soon" is banned)
- Duplicate content that belongs in CHANGELOG or roadmap
- Include decorative ASCII banners or excessive emoji

## Code comments: when and why

Default: **write no comments**. Well-named identifiers already document behavior.

Write a comment only when the WHY is non-obvious:

- A hidden constraint ("must be ≤16 chars because Postgres column limit")
- A subtle invariant ("keep this order — B depends on A's side effect")
- A workaround for a specific bug (reference the bug or PR)
- Behavior that would surprise a future reader

## What never to comment

- Explanations of WHAT the code does (identifier names already say it)
- References to the current task ("added for issue #123") — those belong in commit/PR
- Re-narrating the function signature
- Block separators (`// ─── Section ───`) unless the file convention already uses them

## Documentation lives in git

If a fact rots (dates, callers, issue refs), git history already has it. Don't duplicate in code comments.
