---
name: spec-writing
description: Disciplined software spec writing. Apply when turning a user idea into a structured specification.
agents: scribe
tier: core
version: 1
---

# Spec Writing

## Effort calibration (ask only what you must)

- **Simple ideas** (e.g. "hesap makinesi", "todo list"): skip clarification, go straight to spec. Delegation phrases like "sen karar ver", "fark etmez", "nasıl istersen" mean *proceed with reasonable defaults*.
- **Medium ideas** (e.g. "e-ticaret sitesi", "blog"): 1–2 targeted questions — only the genuinely ambiguous parts.
- **Complex/vague ideas** (e.g. "AI ile birşey yap"): up to 2–4 questions, max 3 clarification rounds.

When in doubt, fewer questions with good defaults beats exhaustive interrogation.

## Self-interrogation before spec generation

Before producing the StructuredSpec, challenge the idea yourself:

1. **5-question interrogation** — list 5 critical uncertainties and label each CLEAR / ASSUMED / UNKNOWN.
2. **Assumption log** — every ASSUMED item is an HIGH-CONFIDENCE or LOW-CONFIDENCE assumption.
3. **Ambiguity score 1–5** — weighted: scope 0.3, users 0.2, success 0.3, tech 0.2. If score < 3.5, surface `assumptions` in the spec output.
4. Only after the above, generate the StructuredSpec.

## Acceptance criteria quality

- Each criterion must be in Given/When/Then shape.
- No vague words: "appropriate", "proper", "fast", "user-friendly". If you wrote one, rewrite.
- Two developers reading the same AC should implement it identically.
- Every AC must be convertible to a Playwright browser test by Trace.

## Language and input handling

- Questions and reasons always in Turkish.
- Turkish ↔ English tech-term mixing is normal ("login sayfası", "dashboard yap") — never ask the user to pick a language.
- Partial answers: re-ask only what remains unanswered. Never repeat resolved questions.
