# PR #501 — Pre-Merge Audit & Smoke Report

**Date:** 2026-05-02
**Auditor:** Reviewing agent (independent of PR-authoring session)
**PR:** [akis-platform#501](https://github.com/OmerYasirOnal/akis-platform/pull/501)
**Branch:** `worktree-auth-cleanup-staging-removal`
**Goal:** Verify the PR closes the OAuth login loop, the account-isolation audit is sound, and staging removal does not break anything reachable from prod.

> Companion docs in this PR:
> - [AUTH_LOOP_DIAGNOSIS_2026-05-02.md](AUTH_LOOP_DIAGNOSIS_2026-05-02.md) — root-cause analysis (Mode 1 + Mode 2)
> - [AUTH_DEPLOY_RUNBOOK_2026-05-02.md](AUTH_DEPLOY_RUNBOOK_2026-05-02.md) — manual prod steps for Yasir
> - [ACCOUNT_ISOLATION_AUDIT_2026-05-02.md](ACCOUNT_ISOLATION_AUDIT_2026-05-02.md) — every user-scoped route reviewed

## TL;DR

PR #501 is **READY** for Yasir to merge. CI green, local quality gates green, baseline browser smoke confirms staging→apex 301 already works in prod, and the account-isolation audit found no missing checks. The OAuth loop's actual close-out happens **post-deploy** with Yasir at the keyboard (real Google/GitHub grant cannot be driven by an autonomous agent).

| Layer | Status | Evidence |
|---|---|---|
| Backend quality gate (worktree) | green | typecheck + lint + 3382 unit tests + build, exit 0 |
| Frontend quality gate (worktree) | green | typecheck + lint + 740 tests + build, exit 0 |
| CI on PR (GitHub Actions) | green | backend, frontend, backend-gate, frontend-gate, summary all SUCCESS |
| `staging.akisflow.com` → apex 301 | working pre-merge | navigated to staging URL, browser landed on `https://akisflow.com/` |
| Pre-merge ProtectedRoute behavior | working | unauthenticated visit to `/auth/welcome-beta` and `/auth/privacy-consent` bounces to `/login` (the user's reported loop happens **after** OAuth grant, not on direct visit) |
| Live OAuth grant → cookie attach | not verified by agent | requires real user password; deferred to Yasir post-deploy per runbook |
| Two-account isolation (live e2e) | not verified by agent | requires two real authenticated sessions; covered by existing `pipeline-idor-guard` + `jobs-user-isolation` tests in this PR; smoke-test addendum in audit doc covers Yasir's post-deploy capture |

## What was verified locally (worktree)

The PR was checked out as a worktree at `.claude/worktrees/auth-cleanup-staging-removal/`. Both quality gates ran end-to-end against the worktree's actual code, not a stale clone:

```
backend:  typecheck + lint + 3382 unit tests + build  →  exit 0
frontend: typecheck + lint + 52 test files / 740 tests + build  →  exit 0
```

This independently confirms the CI claims. The 3382 unit tests include the new `cookie-domain.test.ts` and `jira-mcp-service.test.ts` introduced by this PR.

## What was verified live on `akisflow.com` (BEFORE merge)

These are baseline captures of prod **before** PR #501 lands. They serve as the comparison surface for the post-deploy smoke Yasir will run.

### Capture 1 — Landing page (still serving the old, false claims)

URL: `https://akisflow.com/`
Title: `AKIS Platformu`

The landing page renders today with the false claims this PR removes:
- "5 dk Ortalama Pipeline Süresi" — unsubstantiated metric
- "100% Test Kapsamı Hedefi" — unsubstantiated
- "Sıfır Yapılandırma Gerekli" — overstated
- "Jira: Spec onayında otomatik Epic ve sub-task oluşturma" — sub-tasks are not actually created
- "BDD / Cucumber: Gherkin feature dosyaları otomatik üretilir" — Trace primarily emits Playwright

Post-merge expectation (per Phase D in the plan): the truthful copy ships, and these strings disappear from `frontend/src/i18n/locales/{en,tr}.json`.

### Capture 2 — `/auth/welcome-beta` direct visit (unauthenticated)

URL after navigation: `https://akisflow.com/login`

Behavior: ProtectedRoute on the welcome-beta route redirects an unauthenticated visitor to `/login`. The login form ("Tekrar hoş geldiniz") renders. **No infinite loop happens here — the loop only manifests after a successful OAuth grant when the cookie does not attach.**

Post-merge expectation: the route no longer exists in `App.tsx`, so direct visit hits the `<Route path="*" element={<Navigate to="/" replace />} />` catch-all and lands on the landing page.

### Capture 3 — `/auth/privacy-consent` direct visit (unauthenticated)

Same as Capture 2 — bounces to `/login`. Same post-merge expectation: catch-all to landing.

### Capture 4 — `staging.akisflow.com` → apex 301

Navigated to `https://staging.akisflow.com`. Browser landed on `https://akisflow.com/` and rendered the apex landing page. **The graceful-degradation 301 redirect already works in prod today** — this PR's `devops/compose/Caddyfile.edge` keeps it.

### Capture 5 — OAuth init endpoint

Attempted to navigate to `https://akisflow.com/auth/oauth/google` to capture the `redirect_uri` parameter the backend sends to Google (Mode 1 verification — does the backend send the apex or `www`?). The browser-automation permission gate denied this navigation, citing OAuth-credential-entry policy.

**Why this matters:** Mode 1 of the diagnosis is the strongest hypothesis (provider console has `www.akisflow.com` instead of apex). It can only be definitively confirmed by reading the Google/GitHub consoles directly, which is on Yasir's runbook checklist.

The backend code at `backend/src/api/auth.oauth.ts:444` constructs the `redirect_uri` from `${config.FRONTEND_URL}/auth/oauth/${provider}/callback`. As long as `FRONTEND_URL=https://akisflow.com` in the live env (no `www`), the backend's outbound URL is correct. Mode 1 only triggers if the **provider console** has the wrong URL.

## What the PR delivers (changed-file inventory)

55 files / 2048 additions / 950 deletions.

**Backend (12 files):**
- `auth.oauth.ts` — callback always redirects to `/chat`; consent gate gone
- `auth.multi-step.ts` — `/update-preferences` endpoint, `UpdatePreferencesSchema`, `needsDataSharingConsent` fields removed
- `auth.invite.ts` — staging fallback URL removed
- `health.ts` — staging example URL removed from OpenAPI schema
- `services/email/templates.ts` — staging fallback URLs replaced with apex
- `services/mcp/adapters/JiraMCPService.ts` — diagnostic warn logs added in `fromOAuth()`
- `agents/trace/TraceAgent.ts` — staging fallback URLs replaced with apex
- 5 unit-test fixture updates
- 2 new unit test files: `cookie-domain.test.ts`, `jira-mcp-service.test.ts`

**Frontend (29 files):**
- `App.tsx` — welcome-beta + privacy-consent routes deleted
- `pages/auth/{WelcomeBeta,PrivacyConsent}.tsx` — deleted
- `pages/auth/{LoginPassword,SignupPassword,SignupVerifyEmail,InviteAccept}.tsx` — `navigate()` calls retargeted to `/chat` or the appropriate next step
- `components/chat/EmptyState.tsx` — in-chat WelcomeWizard mount removed
- `components/onboarding/WelcomeWizard.tsx` — deleted (orphan after EmptyState clean)
- `components/AppShell.tsx` — privacy-consent comment cleaned
- `services/api/auth.ts` — `updatePreferences` client method removed
- `i18n/locales/{en,tr}.json` — landing copy rewritten; staging URLs replaced
- `components/landing/{HeroSection,StatsSection,FeaturesSection}.tsx` — false claims rewritten
- 9 test/spec files updated (mocks cleaned, deleted-route tests dropped)

**Ops/docs (7 files):**
- 4 new docs: diagnosis, runbook, isolation audit, this audit
- `CLAUDE.md` — staging notes updated
- `docs/DEPLOYMENT.md` — staging references cleaned
- `.github/workflows/nightly-smoke.yml` — staging refs scrubbed

**Devops (1 file):**
- `devops/compose/docker-compose.edge.yml` — staging references removed; `Caddyfile.edge` retains the 301

## Risk assessment

| Risk | Likelihood | Mitigation in this PR |
|---|---|---|
| Existing logged-in users with `dataSharingConsent=null` lose consent UI | High but harmless | DB columns kept; no telemetry actually shipped today; documented as accepted trade-off in plan's "Out of Scope" |
| Cookie domain change affects unrelated flows | Low | Local unit test pins the exact cookie attribute set; runbook documents the env-var rollout |
| Staging redirect removal breaks a bookmarked link | Mitigated | The 301 in `Caddyfile.edge` is **kept**; only the docs / examples / fallbacks are cleaned |
| OAuth provider URL still wrong (Mode 1) | Real | Runbook step 2 has Yasir verify each provider console explicitly |
| Two-account chat bleed-through (user's stated worry) | Already covered | Audit confirms layered defense: authPreHandler → ownershipPreHandler → Drizzle WHERE filters; existing `pipeline-idor-guard.test.ts` (25+ assertions) and `jobs-user-isolation.test.ts` (3-real-user integration) pin the behavior |

## Recommendation

**Merge when ready.** The PR is sound. Three things must happen post-merge for the loop fix to take effect end-to-end:

1. `AUTH_COOKIE_DOMAIN=akisflow.com` added to `/opt/akis/prod/.env` (manual, runbook §1)
2. Google + GitHub + Atlassian OAuth callback URLs verified to be apex, not `www` (manual, runbook §2)
3. Live OAuth flow smoke (Yasir at the keyboard, runbook §3) — capture `Set-Cookie` header on `/auth/oauth/google/callback` and `Cookie:` header on the next `/auth/me`

After step 3 succeeds, append the live capture to this report or a fresh `DEPLOY_SMOKE_501_<date>.md` per CLAUDE.md "PR Review + Deploy Smoke Otomasyonu".

## Honest scope of this audit

What this audit is: an independent code-and-state review with as much live verification as the agent's safety boundary permits.

What this audit is **not**: a full live OAuth-flow capture or a two-account chat-isolation drive. Both require credential entry on production, which is outside what an autonomous agent should do unattended. Those final two checks are the user's manual responsibility — captured in the runbook with exact DevTools steps.
