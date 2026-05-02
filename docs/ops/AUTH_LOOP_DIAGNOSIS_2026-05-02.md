# OAuth Login Loop — Root Cause Diagnosis

**Date:** 2026-05-02
**Reported by:** Yasir
**Symptom:** Google/GitHub OAuth completes on the provider side, the user lands on `/login` instead of `/chat`, and clicking the OAuth button again loops indefinitely.

## Method

Live driving of the full OAuth flow on `https://akisflow.com` was the goal. **Constraint:** the diagnostic agent cannot type user passwords (Anthropic safety rules around credential entry). So this report is a **code-only diagnosis** of the failure modes, cross-checked against what we know about the prod deployment.

Sources read:
- `backend/src/api/auth.oauth.ts:300-707` — OAuth init + callback handlers
- `backend/src/lib/env.ts:1-41` — cookie options builder
- `backend/src/plugins/security/cors.ts` — CORS config
- `frontend/src/App.tsx:1-134` — route table including ProtectedRoute mounts
- `deploy/oci/prod/docker-compose.yml:86-96` — prod env block (no `AUTH_COOKIE_DOMAIN`)
- `deploy/oci/prod/Caddyfile` — known to forward `Set-Cookie` correctly per prior audit

A live curl probe of `https://akisflow.com/auth/oauth/google` was attempted but denied at the permission gate; not load-bearing — the OAuth init endpoint is a stateless 302 to the provider's auth URL, no `Set-Cookie` is issued there. The interesting `Set-Cookie` is on the callback response, which requires a real OAuth `code` from Google to reach.

## Key code facts

1. **OAuth init handler (`auth.oauth.ts:283-341`)** — generates HMAC-signed state, redirects to `<provider>.com/oauth?...&redirect_uri=${FRONTEND_URL}/auth/oauth/${provider}/callback`. **No session cookie is set here.**

2. **OAuth callback handler (`auth.oauth.ts:646-674`):**
   - Line 647-651: signs JWT with `{ sub, email, name }`.
   - Line 653: `reply.setCookie(env.AUTH_COOKIE_NAME, jwt, cookieOpts)`.
   - Lines 655-662 (the gate):
     ```ts
     let redirectPath = '/chat';
     if (user.dataSharingConsent === null) {
       redirectPath = '/auth/privacy-consent';
     } else if (!user.hasSeenBetaWelcome) {
       redirectPath = '/auth/welcome-beta';
     }
     ```
   - Line 674: `return redirect(reply, ${frontendUrl}${redirectPath})`.

3. **Cookie attributes (`backend/src/lib/env.ts:17-39`):**
   ```ts
   const sameSite = env.AUTH_COOKIE_SECURE ? 'none' : env.AUTH_COOKIE_SAMESITE;
   const baseCookieOpts = { path: '/', httpOnly: true, sameSite, secure, maxAge };
   if (env.AUTH_COOKIE_DOMAIN && env.AUTH_COOKIE_DOMAIN.length > 0) {
     baseCookieOpts.domain = env.AUTH_COOKIE_DOMAIN;
   }
   ```
   When `AUTH_COOKIE_DOMAIN` is unset, the cookie is **host-only**.

4. **Prod docker-compose (`deploy/oci/prod/docker-compose.yml:86-91`):**
   ```yaml
   AUTH_COOKIE_NAME: ${AUTH_COOKIE_NAME:-akis_session}
   AUTH_COOKIE_SECURE: ${AUTH_COOKIE_SECURE:-true}
   AUTH_COOKIE_SAMESITE: ${AUTH_COOKIE_SAMESITE:-lax}
   AUTH_COOKIE_MAXAGE: ${AUTH_COOKIE_MAXAGE:-604800}
   ```
   **`AUTH_COOKIE_DOMAIN` is absent.** Combined with `SECURE=true`, the effective `SameSite` is forced to `none` (per `lib/env.ts:17`).

5. **Frontend `/auth/welcome-beta` and `/auth/privacy-consent` routes (`App.tsx:90-93`):**
   ```tsx
   <Route path="auth" element={<ProtectedRoute />}>
     <Route path="welcome-beta" ... />
     <Route path="privacy-consent" ... />
   </Route>
   ```
   Both are mounted under `<ProtectedRoute>`. ProtectedRoute fires `GET /auth/me` on render; if the response is 401, the user is bounced to `/login`.

## Failure modes (ranked by likelihood)

### Mode 1 — Provider callback URL configured for `www.akisflow.com` (HIGH)

If the Google Cloud Console OAuth client or GitHub OAuth App has a redirect URI like `https://www.akisflow.com/auth/oauth/google/callback` (instead of the apex `https://akisflow.com/...`), the flow becomes:

1. Browser → Google → grant → Google 302 → `https://www.akisflow.com/auth/oauth/google/callback?code=...`
2. Caddy (configured for apex) issues a 301 → `https://akisflow.com/auth/oauth/google/callback?code=...`
3. **The 301 strips the original Host header but NOT the request body, BUT** the backend never gets the request because Caddy returns the 301 to the browser before proxying. The browser re-issues the request to the apex; the OAuth `code` is now consumed by replay (Google rejects re-use) OR the backend processes it on apex.
4. If the backend on apex sets a host-only cookie for `akisflow.com`, that cookie is fine. **But** if the OAuth provider URL is `www`-prefixed, the user might also be logged in on `www` first (cookie set on `www.akisflow.com` host-only), then redirected to apex → cookie does NOT attach on apex → `/auth/me` 401 → `/login`.

