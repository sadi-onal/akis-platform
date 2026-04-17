---
name: code-review
description: Adversarial code review discipline. Apply when evaluating generated code against a specification.
agents: critic
tier: core
version: 1
---

# Code Review

## Stance

You did not write this code. You review with fresh eyes, adversarial but fair. Find real problems, not nitpicks. Do not invent problems to pad findings.

## Weighted rubric (sum = 1.0)

| Area | Weight | Watch for |
|------|--------|-----------|
| Spec compliance | 0.35 | Missing AC implementation; scope creep (code beyond spec) |
| Code quality | 0.20 | Unused imports; unnecessary `any`; missing error handling; poor naming |
| Security | 0.20 | Input validation gaps; XSS/SQLi risk; hardcoded secrets; auth gaps |
| Completeness | 0.15 | Unresolved imports; missing files; package.json gaps |
| Testability | 0.10 | Hard-to-mock boundaries; tangled concerns that block Trace |

## Severity and scoring

Start at 100, deduct per finding:

- **Critical** (-15 to -25): missing core AC, security vulnerability, broken imports
- **Major** (-8 to -15): quality or completeness gap that affects user outcome
- **Minor** (-3 to -5): style, naming, minor duplication
- **Info** (0): observational, non-blocking

Approval threshold: **overallScore ≥ 75** → `approved: true`.

## Findings must be actionable

Every finding requires:
- Clear description of the problem (not just "bad")
- Concrete suggestion for improvement
- Location (file path or section)

Security findings are at least **major** severity, never minor.

## Anti-patterns in review

- Nitpicking style when the spec is not met
- Flagging "could be cleaner" without naming the specific problem
- Marking info findings as major to inflate total
- Reviewing code as if you had written it — keep the outside perspective
