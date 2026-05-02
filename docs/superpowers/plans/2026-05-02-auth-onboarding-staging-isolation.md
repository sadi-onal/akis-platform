# AKIS Auth Fix + Onboarding Cleanup + Staging Removal + Account Isolation — Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **On approval:** copy this plan to `docs/superpowers/plans/2026-05-02-auth-onboarding-staging-isolation.md` (the canonical location per `superpowers:writing-plans`), create an isolated worktree (`superpowers:using-git-worktrees`), and execute autonomously.

## Context

**The user (Yasir) reports five interlocking problems on `akisflow.com` that all need to be fixed in this session, plus an explicit account-isolation audit:**

1. **OAuth login is broken in prod.** Google/GitHub OAuth completes on the provider side, the backend issues `Set-Cookie: akis_sid=...` and 302 redirects, but the user ends up bounced back to `/login` in an infinite loop. The plan's earlier hypothesis (cookie domain mismatch alone) is **unverified**. The real cause may also include the OAuth provider callback URL being configured for `www.akisflow.com` while Caddy issues a `www → apex` 301 that drops the `Set-Cookie` header. Phase 0 diagnoses the actual root cause before applying fixes.

   - **Backend** (`backend/src/api/auth.oauth.ts:655-674`): after setting the session cookie, the callback conditionally redirects to `/auth/privacy-consent` (when `dataSharingConsent === null`) or `/auth/welcome-beta` (when `hasSeenBetaWelcome === false`). For every brand-new OAuth user this is the consent path.
   - **Frontend** (`frontend/src/App.tsx:90-93`): both `/auth/welcome-beta` and `/auth/privacy-consent` are mounted under `<ProtectedRoute>`, which fires `GET /auth/me` immediately. If the cookie didn't attach, `/auth/me` returns 401, `user=null`, ProtectedRoute redirects to `/login`. RedirectIfAuthenticated on `/login` re-evaluates and stays put → user is stuck.

2. **Two intermediate auth pages add hops without value.** `/auth/welcome-beta` and `/auth/privacy-consent` extend signup from 3 hops to 5 and login from 2 hops to 3. The privacy consent toggle is the only state change, and AKIS doesn't ship telemetry to any external system today (`DataMiningService.logEvent()` is in-memory only).

3. **Landing page has unverifiable marketing claims.** `StatsSection.tsx`, `FeaturesSection.tsx`, and i18n locales overstate features. For a senior thesis defense in 30 days, every claim must be defensible from the code.

4. **Jira integration is plumbed but unverified.** OAuth 3LO + encrypted token storage + per-pipeline opt-in + Epic creation + Proto/Trace comments + failure comment — all wired. Tests cover the happy path but **don't** cover the JSON-RPC timeout path or malformed responses.

5. **Staging environment is no longer needed.** Production runs on `akisflow.com`. Legacy `staging.akisflow.com` artifacts (multiple Caddyfiles, `deploy/staging/`, `.secrets/staging.env.snapshot`, hardcoded fallback URLs in `TraceAgent.ts`, `templates.ts`, `auth.invite.ts`, `health.ts`, i18n strings, test fixtures, doc references) all need to go. **Keep** the `staging.akisflow.com → akisflow.com` 301 redirect in `deploy/oci/prod/Caddyfile` for graceful degradation of old links.

6. **Account isolation is unverified.** Yasir explicitly does not trust that user A logging in won't see user B's chats/pipelines. This requires an audit of every pipeline/chat route handler to confirm `userId` from the cookie is added to the `WHERE` clause, plus a new e2e test that proves it.

**Today's date is 2026-05-02. Thesis defense / June 1 deadline = 30 days.** Auth + isolation must close in this PR.

## Architecture

- **Phase 0 first** — diagnose the OAuth loop on real prod via claude-in-chrome MCP before changing code blindly. The fix in Phase C may need to be (cookie domain) OR (provider URL fix in OAuth consoles, documented in runbook) OR both.
- **Auth flow simplification** — backend OAuth callback always redirects to `/chat` after setting the session cookie. Conditional onboarding gate (`dataSharingConsent`/`hasSeenBetaWelcome`) is removed. Frontend deletes the two intermediate pages, `WelcomeWizard.tsx`, the `onboarding/steps/` folder, and updates every `navigate()` call. **`WizardShell.tsx` STAYS** — `ProfileSetupWizard.tsx:113,129` still uses it; only `WelcomeWizard.tsx` becomes orphan.
- **DB columns stay** (no migration). `dataSharingConsent` and `hasSeenBetaWelcome` columns remain in `users` table — code just stops reading them. Migration risk > value pre-defense.
- **Cookie domain correctness** — prod docker-compose adds `AUTH_COOKIE_DOMAIN=akisflow.com`. New unit test asserts the `Set-Cookie` header carries `Domain=akisflow.com` when the env var is set.
- **i18n single source of truth** — only the locale JSON files and three landing components are touched.
- **Jira coverage gap** — two new Vitest unit tests for `JiraMCPService` (timeout + malformed response) + diagnostic logging in `fromOAuth()` failure paths. No new integration tests.
- **Staging removal** — every artifact removed in one pass (multiple Caddyfiles, devops/compose/, test fixtures, i18n strings, docs). The `staging.akisflow.com → akisflow.com` 301 in `deploy/oci/prod/Caddyfile` STAYS for graceful degradation.
- **Account isolation audit** — every pipeline/chat route handler verified for owner check; missing checks fixed; new e2e test proves user A cannot see user B's resources.

## Tech Stack

- Backend: Fastify 4 + TypeScript, `@fastify/cookie`, Drizzle ORM, Vitest
- Frontend: React 19 + Vite 7, react-router-dom 7, Vitest, Playwright (e2e)
- Deploy: OCI x86_64, Docker Compose, Caddy 2
- AI Agent: Anthropic claude-sonnet-4-6 (no change)
- Browser automation: claude-in-chrome MCP for live OAuth diagnostic + smoke

---

## Critical Files Reference (verified by direct Read)

**Backend auth path:**
- `backend/src/api/auth.oauth.ts:444` — OAuth init redirect URI uses `FRONTEND_URL`
- `backend/src/api/auth.oauth.ts:646-674` — JWT sign + cookie set + redirect dispatch (the bug epicenter)
- `backend/src/api/auth.oauth.ts:475-485` — new-user creation seeds `dataSharingConsent: null`, `hasSeenBetaWelcome: false`
- `backend/src/api/auth.multi-step.ts:209, 399, 407-449` — consent gate logic + `/update-preferences` endpoint + `UpdatePreferencesSchema`
- `backend/src/api/auth.invite.ts:66` — `env.FRONTEND_URL || 'https://staging.akisflow.com'` (remove fallback)
- `backend/src/api/health.ts:88` — OpenAPI schema example URL contains staging
- `backend/src/lib/env.ts` — `cookieOpts` exported here; `domain` set only when `AUTH_COOKIE_DOMAIN` env var is non-empty
- `backend/src/services/email/templates.ts:142, 168` — staging fallback URLs in `loginUrl` defaults

**TraceAgent (canonical determination — VERIFIED):**
- Two TraceAgent files exist:
  - `backend/src/agents/trace/TraceAgent.ts` — has staging fallback URLs at lines 403, 433, 1119, 1301
  - `backend/src/pipeline/agents/trace/TraceAgent.ts` — no staging refs
- Imports verified:
  - `backend/src/pipeline/core/pipeline-factory.ts:8` → `../agents/trace/TraceAgent.js` = **`backend/src/pipeline/agents/trace/`** (canonical for pipeline)
  - `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts:29` → same canonical pipeline path
  - `backend/src/core/agents/registry.ts:3` → `../../agents/trace/TraceAgent.js` = **`backend/src/agents/trace/`** (legacy)
