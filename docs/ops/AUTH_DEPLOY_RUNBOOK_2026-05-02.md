# Auth Deploy Runbook — Cookie Domain + OAuth Provider URLs

**Audience:** Yasir (operator)
**Branch:** `worktree-auth-cleanup-staging-removal`
**Created:** 2026-05-02
**Companion docs:** [AUTH_LOOP_DIAGNOSIS_2026-05-02.md](./AUTH_LOOP_DIAGNOSIS_2026-05-02.md)

This runbook captures the manual prod-side steps that the auth-cleanup PR cannot apply automatically (because `deploy/` and `Caddyfile` are git-ignored, and OAuth provider consoles are external systems).

## 1. Set `AUTH_COOKIE_DOMAIN` on the live prod stack

The repo-tracked template `devops/compose/docker-compose.prod.yml:45` already declares:

```yaml
AUTH_COOKIE_DOMAIN: ${AUTH_COOKIE_DOMAIN:-.akisflow.com}
```

But the **live** prod stack uses `deploy/oci/prod/docker-compose.yml` (git-ignored), which is missing this line. Two safe paths:

### Path A (preferred): set the env var only

If `/opt/akis/prod/.env` is the canonical env source for the live compose, just add the var there:

```bash
ssh user@$PROD_HOST
cd /opt/akis/prod
grep -q '^AUTH_COOKIE_DOMAIN=' .env || echo 'AUTH_COOKIE_DOMAIN=akisflow.com' >> .env
docker compose up -d --force-recreate backend
docker compose exec backend env | grep AUTH_COOKIE
```

Expected last line:
```
AUTH_COOKIE_DOMAIN=akisflow.com
```

### Path B: also patch the live docker-compose.yml

If the live compose doesn't read `${AUTH_COOKIE_DOMAIN}` at all (i.e. the env line is absent from the `environment:` block), append it:

```yaml
      AUTH_COOKIE_NAME: ${AUTH_COOKIE_NAME:-akis_session}
      AUTH_COOKIE_SECURE: ${AUTH_COOKIE_SECURE:-true}
      AUTH_COOKIE_SAMESITE: ${AUTH_COOKIE_SAMESITE:-lax}
      AUTH_COOKIE_MAXAGE: ${AUTH_COOKIE_MAXAGE:-604800}
      AUTH_COOKIE_DOMAIN: ${AUTH_COOKIE_DOMAIN:-akisflow.com}   # NEW
```

Restart the backend container after the file change:
```bash
docker compose up -d --force-recreate backend
```

> **Note on the leading dot:** Some sources still recommend `.akisflow.com` (with leading dot) for legacy browser compatibility. Modern browsers (Chrome 80+, Firefox 96+, Safari 13+) treat `.akisflow.com` and `akisflow.com` as equivalent — both attach to apex AND subdomains. Pick one for clarity. The repo template uses `.akisflow.com`; the env var here uses `akisflow.com` (no dot) because it's cleaner and the AKIS unit test asserts the no-dot form.

## 2. Verify OAuth provider callback URLs

The diagnostic identified provider-URL mismatch (e.g. `www.akisflow.com` instead of `akisflow.com`) as the likely root cause. Verify each console:

| Provider | Console | Required redirect URI |
|---|---|---|
| **Google Cloud** | https://console.cloud.google.com/apis/credentials → OAuth 2.0 Client | `https://akisflow.com/auth/oauth/google/callback` |
| **GitHub** | https://github.com/settings/developers → OAuth Apps → AKIS Production | `https://akisflow.com/auth/oauth/github/callback` |
| **Atlassian** | https://developer.atlassian.com/console/myapps/ → OAuth 2.0 (3LO) → AKIS | `https://akisflow.com/api/integrations/atlassian/oauth/callback` |

**Hard rules:**
- No `www.` prefix
- No trailing slash
- HTTPS only
- Lowercase host

If any console has `www.akisflow.com`, change it to apex. After the change, you can leave existing OAuth tokens in place — the change only affects future grants.

## 3. Verify cookie attaches end-to-end

After steps 1 and 2, drive a live OAuth flow on the prod site:

1. Open `https://akisflow.com` in incognito (no existing session)
2. Open DevTools → Network panel, with "Preserve log" ON
3. Click "Login with Google"
4. Complete the Google grant (you, the human, type the password)
5. After Google redirects back, you should land on `/chat` (NOT `/login`)

In the Network panel, find the response to `/auth/oauth/google/callback?code=...`. Its `Set-Cookie` header should look like:

```
Set-Cookie: akis_session=eyJ...; Domain=akisflow.com; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800
```

Then find the next `/auth/me` request (fired by `<ProtectedRoute>` when `/chat` mounts). Its request `Cookie:` header should carry `akis_session=eyJ...`. Response should be 200 with the user object.

Repeat for GitHub login.

## 4. Cookie name reconciliation (informational)

`backend/src/lib/env.ts` defaults to `akis_sid`. The live `deploy/oci/prod/docker-compose.yml` sets `AUTH_COOKIE_NAME: ${AUTH_COOKIE_NAME:-akis_session}`. The repo-tracked `devops/compose/docker-compose.prod.yml:43` defaults to `akis_sid`.

There's drift between the two compose files. Both work in isolation, but the unit test (`backend/test/unit/cookie-domain.test.ts`) validates the cookie domain only — name comparison is out of scope for this PR. **Action: in step 1, add `AUTH_COOKIE_NAME=akis_session` to `/opt/akis/prod/.env` if it's not already pinned, so future restart-recreate cycles are deterministic.**

## 5. Rollback

If after deploy users still hit the loop:

1. Re-run [AUTH_LOOP_DIAGNOSIS_2026-05-02.md](./AUTH_LOOP_DIAGNOSIS_2026-05-02.md) Section "Verification plan" with full DevTools capture.
2. If `Set-Cookie` is correct on the callback response but `Cookie:` header is missing on the next `/auth/me`, the issue is browser-side (probably third-party cookie blocking). Check `chrome://settings/cookies` and try a different browser.
3. If `Set-Cookie` is missing entirely on the callback response, revert `AUTH_COOKIE_DOMAIN` and reopen the bug — there's something else.

## 6. Smoke report deliverable

After step 3 succeeds, save a smoke report at `docs/ops/DEPLOY_SMOKE_<pr-num>_2026-05-02.md` with:
- Before/after screenshots of /login and /chat
- Network panel capture of the OAuth callback `Set-Cookie` header
- Network panel capture of the next `/auth/me` request `Cookie:` header
- Note: account isolation (Phase H) was tested with two browser contexts; results

Link the smoke report as a PR comment per CLAUDE.md "PR Review + Deploy Smoke Otomasyonu".
