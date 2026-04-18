# Prod Smoke — 2026-04-17 bug-fix wave

This directory contains Playwright smoke tests that verify the fixes shipped
in PRs **#399–#410** once they are merged and deployed to
[akisflow.com](https://akisflow.com).

## Files

| Spec | PR / Bug | What it verifies |
| --- | --- | --- |
| `prod-smoke-auth.spec.ts` | #399 / BUG-01 | GitHub OAuth token is visible to both `/api/github/status` and `/api/integrations/github/status`; no "Profilinizi tamamlayın" banner; `/engineer` does not say "GitHub bağlı değil". |
| `prod-smoke-usage-admin.spec.ts` | #401 / BUG-02, BUG-03 | Admin plan tab shows ∞ everywhere, no progress bars; usage tab shows `Sinirsiz` badge + ∞ remaining. |
| `prod-smoke-iteration.spec.ts` | #400 / BUG-08 | Follow-up prompt in a completed chat posts to `/api/pipelines/:id/message`, URL chat id unchanged, sidebar has 1 entry. |
| `prod-smoke-image-ack.spec.ts` | #403 / BUG-09 | After PNG upload + prompt, Scribe's first reply contains `görsel` or `resim`. |
| `prod-smoke-ui-polish.spec.ts` | #384, #387, #391, #392, #386, #406, #410 | i18n labels (`Bütünlük`, `Eşzamanlı Pipeline`), chat-input min-height ≥ 72px, Konsol tab hidden by default, `?debug=1` reveals it, PlanCard summary ≥ 13px. |
| `prod-smoke-engineer.spec.ts` | #395 / BUG-15 | Fresh localStorage shows intro modal; "Başla" dismisses; reload does not re-show. |

## Running

### Against prod (`akisflow.com`)

```bash
PLAYWRIGHT_BASE_URL=https://akisflow.com \
  pnpm -C frontend exec playwright test --grep @prod
```

Or filtered by tag:

```bash
pnpm -C frontend exec playwright test --grep @smoke
```

### Against a local dev server

```bash
pnpm -C frontend dev        # terminal 1
pnpm -C frontend exec playwright test tests/e2e/prod-smoke   # terminal 2
```

## Environment variables

Several specs skip gracefully unless credentials are supplied. They never
commit secrets — all values come from the environment.

| Var | Used by | Purpose |
| --- | --- | --- |
| `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` | auth, iteration, image-ack, engineer | Real user session for end-to-end checks. Without them, specs stub the API or skip the test. |
| `TEST_ADMIN_EMAIL` / `TEST_ADMIN_PASSWORD` | usage-admin | Real admin session; required for true live verification of admin-unlimited. |
| `PROD_SMOKE_RUN_LIVE_PIPELINE` | image-ack | Opt-in (`=true`) to actually run a Scribe pipeline against prod. Costs real LLM tokens; off by default. |
| `PLAYWRIGHT_BASE_URL` | all | Override the base URL (defaults to `http://127.0.0.1:5173`). |

## Design notes

- **Stub-first.** Every spec can run without live credentials by stubbing the
  minimum set of endpoints. This lets CI run them against any environment —
  the stubs are coarse but they exercise the UI contract.
- **i18n imports.** Where a label must be verbatim (`Bütünlük`,
  `Eşzamanlı Pipeline`), we import the string from
  `frontend/src/i18n/locales/tr.json` so future i18n rewrites break the test
  suite instead of silently drifting.
- **Tags.** Every `describe` / `test` is tagged `@prod @smoke`. Use
  `--grep @prod` to run the full suite; use narrower filters
  (e.g. `--grep "BUG-08"`) to debug a specific regression.
- **No destructive actions against prod.** We do not trigger live pipeline
  runs unless `PROD_SMOKE_RUN_LIVE_PIPELINE=true` is explicitly set.