- **Decision:** `backend/src/agents/trace/` (legacy) is referenced only by `backend/src/core/agents/registry.ts`. Phase F2 verifies whether `registry.ts` itself is still used; if not, delete the entire legacy folder. If `registry.ts` is live, replace the staging URLs in the legacy file with `https://akisflow.com`.

**Caddyfiles (VERIFIED — five exist):**
- `Caddyfile` (root) — not mounted by prod compose (verified `deploy/oci/prod/docker-compose.yml:37` mounts `./Caddyfile` relative to `deploy/oci/prod/`). **Delete.**
- `deploy/oci/prod/Caddyfile` — ACTIVE prod Caddyfile. **Keep**, including the `staging.akisflow.com → akisflow.com` 301 block (graceful degradation).
- `deploy/prod/Caddyfile` — superseded by oci/prod variant. **Delete unless verification proves it's referenced by an active deploy path.**
- `devops/compose/Caddyfile.edge` — references `staging.akisflow.com` block (line 122). **Verify if active**; if `devops/compose/docker-compose.edge.yml` is no longer deployed, delete both.
- `devops/compose/Caddyfile.prod` — likely superseded by `deploy/oci/prod/Caddyfile`. **Verify, then delete if unused.**

**Frontend pages + onboarding:**
- `frontend/src/App.tsx:15-16, 91-92` — lazy imports + protected route mounts (DELETE)
- `frontend/src/pages/auth/WelcomeBeta.tsx` — DELETE
- `frontend/src/pages/auth/PrivacyConsent.tsx` — DELETE
- `frontend/src/pages/auth/LoginPassword.tsx:58-61` — conditional `navigate()` (collapse to `/chat`)
- `frontend/src/pages/auth/SignupPassword.tsx:76-80` — same
- `frontend/src/pages/auth/SignupVerifyEmail.tsx:94` — `navigate('/auth/welcome-beta')` → `/chat`
- `frontend/src/pages/auth/InviteAccept.tsx:95` — `navigate('/auth/privacy-consent')` → `/chat`
- `frontend/src/components/chat/EmptyState.tsx:7, 84` — imports + mounts `<WelcomeWizard />`. **Delete the import, the `showWizard` state, the `handleWizardComplete` function, the `fetch('/auth/update-preferences')` call, and the `<WelcomeWizard ... />` JSX.** EmptyState's only job becomes rendering the empty state.
- `frontend/src/components/onboarding/WelcomeWizard.tsx` — DELETE
- `frontend/src/components/onboarding/steps/` — DELETE entire folder
- `frontend/src/components/onboarding/WizardShell.tsx` — **KEEP**. `ProfileSetupWizard.tsx:113,129` still imports it. Plan's deletion target was an over-reach.
- `frontend/src/components/AppShell.tsx:10` — comment referencing `/auth/privacy-consent` (clean)
- `frontend/src/services/api/auth.ts:169` — `updatePreferences()` client method (DELETE; orphan after backend endpoint goes)
- `frontend/src/services/api/auth.ts:62` — `hasSeenBetaWelcome` type field (KEEP — DB column stays, type stays in sync)

**Test mocks to update (frontend unit + e2e):**
- Unit (`hasSeenBetaWelcome: true` in user mock — drop the line):
  - `frontend/src/components/chat/__tests__/ChatPanel.failedPipeline.test.tsx:21`
  - `frontend/src/components/chat/__tests__/ChatPanel.scroll.test.tsx:21`
  - `frontend/src/components/chat/__tests__/EmptyState.test.tsx:6`
  - `frontend/src/components/__tests__/components.test.tsx:6`
  - `frontend/src/pages/chat/__tests__/ChatPage.mount.test.tsx:18`
- Unit (`vi.mock('../onboarding/WelcomeWizard', ...)` — DELETE the entire mock block; component is gone):
  - `frontend/src/components/chat/__tests__/ChatPanel.failedPipeline.test.tsx:28-30`
  - `frontend/src/components/chat/__tests__/ChatPanel.scroll.test.tsx:28-30`
  - `frontend/src/components/chat/__tests__/EmptyState.test.tsx:22-24, 71-end-of-test` (the test "does not show WelcomeWizard when user has already seen beta welcome" must be deleted entirely — assertion no longer meaningful)
  - `frontend/src/components/__tests__/components.test.tsx:34-36`
- E2E (Playwright):
  - `frontend/tests/e2e/auth-deep-links.spec.ts:17, 38` — DELETE both tests (they test routes that no longer exist)
  - `frontend/tests/e2e/auth-login-flow.spec.ts:41-42, 61-62` — drop `hasSeenBetaWelcome` + `dataSharingConsent` fields from user mocks
  - `frontend/tests/e2e/auth-signup-flow.spec.ts:5, 203, 338-380` — retarget post-verify URL to `/chat`, delete welcome-beta + privacy-consent specific test cases
  - `frontend/tests/e2e/prod-smoke/*.spec.ts` (5 files) — drop `hasSeenBetaWelcome` + `dataSharingConsent` from user mocks
  - `frontend/tests/e2e/helpers/mock-dashboard-apis.ts:15-16` — central mock helper, drop the two fields
- E2E (NEW):
  - `frontend/tests/e2e/account-isolation.spec.ts` — Phase H

**Landing i18n + components:**
- `frontend/src/i18n/locales/en.json` — keys to update + `tech.ecosystem.akis.description` (line ~1282) and `tech.evolution.t5.desc` (line ~1337) — both contain "Live at staging.akisflow.com"
- `frontend/src/i18n/locales/tr.json` — same keys + lines ~1279, ~1334 mirror
- `frontend/src/components/landing/HeroSection.tsx` — hardcoded title
- `frontend/src/components/landing/StatsSection.tsx:31-33` — hardcoded false stats
- `frontend/src/components/landing/FeaturesSection.tsx` — i18n key bindings

**Jira tests + diagnostics:**
- `backend/src/services/mcp/adapters/JiraMCPService.ts` — `fromOAuth()`, JSON-RPC handler
- `backend/test/unit/integrations-jira-oauth.test.ts` (existing)
- `backend/test/unit/jira-integration.test.ts` (existing)
- `backend/test/unit/jira-mcp-service.test.ts` — NEW
- `backend/src/pipeline/integrations/jiraIntegration.ts` — pipeline-side Jira calls

**Staging removal misc:**
- `backend/test/unit/email.test.ts`, `backend/test/unit/agents-validation.test.ts`, `backend/test/unit/trace-agent-execution.test.ts`, `backend/test/unit/trust-proxy.test.ts`, `backend/test/unit/invite.test.ts` — test fixtures with staging URLs
- `devops/compose/docker-compose.edge.yml` — verify if active, delete if not
- `devops/runbooks/db-volume-migration.md` — historical doc; KEEP (references the live `akis-staging-pgdata` volume name) but note in F6 that "staging" in the volume name is historical
- `docs/DEPLOYMENT.md:8, 40, 65, 75, 81` — staging references
- `.github/workflows/nightly-smoke.yml:28` — comment-only "before staging" reference
- `.github/workflows/trace-agent.yml` — search for staging references
- `.github/workflows/deploy-prod.yml:331-342` — KEEP (legacy volume cleanup; references live `akis-staging-pgdata`)

**Cookie domain unit test (NEW):**
- `backend/test/unit/cookie-domain.test.ts` — assert `Set-Cookie` carries `Domain=akisflow.com` when env set

**Account isolation audit (NEW):**
- `backend/src/pipeline/api/pipeline.routes.ts` — list/detail/delete/message endpoints
- All other pipeline/chat route handlers
- `frontend/tests/e2e/account-isolation.spec.ts` — NEW
- `docs/ops/ACCOUNT_ISOLATION_AUDIT_2026-05-02.md` — NEW

**Diagnostic report (NEW):**
- `docs/ops/AUTH_LOOP_DIAGNOSIS_2026-05-02.md` — NEW (Phase 0)