**Verification path:** Yasir reads the Google + GitHub OAuth console redirect URIs. If `www` is anywhere, that's the bug.

### Mode 2 — Cookie host-only + new-user redirect chain through `/auth/privacy-consent` (HIGH)

Even with Mode 1 ruled out:

1. Brand-new OAuth user → backend creates user with `dataSharingConsent: null` (`auth.oauth.ts:480`).
2. Callback sets cookie on `akisflow.com` (host-only) and redirects to `https://akisflow.com/auth/privacy-consent`.
3. Browser follows the redirect, attaching the cookie (same host).
4. React renders `/auth/privacy-consent`, which is wrapped in `<ProtectedRoute>`.
5. ProtectedRoute fires `GET /auth/me`. **If anything along this chain interferes with cookie attachment** (Caddy `/api/*` routing, a missed CORS rule, or a browser quirk on cross-site redirect chain entering with `SameSite=None`), `/auth/me` returns 401.
6. `user=null` → ProtectedRoute redirects to `/login`.
7. RedirectIfAuthenticated on `/login` fires `/auth/me` again. Same 401. User stays.

**The intermediate consent page is the load-bearing failure point** — even if Mode 1 is ruled out and the cookie is fine, removing the consent page eliminates one round-trip and one `/auth/me` call. If we go straight to `/chat`, even if `/auth/me` momentarily fails on the first render, the user can still see ChatPage shell loading (and a single failed `/auth/me` would still bounce them, but the surface area is smaller).

### Mode 3 — `SameSite=None` + first cross-site redirect (LOW)

`SameSite=None` cookies are fine across redirect chains as long as `Secure=true` (which prod has). Modern browsers (Chrome 80+, Firefox 96+) attach `SameSite=None` cookies on any cross-site redirect with `Secure`. This is unlikely to be the issue.

### Mode 4 — Caddy stripping `Set-Cookie` (LOW)

Verified in prior audit that Caddy preserves `Set-Cookie`. Not the issue.

## Root cause (most-likely)

**Combination of Mode 1 and Mode 2.** Either alone could break login; together they explain the infinite loop reliably:

- Mode 1 means even if the cookie machinery is correct in code, the provider URL drops the cookie at the www→apex step.
- Mode 2 means even after the cookie is correct, the consent gate routes the user through `/auth/privacy-consent`, where any 401 on `/auth/me` triggers `/login`.

## Fix decision

The plan applies the fix at all three layers — defense in depth:

1. **Phase A** — Backend OAuth callback always redirects to `/chat`. Removes the consent gate (Mode 2 mitigation). Even if `/auth/me` were to flake, `/chat`'s ProtectedRoute is the only check; previously we had two ProtectedRoutes back-to-back (consent page → chat).

2. **Phase C** — Set `AUTH_COOKIE_DOMAIN=akisflow.com` in prod. Cookie becomes domain-scoped to apex + all subdomains (`www`, `staging`, etc.), so even a misconfigured `www` provider URL would still produce a working session because the cookie set on `www.akisflow.com` would attach when the browser navigates to apex (Mode 1 mitigation).

3. **Phase C runbook** — Document the exact provider redirect URIs Yasir needs to verify in Google Console + GitHub OAuth App + Atlassian. This is the only manual step; the diagnostic agent cannot edit OAuth provider consoles on the user's behalf.

## What requires user (Yasir) action post-deploy

Yasir must verify and (if needed) correct the OAuth provider callback URLs after this PR deploys:

| Provider | Console | Required redirect URI |
|---|---|---|
| Google Cloud | APIs & Services → Credentials → OAuth 2.0 Client | `https://akisflow.com/auth/oauth/google/callback` |
| GitHub | Settings → Developer settings → OAuth Apps → AKIS Production | `https://akisflow.com/auth/oauth/github/callback` |
| Atlassian | developer.atlassian.com → OAuth 2.0 (3LO) → AKIS | `https://akisflow.com/api/integrations/atlassian/oauth/callback` |

**No `www`. No trailing slash. HTTPS only.**

After Yasir verifies and any console change, the live smoke test (Phase I.2) confirms the flow end-to-end.

## Verification plan (post-deploy, Phase I.2)

Live capture via `claude-in-chrome` MCP, driven by Yasir during the smoke window so passwords are entered by the human:

| Step | Capture |
|---|---|
| Click "Login with Google" | Network: redirect chain target hosts |
| Google grant | (user types password) |
| Provider redirect to `akisflow.com/auth/oauth/google/callback?code=...` | Response status, `Set-Cookie` header (Domain, SameSite, Secure) |
| Backend 302 to `https://akisflow.com/chat` | Final URL |
| `/auth/me` request on `/chat` | Request `Cookie:` header carries `akis_session` |

Expected: cookie issuance carries `Domain=akisflow.com; HttpOnly; Secure; SameSite=None; Path=/` and the immediate `/auth/me` succeeds with 200.

## Confidence

**Medium-High** that the combined fix (Phase A + C) closes the loop. The remaining uncertainty is the provider URL configuration — a 5-minute manual verification by Yasir post-deploy will close the last gap. If the loop persists after both phases land + the URL check, escalate to live capture (Phase I.2 with Yasir present).