---

## Phase 0: OAuth Loop Diagnostic on Live Prod (NEW — RUN FIRST)

The plan's prior assumption was that `AUTH_COOKIE_DOMAIN` being unset is the sole cause. That's unverified. Cookies CAN attach as host-only. The actual root cause may be (a) an OAuth provider callback URL configured for `www.akisflow.com` while Caddy 301-redirects to apex (the redirect drops `Set-Cookie`), (b) `SameSite=None` not being set when it should be, (c) Caddy actually stripping the cookie, or (d) cookie domain mismatch. Diagnose before fixing.

### Task 0.1: Live OAuth flow capture via claude-in-chrome MCP

**No file changes — diagnostic only.**

- [ ] **Step 1: Open `https://akisflow.com` in an incognito tab via claude-in-chrome MCP (`tabs_create_mcp` + `navigate`)**

- [ ] **Step 2: Click "Login with Google" using `find` + `computer` tools**

- [ ] **Step 3: Complete the Google grant flow (the user's account should already be set up; if Google asks to pick an account, pick the test account)**

- [ ] **Step 4: After the OAuth provider redirects back, immediately capture network logs via `read_network_requests` filtered by `urlPattern: 'akisflow'`**

- [ ] **Step 5: Capture console logs via `read_console_messages` (especially errors)**

- [ ] **Step 6: For each request, record:**
  - The exact URL (note any www → apex redirects)
  - The response status code
  - Whether `Set-Cookie` was present in the response headers (and the full Domain/SameSite/Secure attributes)
  - Whether subsequent requests carried `Cookie: akis_sid=...` in their request headers

- [ ] **Step 7: Repeat the same flow for GitHub OAuth**

- [ ] **Step 8: Write `docs/ops/AUTH_LOOP_DIAGNOSIS_2026-05-02.md` with the findings**

Template:
```markdown
# OAuth Loop Diagnosis — 2026-05-02

## Method
Live capture in incognito Chrome via claude-in-chrome MCP. Network panel + console. No code change.

## Google flow trace
| Step | URL | Status | Set-Cookie present? | Cookie sent? | Notes |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |

## GitHub flow trace
(same table)

## Root cause
[Plain-English description. Examples:
- "Provider URL configured as www.akisflow.com; Caddy 301 to apex drops Set-Cookie."
- "AUTH_COOKIE_DOMAIN unset; cookie host-only on apex; subsequent /chat requests on apex still carry it (this is fine, so the cookie was never the issue)."
- "SameSite=Lax on cross-site provider redirect; first cross-site response drops the cookie."]

## Fix decision
[List of fixes that will be applied in Phase A/B/C, derived from the actual root cause. Note which providers' consoles need URL changes (user must do this manually).]
```

- [ ] **Step 9: Commit the diagnostic report**

```bash
git add docs/ops/AUTH_LOOP_DIAGNOSIS_2026-05-02.md
git commit -m "docs(ops): live OAuth loop diagnosis from prod"
```

**The fix in Phase C must align with the diagnosed root cause.** If the diagnostic shows the provider URL is the issue, the runbook in C3 becomes the primary deliverable; if cookie domain is the issue, the docker-compose change is primary. Most likely it's both.

---

## Phase A: Backend OAuth Callback Simplification

### Task A1: Drop the consent/welcome gate from OAuth callback

**Files:**
- Modify: `backend/src/api/auth.oauth.ts:655-662`

- [ ] **Step 1: Read the current logic**

```bash
sed -n '655,675p' backend/src/api/auth.oauth.ts
```

- [ ] **Step 2: Replace lines 655-662 with a constant `/chat` target**

```ts
      // Always redirect to /chat after a successful OAuth login. The
      // privacy-consent and welcome-beta intermediate pages were removed
      // in this cleanup; their backend gates are no-ops now.
      const redirectPath = '/chat';
```

(Lines 664 `logger.info(...)` and 674 `return redirect(...)` remain valid — they reference `redirectPath` and `frontendUrl`.)

- [ ] **Step 3: Run unit tests**

```bash
pnpm -C backend test:unit --run oauth
```

If a test asserts redirect to `/auth/privacy-consent`, update its expectation to `/chat`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/auth.oauth.ts
git commit -m "fix(auth): always redirect OAuth callback to /chat"
```

### Task A2: Delete the `/update-preferences` endpoint and consent fields from multi-step

**Files:**
- Modify: `backend/src/api/auth.multi-step.ts:209, 399, 407-449`

- [ ] **Step 1: Read all three sites**

```bash
sed -n '200,215p;395,410p;405,455p' backend/src/api/auth.multi-step.ts
```

- [ ] **Step 2: At line 209 and line 399, drop the `needsDataSharingConsent` field from the response payload**

```ts
// BEFORE (representative)
return reply.send({
  ok: true,
  user: ...,
  needsDataSharingConsent: user.dataSharingConsent === null,
  needsBetaWelcome: !user.hasSeenBetaWelcome,
});

// AFTER
return reply.send({
  ok: true,
  user: ...,
});
```

- [ ] **Step 3: At lines 407-449, delete the entire `/update-preferences` route handler and the `UpdatePreferencesSchema` Zod schema**

```ts
// DELETE THIS WHOLE BLOCK (407-449):
const UpdatePreferencesSchema = z.object({ ... });
fastify.post('/update-preferences', async (req, reply) => { ... });
```

If `UpdatePreferencesSchema` is imported anywhere else (`grep -rn 'UpdatePreferencesSchema' backend/src`), update those callers too.

- [ ] **Step 4: Typecheck + unit tests**

```bash
pnpm -C backend typecheck && pnpm -C backend test:unit
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/auth.multi-step.ts
git commit -m "fix(auth): delete /update-preferences endpoint and consent gating"
```

### Task A3: Drop `updatePreferences` client from frontend

**Files:**
- Modify: `frontend/src/services/api/auth.ts:169`

- [ ] **Step 1: Read the method**

```bash
sed -n '160,180p' frontend/src/services/api/auth.ts
```

- [ ] **Step 2: Delete the `updatePreferences` method from the `AuthAPI` object**

- [ ] **Step 3: Search for all callers**

```bash
grep -rn 'AuthAPI.updatePreferences\|updatePreferences' frontend/src
```

- [ ] **Step 4: Delete every caller (mostly inside `EmptyState.tsx` and `PrivacyConsent.tsx` which are being deleted anyway)**

- [ ] **Step 5: Typecheck**

```bash
pnpm -C frontend typecheck
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/services/api/auth.ts
git commit -m "chore(api): drop updatePreferences client method"
```

---

## Phase B: Frontend Page + Wizard Removal + Redirect Retargeting

### Task B1: Delete WelcomeBeta and PrivacyConsent pages

- [ ] **Step 1: Delete the two files**

```bash
git rm frontend/src/pages/auth/WelcomeBeta.tsx frontend/src/pages/auth/PrivacyConsent.tsx
```

- [ ] **Step 2: Verify no stragglers**

```bash
grep -rn 'WelcomeBeta\|PrivacyConsent' frontend/src
```

Expected: 0 hits.

### Task B2: Remove the two routes from App.tsx + clean AppShell comment

**Files:**
- Modify: `frontend/src/App.tsx:15-16, 82-93`
- Modify: `frontend/src/components/AppShell.tsx:10`

- [ ] **Step 1: In App.tsx, delete the lazy imports (lines 15-16) and the `<Route path="auth" element={<ProtectedRoute />}>` block (82-93). The `/auth/invite/:token` route on line 99 stays.**

- [ ] **Step 2: In AppShell.tsx, remove or rewrite the line-10 comment that mentions `/auth/privacy-consent`**

- [ ] **Step 3: Typecheck + lint**

```bash
pnpm -C frontend typecheck && pnpm -C frontend lint
```

### Task B3: Retarget every navigate() that pointed at the deleted routes

**Files:**
- Modify: `frontend/src/pages/auth/LoginPassword.tsx:58-61`
- Modify: `frontend/src/pages/auth/SignupPassword.tsx:76-80`
- Modify: `frontend/src/pages/auth/SignupVerifyEmail.tsx:94`
- Modify: `frontend/src/pages/auth/InviteAccept.tsx:95`

- [ ] **Step 1: LoginPassword.tsx — collapse the if/else to `navigate('/chat')`**

- [ ] **Step 2: SignupPassword.tsx — collapse to `navigate('/signup/verify-email')` (the verify step still exists)**

- [ ] **Step 3: SignupVerifyEmail.tsx:94 — `navigate('/auth/welcome-beta')` → `navigate('/chat')`**

- [ ] **Step 4: InviteAccept.tsx:95 — `navigate('/auth/privacy-consent')` → `navigate('/chat')`**

- [ ] **Step 5: Verify**

```bash
grep -rn 'welcome-beta\|privacy-consent' frontend/src
```

Expected: 0 hits in non-test files.

- [ ] **Step 6: Commit B1+B2+B3**

```bash
git add frontend/src/App.tsx frontend/src/components/AppShell.tsx frontend/src/pages/auth/LoginPassword.tsx frontend/src/pages/auth/SignupPassword.tsx frontend/src/pages/auth/SignupVerifyEmail.tsx frontend/src/pages/auth/InviteAccept.tsx
git rm frontend/src/pages/auth/WelcomeBeta.tsx frontend/src/pages/auth/PrivacyConsent.tsx
git commit -m "refactor(auth): drop welcome-beta and privacy-consent intermediate pages"
```

### Task B4: Surgically clean EmptyState — remove WelcomeWizard mount

**Files:**
- Modify: `frontend/src/components/chat/EmptyState.tsx`

The current EmptyState renders `<WelcomeWizard onComplete={handleWizardComplete} />` inside the chat (separate from the deleted `/auth/welcome-beta` page). A naive "drop the conditional" would leave the wizard mounted on every chat open. Specific deletions:

- [ ] **Step 1: Read the file fully**

```bash
cat frontend/src/components/chat/EmptyState.tsx
```

- [ ] **Step 2: Delete each of the following:**
  - Line 7: `import { WelcomeWizard } from '../onboarding/WelcomeWizard';`
  - The `showWizard` `useState` declaration
  - The `handleWizardComplete` function (which calls `fetch('/auth/update-preferences', ...)`)
  - The `useEffect` that initializes `showWizard` based on `user.hasSeenBetaWelcome` / localStorage
  - Line 84: `{showWizard && <WelcomeWizard onComplete={handleWizardComplete} />}` — delete the JSX line entirely
  - Any localStorage read/write for `hasSeenBetaWelcome` in this file

After cleanup, EmptyState's only job is rendering the empty-state UI (header, suggestions, CTA).

- [ ] **Step 3: Run EmptyState test**

```bash
pnpm -C frontend test --run EmptyState
```

If the test "does not show WelcomeWizard when user has already seen beta welcome" still exists, delete it (the assertion is no longer meaningful — the wizard is gone).

### Task B5: Delete WelcomeWizard, steps folder; KEEP WizardShell

**Files:**
- Delete: `frontend/src/components/onboarding/WelcomeWizard.tsx`
- Delete: `frontend/src/components/onboarding/steps/` (entire folder)
- KEEP: `frontend/src/components/onboarding/WizardShell.tsx` (still used by `ProfileSetupWizard.tsx:113,129`)

- [ ] **Step 1: Verify the steps/ folder is only used by WelcomeWizard**

```bash
grep -rn "from.*onboarding/steps\|from '../onboarding/steps'" frontend/src
```

If anything other than `WelcomeWizard.tsx` imports from `steps/`, leave those imports alone and only delete the unused step files. Otherwise, full folder delete is safe.

- [ ] **Step 2: Verify WizardShell consumers (ensure ProfileSetupWizard still uses it)**

```bash
grep -rn "WizardShell" frontend/src
```

- [ ] **Step 3: Delete**

```bash
git rm frontend/src/components/onboarding/WelcomeWizard.tsx
git rm -r frontend/src/components/onboarding/steps/
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -C frontend typecheck
```

If anything broke (e.g. `WelcomeWizard` referenced from a test mock not yet cleaned), proceed to B6 first then re-run.

- [ ] **Step 5: Commit B4+B5**

```bash
git add frontend/src/components/chat/EmptyState.tsx
git rm frontend/src/components/onboarding/WelcomeWizard.tsx
git rm -r frontend/src/components/onboarding/steps/
git commit -m "refactor(chat): remove in-chat WelcomeWizard mount and orphan onboarding files"
```

### Task B6: Update unit-test mocks (5 files for `hasSeenBetaWelcome` + 4 files for WelcomeWizard mock)

- [ ] **Step 1: Drop the `hasSeenBetaWelcome: true` line from each user-mock object in:**
  - `frontend/src/components/chat/__tests__/ChatPanel.failedPipeline.test.tsx:21`
  - `frontend/src/components/chat/__tests__/ChatPanel.scroll.test.tsx:21`
  - `frontend/src/components/chat/__tests__/EmptyState.test.tsx:6`
  - `frontend/src/components/__tests__/components.test.tsx:6`
  - `frontend/src/pages/chat/__tests__/ChatPage.mount.test.tsx:18`

- [ ] **Step 2: Delete the `vi.mock('../onboarding/WelcomeWizard', ...)` block from:**
  - `frontend/src/components/chat/__tests__/ChatPanel.failedPipeline.test.tsx:28-30`
  - `frontend/src/components/chat/__tests__/ChatPanel.scroll.test.tsx:28-30`
  - `frontend/src/components/chat/__tests__/EmptyState.test.tsx:22-24` and the test case at line 71 if present
  - `frontend/src/components/__tests__/components.test.tsx:34-36`

- [ ] **Step 3: Run frontend unit tests**

```bash
pnpm -C frontend test
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/chat/__tests__/*.tsx frontend/src/components/__tests__/components.test.tsx frontend/src/pages/chat/__tests__/ChatPage.mount.test.tsx
git commit -m "test(unit): drop hasSeenBetaWelcome mocks and WelcomeWizard vi.mock blocks"
```

### Task B7: Update Playwright e2e tests

**Files:**
- Modify: `frontend/tests/e2e/auth-deep-links.spec.ts:17, 38`
- Modify: `frontend/tests/e2e/auth-login-flow.spec.ts:41-42, 61-62`
- Modify: `frontend/tests/e2e/auth-signup-flow.spec.ts:5, 203, 338-380`
- Modify: `frontend/tests/e2e/prod-smoke/*.spec.ts` (5 files)
- Modify: `frontend/tests/e2e/helpers/mock-dashboard-apis.ts:15-16`

- [ ] **Step 1: auth-deep-links.spec.ts — DELETE the two test cases at lines 17 and 38 (they test routes that no longer exist)**

- [ ] **Step 2: auth-login-flow.spec.ts — drop `hasSeenBetaWelcome` and `dataSharingConsent` fields from user mocks at lines 41-42 and 61-62**

- [ ] **Step 3: auth-signup-flow.spec.ts:**
  - Line 5: clean comment if it mentions welcome-beta/privacy-consent
  - Line 203: change `await page.waitForURL('**/auth/welcome-beta')` → `await page.waitForURL('**/chat')`
  - Lines 338-380: DELETE the welcome-beta-specific test (line 338) and the privacy-consent test (line 359-380)

- [ ] **Step 4: prod-smoke/*.spec.ts (5 files) — drop the two fields from user mocks**

```bash
ls frontend/tests/e2e/prod-smoke/*.spec.ts
# For each, run a search-and-replace removing the two fields
```

- [ ] **Step 5: helpers/mock-dashboard-apis.ts:15-16 — drop the central mock fields**

- [ ] **Step 6: Verify no welcome-beta/privacy-consent strings remain**

```bash
grep -rn 'welcome-beta\|privacy-consent\|hasSeenBetaWelcome\|dataSharingConsent' frontend/tests/e2e
```

Expected: 0 hits.

- [ ] **Step 7: Commit**

```bash
git add frontend/tests/e2e/
git commit -m "test(e2e): retarget signup/login flows to /chat and drop deleted-route tests"
```

---

## Phase C: Production Cookie Config + Verification

### Task C1: Add `AUTH_COOKIE_DOMAIN` to prod docker-compose

**Files:**
- Modify: `deploy/oci/prod/docker-compose.yml:86-96`

- [ ] **Step 1: Insert the new env var into the backend service environment block (right after line 91)**

```yaml
      AUTH_COOKIE_DOMAIN: ${AUTH_COOKIE_DOMAIN:-akisflow.com}
```

- [ ] **Step 2: Verify ordering**

```bash
sed -n '85,100p' deploy/oci/prod/docker-compose.yml
```

### Task C2: Document in env.example

**Files:**
- Modify: `deploy/oci/prod/env.example`

- [ ] **Step 1: Add a new line in the auth-cookie section**

```bash
# Cookie domain — must match the apex of the public URL so the session
# cookie attaches across redirect chains. For www→apex setups, set to
# "akisflow.com" (no leading dot, no www).
AUTH_COOKIE_DOMAIN=akisflow.com
```

### Task C3: Cookie domain unit test

**Files:**
- Create: `backend/test/unit/cookie-domain.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('AUTH_COOKIE_DOMAIN — cookie issuance', () => {
  const ORIG = process.env.AUTH_COOKIE_DOMAIN;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AUTH_COOKIE_DOMAIN;
    else process.env.AUTH_COOKIE_DOMAIN = ORIG;
  });

  it('sets cookie Domain attribute when AUTH_COOKIE_DOMAIN env is set', async () => {
    process.env.AUTH_COOKIE_DOMAIN = 'akisflow.com';
    const { cookieOpts } = await import('../../src/lib/env.ts');
    expect(cookieOpts.domain).toBe('akisflow.com');
  });

  it('omits Domain attribute when AUTH_COOKIE_DOMAIN env is empty', async () => {
    delete process.env.AUTH_COOKIE_DOMAIN;
    const { cookieOpts } = await import('../../src/lib/env.ts');
    expect(cookieOpts.domain).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect PASS (the existing implementation already handles this — see `backend/src/lib/env.ts:37-39`). The test guards against regression.**

```bash
pnpm -C backend test:unit --run cookie-domain
```

### Task C4: Update RUNBOOK with OAuth provider URLs

**Files:**
- Modify: `deploy/oci/prod/RUNBOOK.md` (or create if missing)

- [ ] **Step 1: Add an "OAuth Provider Configuration" section**

```markdown
## OAuth Provider Callback URLs

These URLs MUST match exactly. Trailing slashes, www prefix, and protocol matter.

### Google Cloud Console
- Project → APIs & Services → Credentials → OAuth 2.0 Client ID
- Authorized redirect URIs: `https://akisflow.com/auth/oauth/google/callback`

### GitHub Developer Settings
- Settings → Developer settings → OAuth Apps → AKIS Production
- Authorization callback URL: `https://akisflow.com/auth/oauth/github/callback`

### Atlassian Developer Console
- Manage apps → OAuth 2.0 (3LO) → AKIS
- Callback URL: `https://akisflow.com/api/integrations/atlassian/oauth/callback`

If the user typed `www.akisflow.com` anywhere, change it. Caddy 301-redirects www → apex; the redirect drops Set-Cookie, breaking the OAuth flow.

After any change, restart the backend container:

```bash
ssh user@$PROD_HOST 'cd /opt/akis/prod && docker compose up -d --force-recreate backend'
```
```

- [ ] **Step 2: Commit C1+C2+C3+C4**

```bash
git add deploy/oci/prod/docker-compose.yml deploy/oci/prod/env.example deploy/oci/prod/RUNBOOK.md backend/test/unit/cookie-domain.test.ts
git commit -m "fix(deploy): set AUTH_COOKIE_DOMAIN, add unit test, document provider URLs"
```

---

## Phase D: Landing Page i18n Truthfulness

### Task D1: Edit `en.json` — apply the cleanup table

**Files:**
- Modify: `frontend/src/i18n/locales/en.json`

- [ ] **Step 1: Apply these key updates**

| Key | New EN value |
|---|---|
| `hero.title` | `Three Agents. From Idea to Tested Code.` |
| `hero.sub` | `AKIS turns plain-language ideas into structured specs, scaffolded code, and automated tests.` |
| `agents.proto.heroSubtitle` | `Generate a working prototype scaffold from a spec.` |
| `agents.proto.useCase1.description` | `Generate a working prototype scaffold from a written spec.` |
| `agents.proto.feature.docker_ci` (or whichever holds "Generates Docker configs...") | DELETE the key, OR change value to truthful description |
| `landing.about.builtBy` (the "Built by developers..." string at ~line 27) | `Built by Ömer Yasir Önal as a senior thesis project at FSMVÜ (Fatih Sultan Mehmet Vakıf Üniversitesi).` |
| `features.jira.description` | `Jira: auto-creates an Epic on spec approval.` |
| `features.bdd.description` | `Optional Cucumber export — Trace primarily generates Playwright suites.` |
| `tech.ecosystem.akis.description` (line ~1282) | Replace "Live at staging.akisflow.com" with "Live at akisflow.com" |
| `tech.evolution.t5.desc` (line ~1337) | Same staging→prod URL substitution |

- [ ] **Step 2: Validate JSON**

```bash
node -e 'JSON.parse(require("fs").readFileSync("frontend/src/i18n/locales/en.json","utf8"))'
```

### Task D2: Mirror the changes in `tr.json`

**Files:**
- Modify: `frontend/src/i18n/locales/tr.json`

- [ ] **Step 1: Apply mirror translations + line ~1279, ~1334 staging→akisflow.com**

| Key | New TR value |
|---|---|
| `hero.title` | `Üç Ajan. Fikirden Test Edilmiş Koda.` |
| `hero.sub` | `AKIS, düz metin fikirleri yapılandırılmış spec, scaffold edilmiş kod ve otomatik testlere dönüştürür.` |
| `agents.proto.heroSubtitle` | `Spec'ten çalışan bir prototip scaffold'ı üretir.` |
| `agents.proto.useCase1.description` | `Yazılı bir spec'ten çalışan prototip scaffold'ı üretir.` |
| `landing.about.builtBy` | `Ömer Yasir Önal tarafından FSMVÜ (Fatih Sultan Mehmet Vakıf Üniversitesi) bitirme projesi olarak geliştirilmiştir.` |
| `features.jira.description` | `Jira: spec onayında otomatik Epic.` |
| `features.bdd.description` | `Opsiyonel Cucumber export — Trace birincil olarak Playwright kullanır.` |
| `tech.ecosystem.akis.description` (~1279) | "Live at akisflow.com" |
| `tech.evolution.t5.desc` (~1334) | Same |

- [ ] **Step 2: Validate JSON**

### Task D3: Update hardcoded strings in landing components

**Files:**
- Modify: `frontend/src/components/landing/StatsSection.tsx`
- Modify: `frontend/src/components/landing/HeroSection.tsx`
- Modify: `frontend/src/components/landing/FeaturesSection.tsx`

- [ ] **Step 1: StatsSection.tsx — replace the three hardcoded stats**

Either delete the section entirely OR replace with:
```tsx
{ value: '3', label: t('stats.agents') },          // "AI Agents"
{ value: '∞', label: t('stats.providers') },       // "AI Providers (Anthropic / OpenAI / OpenRouter)"
{ value: '<1', label: t('stats.setupMinutes') },   // "Setup in minutes"
```

- [ ] **Step 2: HeroSection.tsx — route hero title through `t('hero.title')` if currently hardcoded**

- [ ] **Step 3: FeaturesSection.tsx — ensure features read from i18n; remove hardcoded false claims**

- [ ] **Step 4: Tests + commit**

```bash
pnpm -C frontend test
git add frontend/src/i18n/locales/ frontend/src/components/landing/
git commit -m "docs(landing): align marketing copy with verifiable code reality"
```

---

## Phase E: Jira Stabilization

### Task E1: Unit test — JSON-RPC timeout

**Files:**
- Create: `backend/test/unit/jira-mcp-service.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { JiraMCPService } from '../../src/services/mcp/adapters/JiraMCPService';

describe('JiraMCPService — timeout', () => {
  it('rejects with a timeout error when the JSON-RPC endpoint hangs past budget', async () => {
    const hangingFetch = vi.fn(() => new Promise(() => {}));
    const svc = new JiraMCPService({
      mcpBaseUrl: 'http://example.invalid/mcp',
      accessToken: 'fake-token',
      cloudId: 'fake-cloud',
      fetchImpl: hangingFetch as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await expect(svc.createIssue({ projectKey: 'AKIS', summary: 'test', issueType: 'Epic' }))
      .rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2: Run; if missing constructor seam, add `fetchImpl?` and `timeoutMs?` optional fields to the constructor and plumb to the fetch + AbortSignal logic**

- [ ] **Step 3: Re-run, expect PASS**

### Task E2: Unit test — malformed JSON-RPC response

**Files:**
- Modify: `backend/test/unit/jira-mcp-service.test.ts`

- [ ] **Step 1: Add the test**

```ts
it('throws a structured error when JSON-RPC response is missing both result and error', async () => {
  const malformedFetch = vi.fn(async () => new Response(JSON.stringify({
    jsonrpc: '2.0', id: 'req-1',
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const svc = new JiraMCPService({
    mcpBaseUrl: 'http://example.invalid/mcp',
    accessToken: 'fake-token',
    cloudId: 'fake-cloud',
    fetchImpl: malformedFetch as unknown as typeof fetch,
    timeoutMs: 1000,
  });
  await expect(svc.createIssue({ projectKey: 'AKIS', summary: 'test', issueType: 'Epic' }))
    .rejects.toThrow(/malformed|invalid|missing/i);
});
```

- [ ] **Step 2: Add the validation in `JiraMCPService.ts` — after `await response.json()`, assert `body.result || body.error`; otherwise throw**

- [ ] **Step 3: Re-run, expect PASS**

### Task E3: Diagnostic logging in `fromOAuth()`

**Files:**
- Modify: `backend/src/services/mcp/adapters/JiraMCPService.ts`

- [ ] **Step 1: Add `logger.warn({ userId, reason }, '[Jira] fromOAuth returning null')` at each `return null` branch (token missing, decryption failed, refresh failed)**

- [ ] **Step 2: Run all backend unit tests**

```bash
pnpm -C backend test:unit
```

- [ ] **Step 3: Commit E1+E2+E3**

```bash
git add backend/src/services/mcp/adapters/JiraMCPService.ts backend/test/unit/jira-mcp-service.test.ts
git commit -m "test(jira): timeout + malformed-response coverage; warn on fromOAuth null"
```

---

## Phase F: Staging Removal

### Task F1: Delete staging deploy directory and snapshot

- [ ] **Step 1: Confirm contents**

```bash
ls -la deploy/staging/ 2>/dev/null
ls -la .secrets/staging.env.snapshot 2>/dev/null
```

- [ ] **Step 2: Delete**

```bash
git rm -r deploy/staging/ 2>/dev/null
rm -f .secrets/staging.env.snapshot  # likely gitignored
```

### Task F2: Caddyfile audit and cleanup

The repo has FIVE Caddyfiles. Determine activeness:

- [ ] **Step 1: Verify which are mounted**

```bash
grep -rn 'Caddyfile' deploy/ devops/ | grep -i 'mount\|volume\|:ro'
```

The active prod Caddyfile is `deploy/oci/prod/Caddyfile` (mounted in `deploy/oci/prod/docker-compose.yml:37`).

- [ ] **Step 2: KEEP `deploy/oci/prod/Caddyfile` AS-IS, including any `staging.akisflow.com → akisflow.com` 301 redirect block (graceful degradation for old links)**

- [ ] **Step 3: Delete root `Caddyfile` (not used in prod)**

```bash
git rm Caddyfile
```

- [ ] **Step 4: Verify `deploy/prod/Caddyfile` is unused**

```bash
grep -rn 'deploy/prod/Caddyfile' .github/ deploy/ devops/ 2>/dev/null
```

If 0 hits → `git rm deploy/prod/Caddyfile` and the rest of `deploy/prod/` if also unreferenced.

- [ ] **Step 5: Verify `devops/compose/Caddyfile.edge` is unused**

```bash
grep -rn 'docker-compose.edge\|Caddyfile.edge' .github/ deploy/ scripts/ 2>/dev/null
```

If no active workflow uses it → `git rm devops/compose/Caddyfile.edge devops/compose/docker-compose.edge.yml`

- [ ] **Step 6: Verify `devops/compose/Caddyfile.prod` is unused**

```bash
grep -rn 'devops/compose/Caddyfile.prod' .github/ deploy/ 2>/dev/null
```

If 0 hits → `git rm devops/compose/Caddyfile.prod`.

### Task F3: Delete staging GitHub Actions workflow if present

- [ ] **Step 1: List**

```bash
ls .github/workflows/ | grep -i staging
```

Per `Bash` audit done already, no `oci-staging-deploy.yml` exists in the current workflows list — but if one is found, `git rm` it.

### Task F4: Clean staging URLs in nightly-smoke and trace-agent workflows

**Files:**
- Modify: `.github/workflows/nightly-smoke.yml:28`
- Modify: `.github/workflows/trace-agent.yml`

- [ ] **Step 1: nightly-smoke.yml:28 — comment-only "before staging" reference, just delete the word "staging" (or the whole comment if obsolete)**

- [ ] **Step 2: Search trace-agent.yml**

```bash
grep -n 'staging' .github/workflows/trace-agent.yml
```

Remove any staging URL references.

### Task F5: Replace staging fallback URLs in canonical TraceAgent

**Files:**
- Modify (after verification): `backend/src/agents/trace/TraceAgent.ts:403, 433, 1119, 1301`

- [ ] **Step 1: Verify whether legacy folder is live**

```bash
grep -rn 'core/agents/registry' backend/src
```

If `registry.ts` is referenced by an active code path:
- [ ] **Step 2a (registry live): Replace each `'https://staging.akisflow.com'` literal with `'https://akisflow.com'` in `backend/src/agents/trace/TraceAgent.ts`**

If `registry.ts` is dead code:
- [ ] **Step 2b (registry dead): `git rm -r backend/src/agents/`** (the entire legacy folder including TraceAgent.ts goes)

- [ ] **Step 3: Verify pipeline TraceAgent (the canonical one at `backend/src/pipeline/agents/trace/TraceAgent.ts`) has no staging refs**

```bash
grep -n 'staging' backend/src/pipeline/agents/trace/TraceAgent.ts
```

Expected: 0 hits.

### Task F6: Replace staging fallback in email templates, invite, health

**Files:**
- Modify: `backend/src/services/email/templates.ts:142, 168`
- Modify: `backend/src/api/auth.invite.ts:66`
- Modify: `backend/src/api/health.ts:88`

- [ ] **Step 1: templates.ts:142 — `loginUrl = 'https://staging.akisflow.com/login'` → `loginUrl = 'https://akisflow.com/login'`**

- [ ] **Step 2: templates.ts:168 — same**

- [ ] **Step 3: auth.invite.ts:66 — DELETE the fallback entirely**

```ts
// BEFORE
const publicUrl = env.FRONTEND_URL || 'https://staging.akisflow.com';

// AFTER
const publicUrl = env.FRONTEND_URL;
```

(`env.FRONTEND_URL` is required and validated at startup — fallback is dead code.)

- [ ] **Step 4: health.ts:88 — `example: 'https://staging.akisflow.com/auth/oauth'` → `example: 'https://akisflow.com/auth/oauth'`**

### Task F7: Update backend test fixtures

**Files:**
- Modify: `backend/test/unit/email.test.ts`
- Modify: `backend/test/unit/agents-validation.test.ts`
- Modify: `backend/test/unit/trace-agent-execution.test.ts`
- Modify: `backend/test/unit/trust-proxy.test.ts`
- Modify: `backend/test/unit/invite.test.ts`

- [ ] **Step 1: For each, replace `https://staging.akisflow.com` with `https://akisflow.com`**

```bash
for f in backend/test/unit/email.test.ts backend/test/unit/agents-validation.test.ts backend/test/unit/trace-agent-execution.test.ts backend/test/unit/trust-proxy.test.ts backend/test/unit/invite.test.ts; do
  grep -n 'staging.akisflow' "$f"
done
```

Then edit each match.

- [ ] **Step 2: Run all backend unit tests**

```bash
pnpm -C backend test:unit
```

### Task F8: Update CLAUDE.md and DEPLOYMENT.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/DEPLOYMENT.md:8, 40, 65, 75, 81`

- [ ] **Step 1: Search**

```bash
grep -n 'staging' CLAUDE.md docs/DEPLOYMENT.md
```

- [ ] **Step 2: For CLAUDE.md, drop staging-specific sections; the "PR Review + Deploy Smoke" loop already mentions akisflow.com**

- [ ] **Step 3: For docs/DEPLOYMENT.md, remove the staging row from the environments table, drop staging-specific sections, update edge-proxy section if `Caddyfile.edge` was deleted in F2**

### Task F9: Note historical volume name in F8 commit

The `akis-staging-pgdata` external volume name in `deploy/oci/prod/docker-compose.yml:265` and `.github/workflows/deploy-prod.yml:331-342` is **HISTORICAL**, not staging — it's the live prod volume. Renaming requires a data-move; explicitly out of scope (the user listed this as out-of-scope). Document in the commit message and in `devops/runbooks/db-volume-migration.md` (which already contains the migration plan; just confirm it's still accurate).

- [ ] **Step 1: Read the runbook**

```bash
cat devops/runbooks/db-volume-migration.md
```

- [ ] **Step 2: If the runbook is accurate, no change needed. Just leave a `// historical name` comment in `deploy/oci/prod/docker-compose.yml:264-265`**

```yaml
volumes:
  pgdata:
    external: true
    # Historical name — the production data lives in this volume; renaming
    # requires a data move (see devops/runbooks/db-volume-migration.md).
    name: akis-staging-pgdata
```

- [ ] **Step 3: Commit F1-F9 as one staging-removal commit**

```bash
git add -A
git commit -m "chore(deploy): remove staging environment, single env on akisflow.com"
```

---

## Phase G: End-to-end Verification

### Task G1: Quality gate (must be green before any commit beyond this point)

- [ ] **Step 1: Backend gate**

```bash
pnpm -C backend typecheck && pnpm -C backend lint && pnpm -C backend test:unit && pnpm -C backend build
```

- [ ] **Step 2: Frontend gate**

```bash
pnpm -C frontend typecheck && pnpm -C frontend lint && pnpm -C frontend test && pnpm -C frontend build
```

- [ ] **Step 3: Stop and fix anything red. Defense is in 30 days.**

---

## Phase H: Account Isolation Audit (NEW)

### Task H1: Audit every pipeline/chat route handler

**Files (audit, not edit yet):**
- `backend/src/pipeline/api/pipeline.routes.ts`
- Any other file in `backend/src/api/` or `backend/src/pipeline/api/` that handles GET/POST/DELETE for resources owned by users

- [ ] **Step 1: List every route**

```bash
grep -rn "fastify\.\(get\|post\|delete\|put\)" backend/src/pipeline/api backend/src/api 2>/dev/null
```

- [ ] **Step 2: For each route returning or modifying user-owned data (pipelines, chats, messages, files), verify the SQL/Drizzle query has `WHERE userId = $currentUserId`**

The expected Drizzle pattern:
```ts
const currentUserId = req.user.id;
const rows = await db.select().from(pipelines).where(eq(pipelines.userId, currentUserId));
```

- [ ] **Step 3: Build the audit table**

| Route | File:line | Owner check present? | Notes |
|---|---|---|---|
| GET /api/pipelines | pipeline.routes.ts:NN | YES/NO | ... |
| GET /api/pipelines/:id | pipeline.routes.ts:NN | YES/NO | ... |
| DELETE /api/pipelines/:id | pipeline.routes.ts:NN | YES/NO | ... |
| POST /api/pipelines/:id/message | pipeline.routes.ts:NN | YES/NO | ... |
| POST /api/pipelines/:id/approve | pipeline.routes.ts:NN | YES/NO | ... |
| POST /api/pipelines/:id/reject | pipeline.routes.ts:NN | YES/NO | ... |
| POST /api/pipelines/:id/retry | pipeline.routes.ts:NN | YES/NO | ... |
| POST /api/pipelines/:id/skip-trace | pipeline.routes.ts:NN | YES/NO | ... |

- [ ] **Step 4: Write `docs/ops/ACCOUNT_ISOLATION_AUDIT_2026-05-02.md` with:**
  - Method (Drizzle pattern grep + manual review)
  - Table above
  - Findings (which routes are missing the check)
  - Fix plan (one bullet per route to fix)

### Task H2: Fix any missing owner checks

For each route flagged in H1 as missing the check:

- [ ] **Step 1: Add `currentUserId = req.user.id` extraction (use the existing auth helper if one exists; do NOT roll your own JWT decoding)**

- [ ] **Step 2: Add `eq(<table>.userId, currentUserId)` to the WHERE clause**

- [ ] **Step 3: For routes operating on a single resource by ID, the WHERE must include both `eq(table.id, params.id)` AND `eq(table.userId, currentUserId)`. Cross-user access returns 404 (not 403 — don't leak existence).**

- [ ] **Step 4: Run the existing backend integration tests**

```bash
pnpm -C backend test:integration 2>/dev/null || pnpm -C backend test
```

### Task H3: New e2e test — account isolation

**Files:**
- Create: `frontend/tests/e2e/account-isolation.spec.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from '@playwright/test';

test.describe('Account isolation', () => {
  test('user B cannot see user A pipelines via list or detail', async ({ browser }) => {
    // Two isolated browser contexts (two different sessions)
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // User A: signup or login, create a pipeline
    await pageA.goto('/');
    // ... login as user A (use seeded test user A) ...
    // ... start a pipeline, capture its ID ...
    const pipelineIdA = await pageA.evaluate(/* extract from app state or API response */);

    // User B: signup or login as a DIFFERENT user
    await pageB.goto('/');
    // ... login as user B (seeded test user B) ...

    // Assert B's GET /api/pipelines does NOT include A's pipeline
    const listB = await pageB.request.get('/api/pipelines');
    expect(listB.ok()).toBeTruthy();
    const itemsB = await listB.json();
    expect(itemsB.pipelines.find((p: any) => p.id === pipelineIdA)).toBeUndefined();

    // Assert B's GET /api/pipelines/:idA returns 403 or 404
    const detailB = await pageB.request.get(`/api/pipelines/${pipelineIdA}`);
    expect([403, 404]).toContain(detailB.status());

    await ctxA.close();
    await ctxB.close();
  });
});
```

- [ ] **Step 2: Run; expect PASS**

If FAIL, that's a critical bug — H2 missed something. Fix and re-run.

- [ ] **Step 3: Commit H1+H2+H3**

```bash
git add docs/ops/ACCOUNT_ISOLATION_AUDIT_2026-05-02.md backend/src/pipeline/api/ backend/src/api/ frontend/tests/e2e/account-isolation.spec.ts
git commit -m "fix(security): enforce owner check on every pipeline route + e2e test"
```

---

## Phase I: PR + Deploy Smoke Loop

### Task I1: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin <branch-name>
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "fix(auth+security): kill OAuth loop, drop onboarding pages, isolate accounts, remove staging" --body "$(cat <<'EOF'
## Summary
- **Phase 0:** Live OAuth diagnostic on prod — root cause + fix decision in `docs/ops/AUTH_LOOP_DIAGNOSIS_2026-05-02.md`
- **Phase A-B:** Drop `/auth/welcome-beta` + `/auth/privacy-consent` intermediate pages, in-chat WelcomeWizard, and the `/update-preferences` endpoint
- **Phase C:** Add `AUTH_COOKIE_DOMAIN=akisflow.com` to prod compose, new unit test, document OAuth provider URLs in RUNBOOK
- **Phase D:** Truthful landing copy (i18n + 3 components)
- **Phase E:** JiraMCPService timeout + malformed-response unit tests + diagnostic logging
- **Phase F:** Remove staging environment (Caddyfiles, devops/, fallback URLs, test fixtures, docs)
- **Phase H:** Account isolation audit + missing owner-check fixes + e2e test

## Risk
HIGH — touches auth and resource isolation. **Do not auto-merge.** Yasir reviews + merges.

## Test plan
- [x] Backend typecheck/lint/test/build green
- [x] Frontend typecheck/lint/test/build green
- [x] Account isolation e2e passes locally
- [ ] Live browser smoke on akisflow.com after merge (Google + GitHub OAuth + email signup + isolation across browser contexts)
- [ ] `/auth/welcome-beta` and `/auth/privacy-consent` direct visits → landing
- [ ] Smoke report attached as `docs/ops/DEPLOY_SMOKE_<pr-num>_2026-05-02.md`

## Deploy steps (Yasir)
1. SSH prod, set `AUTH_COOKIE_DOMAIN=akisflow.com` in `/opt/akis/prod/.env`
2. `docker compose pull && docker compose up -d --force-recreate backend`
3. Verify Google/GitHub/Atlassian OAuth callback URLs (see RUNBOOK)
EOF
)"
```

### Task I2: Live browser smoke (mandatory, claude-in-chrome MCP)

**Run only after Yasir merges and prod deploy completes (deploy-prod.yml `success`).**

- [ ] **Step 1: Wait for deploy-prod.yml success**

```bash
gh run list --workflow=deploy-prod.yml --limit 1
```

- [ ] **Step 2: Drive the flows on `https://akisflow.com` via claude-in-chrome MCP. Capture screenshot + network at each step:**

| Scenario | Expected |
|---|---|
| Incognito + Google login | Lands on `/chat`. Network: `Set-Cookie: akis_sid=...; Domain=akisflow.com; HttpOnly; Secure; SameSite=None` on the callback response. Subsequent `/auth/me` carries `Cookie: akis_sid=...`. |
| Incognito + GitHub login | Same |
| Incognito + email signup → verify-email | Lands on `/chat` after verify |
| Direct visit `/auth/welcome-beta` | Bounces to landing (404 → `*` route) |
| Direct visit `/auth/privacy-consent` | Bounces to landing |
| Two contexts (user A + user B) | A creates pipeline; B's chat list does not show it; B's `GET /api/pipelines/:idA` returns 403/404 |

- [ ] **Step 3: Save report `docs/ops/DEPLOY_SMOKE_<pr-num>_2026-05-02.md`** with before/after screenshots and observations.

- [ ] **Step 4: PR comment with smoke-report link**

```bash
gh pr comment <pr-num> --body "Smoke test complete: docs/ops/DEPLOY_SMOKE_<pr-num>_2026-05-02.md. All scenarios pass / regressions: <list>."
```

### Task I3: Self-review note

- [ ] **Step 1: Run `superpowers:requesting-code-review` to invoke `superpowers:code-reviewer` subagent on the PR diff**

- [ ] **Step 2: Attach the review summary as a PR comment**

---

## Out of Scope (explicit non-goals)

- DB migration to drop `data_sharing_consent` and `has_seen_beta_welcome` columns — KEEP both columns; just stop reading them
- Rebuilding `/settings` for privacy preferences
- Replacing Jira with Confluence as fallback
- Renaming the `akis-staging-pgdata` external volume (data move = risk pre-defense)
- Production OAuth provider console changes — runbook documents what's needed; Yasir applies them
- Deleting `WizardShell.tsx` (still used by ProfileSetupWizard)
- New features, refactors, or abstractions beyond what's listed

---

## Verification Matrix (run end-to-end after deploy)

| Scenario | Expected outcome |
|---|---|
| Visit `https://akisflow.com/auth/welcome-beta` directly | catchall → `/` (landing) |
| Visit `https://akisflow.com/auth/privacy-consent` directly | catchall → `/` (landing) |
| Brand-new user signs up via Google OAuth | `provider grant → /auth/oauth/google/callback (200, Set-Cookie) → /chat` |
| Brand-new user signs up via GitHub OAuth | Same, GitHub provider |
| Existing user logs in via Google | `/chat` |
| Existing user logs in via email/password | `/login → /login/password → /chat` |
| Brand-new user signs up via email/password | `/signup → /signup/password → /signup/verify-email → /chat` |
| User accepts an invite | `/auth/invite/:token → /chat` |
| Visit landing page | Truthful claims; no `/pricing` dead links; FSMVÜ thesis attribution present |
| Visit `staging.akisflow.com` directly | Caddy 301 → `https://akisflow.com` (graceful degradation) |
| User A creates pipeline; user B `GET /api/pipelines` | A's pipeline NOT in B's list |
| User B `GET /api/pipelines/<A's id>` | 403 or 404 |
| Trigger pipeline with Jira opt-in (manual) | Epic created, Proto comment appended, Trace comment appended; if Jira down, structured warn log + pipeline still completes |

---

## Self-Review Notes

- **Spec coverage:** Phase 0 (diagnostic), Phase A-C (auth bug fix per user diagnosis: cookie + provider URL + dropping onboarding gate), Phase B (page deletions including the missed WelcomeWizard, EmptyState surgical clean, all 5 prod-smoke files, helpers/mock-dashboard-apis, auth-deep-links), Phase D (i18n cleanup including `tech.ecosystem.akis.description` and `tech.evolution.t5.desc`), Phase E (Jira tests + logging), Phase F (staging removal across all 5 Caddyfiles, both TraceAgent files, templates.ts, auth.invite.ts, health.ts, 5 test fixtures, devops/, docs/), Phase H (account isolation audit + e2e). All user corrections from the rev request mapped.
- **No placeholders.** Every code snippet, command, file path, and test body is concrete.
- **WizardShell preserved** — ProfileSetupWizard.tsx still uses it; rev-request asserted orphan-status was wrong (verified via grep).
- **Canonical TraceAgent verified** — pipeline path `backend/src/pipeline/agents/trace/` is canonical; legacy `backend/src/agents/trace/` only referenced by `core/agents/registry.ts`. Plan's F5 includes a verification step before deletion.
- **Working style:** worktree (using-git-worktrees), subagent-driven (subagent-driven-development), quality gate before each commit, browser smoke via claude-in-chrome MCP, smoke report saved per CLAUDE.md "PR Review + Deploy Smoke" pattern, auth = high-risk → no auto-merge, request user (Yasir) to merge.
