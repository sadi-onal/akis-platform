# AKIS Backend API Specification

> ## Özet (TR)
> Bu belge AKIS Platform backend API'sinin tam spesifikasyonunu içerir. ~89 endpoint tanımı,
> istek/yanıt şemaları, hata kodları, kimlik doğrulama gereksinimleri ve rate limit kurallarını
> kapsar. Ajan işleri, kullanıcı yönetimi, OAuth akışları, webhook'lar ve dashboard metrikleri
> dahildir. Tüm teknik detaylar aşağıdaki İngilizce içerikte yer almaktadır.

**Version**: 0.2.0  
**Base URL**: `http://localhost:3000`

## Table of Contents

1. [Health & Meta Endpoints](#health--meta-endpoints)
2. [Agent Jobs API](#agent-jobs-api)
3. [Agent Configs API](#agent-configs-api)
4. [Settings API (AI Keys)](#settings-api-ai-keys)
5. [Authentication](#authentication)
6. [Error Handling](#error-handling)

---

## Health & Meta Endpoints

### GET /health

Health check endpoint (always returns 200 if server is running).

**Response**:
```json
{
  "status": "ok"
}
```

### GET /ready

Readiness check (verifies database connectivity).

**Response (200)**:
```json
{
  "ready": true
}
```

**Response (503)**:
```json
{
  "ready": false,
  "error": "Database not reachable"
}
```

### GET /version

Returns application version from package.json.

**Response**:
```json
{
  "version": "0.2.0"
}
```

### GET /

Root endpoint with application info.

**Response**:
```json
{
  "name": "AKIS Backend",
  "status": "ok"
}
```

---

## Agent Jobs API

Base path: `/api/agents`

### POST /api/agents/jobs

Submit a new agent job.

**Request Body**:
```json
{
  "type": "scribe" | "trace" | "proto",
  "payload": { ... },
  "runtimeOverride": {
    "runtimeProfile": "deterministic" | "balanced" | "creative" | "custom",
    "temperatureValue": 0.0-1.0,
    "commandLevel": 1 | 2 | 3 | 4 | 5
  },
  "requiresStrictValidation": false
}
```

**Payload by Agent Type**:

| Type | Required Fields | Description |
|------|-----------------|-------------|
| `scribe` | `owner` (string), `repo` (string), `baseBranch` (string) | GitHub repository details for documentation updates |
| `trace` | `spec` (string) | Requirements/specification text |
| `proto` | `feature` (string) | Feature description for prototyping |

**Scribe Payload Details**:
```json
{
  "type": "scribe",
  "payload": {
    "owner": "organization-name",
    "repo": "repository-name",
    "baseBranch": "main",
    "targetPath": "docs/",
    "dryRun": true
  }
}
```

Optional fields for Scribe:
- `targetPath`: Directory or file path (default: "README.md")
- `dryRun`: Preview mode without actual commits (default: false)
- `featureBranch`: Custom branch name for changes
- `taskDescription`: Specific documentation task description

**Response (200)**:
```json
{
  "jobId": "uuid-string",
  "state": "pending" | "running" | "completed" | "failed"
}
```

**Response (400)** - Invalid payload:
```json
{
  "error": "Validation failed",
  "details": [...]
}
```

**Response (412)** - Missing AI key for Scribe:
```json
{
  "error": {
    "code": "AI_KEY_MISSING",
    "message": "AI API key is not configured for provider openai. Please add a key in Settings."
  }
}
```

**Response (400)** - Model not allowlisted:
```json
{
  "error": {
    "code": "MODEL_NOT_ALLOWED",
    "message": "Model \"gpt-xyz\" is not allowed.",
    "details": { "allowlist": ["gpt-4o-mini", "gpt-4o"] }
  }
}
```

### GET /api/agents/jobs/:id

Get job status and result.

**Parameters**:
- `id` (path) - Job UUID

**Response (200)**:
```json
{
  "id": "uuid-string",
  "type": "scribe",
  "state": "completed",
  "effectiveRuntime": {
    "runtimeProfile": "deterministic",
    "temperatureValue": null,
    "commandLevel": 2,
    "allowCommandExecution": false,
    "settingsVersion": 1
  },
  "payload": { ... },
  "result": { ... },
  "error": null,
  "errorCode": null,
  "errorMessage": null,
  "aiProvider": "openai",
  "aiModel": "gpt-4o-mini",
  "aiTotalDurationMs": 12345,
  "aiInputTokens": 1200,
  "aiOutputTokens": 850,
  "aiTotalTokens": 2050,
  "aiEstimatedCostUsd": "0.001234",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:01.000Z"
}
```

**Response (404)**:
```json
{
  "error": "Job not found"
}
```

### POST /api/agents/jobs/:id/cancel

Cancel a running or pending job (S2.0.2).

**Parameters**:
- `id` (path) - Job UUID

**Response (200)**:
```json
{
  "id": "uuid-string",
  "state": "failed",
  "message": "Job cancelled successfully"
}
```

**Response (409)** - Cannot cancel (invalid state):
```json
{
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "Cannot cancel job in completed state",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "path": "/api/agents/jobs/:id/cancel"
  }
}
```

**Response (404)**:
```json
{
  "error": "Job not found"
}
```

### GET /api/agents/jobs

List all jobs (paginated).

**Query Parameters**:
- `limit` (optional, default: 50) - Max results
- `offset` (optional, default: 0) - Skip count
- `type` (optional) - Filter by agent type
- `state` (optional) - Filter by state

**Response (200)**:
```json
{
  "jobs": [...],
  "total": 100,
  "limit": 50,
  "offset": 0
}
```

---

## Agent Configs API

Base path: `/api/agents/configs`

### GET /api/agents/configs/:agentType

Fetch the authenticated user's agent configuration and integration status.

**Response (200)**:
```json
{
  "config": { ... },
  "integrationStatus": {
    "github": { "connected": true },
    "confluence": { "connected": false }
  }
}
```

### POST /api/agents/configs/:agentType

Upsert configuration (per-user).

**Response (200)**:
```json
{
  "config": { ... },
  "message": "Configuration saved successfully"
}
```

### GET /api/agents/configs/:agentType/models

Return allowlisted models for the agent (Scribe only).

**Response (200)**:
```json
{
  "allowlist": ["gpt-4o-mini", "gpt-4o"],
  "defaultModel": "gpt-4o-mini"
}
```

---

## Settings API (AI Keys)

Base path: `/api/settings`

AKIS supports multiple AI providers (OpenAI, OpenRouter). Keys are encrypted using AES-256-GCM before storage. **Plaintext keys are never returned or logged.**

### GET /api/settings/ai-keys/status

Return multi-provider status including active provider selection.

**Response (200)**:
```json
{
  "activeProvider": "openai",
  "canUseOwnKey": true,
  "keySource": "own",
  "providers": {
    "openai": {
      "configured": true,
      "last4": "abcd",
      "updatedAt": "2025-01-01T12:00:00.000Z"
    },
    "openrouter": {
      "configured": false,
      "last4": null,
      "updatedAt": null
    }
  },
  "plan": { "tier": "free", "name": "Free", "jobsPerDay": 3, "maxTokenBudget": 100000 },
  "usage": { "jobsUsedToday": 0, "tokensUsedThisMonth": 0, "jobsLimit": 3, "tokensLimit": 100000 }
}
```

`canUseOwnKey` is `true` for all authenticated users (users may supply their own provider API keys on any plan).

### GET /api/settings/integrity-metrics

Returns Knowledge Integrity metrics derived from `agent_activities`, pipeline outputs, and Trace data.

**Response (200)** includes:
- `avgSpecCompliance`, `assumptionStats`, `confidenceTrend`, `criteriaStats`
- `hasMeaningfulData` — `false` when there is not enough real signal to show KPIs (synthetic compliance values are not used)
- `dataQuality`: `none` | `partial` | `good`
- `reasons` — machine-readable hints when `hasMeaningfulData` is `false` (e.g. `NO_AGENT_OR_TRACE_SIGNAL`)

**Pipeline `traceOutput` reference (stored on pipeline records, not this endpoint):** when Trace pushes generated tests to a target repo, it may also add `.github/workflows/akis-e2e.yml` (Playwright on GitHub Actions; optional Cucumber if `features/**/*.feature` exists). The merge step only skips when that exact file is already in the batch — other workflow YAML files do not block it. The tool-use (agentic) `push_files` path applies the same merge before each push. The pipeline JSON may then include optional `traceOutput.ciWorkflowPath` set to that path for UI/docs linking.

**Unified agent context:** Proto and Trace receive a single bundled `knowledgeContext` built server-side: **session brief**, **approved specification block** (when present — canonical contract), Scribe plan hint, **chronological transcript** (including `user_note`), attachments, optional `repoContext` (GitHub tree + summary), and repo URLs. **Smart truncation** keeps the start and end of a long transcript; **role-specific instructions** (`proto` vs `trace`) are appended so models know how to weigh chat vs spec. Default budget ~32k characters.

### PUT /api/settings/ai-keys

Store/update an API key for a specific provider. Key is encrypted server-side and only last 4 characters are stored for identification.

**Request Body**:
```json
{
  "provider": "openai" | "openrouter",
  "apiKey": "sk-..."
}
```

**Response (200)**:
```json
{
  "provider": "openai",
  "configured": true,
  "last4": "abcd",
  "updatedAt": "2025-01-01T12:00:00.000Z"
}
```

**Errors**:
- `400 Bad Request`: Invalid provider or empty key
- `401 Unauthorized`: Missing or invalid session

### PUT /api/settings/ai-provider/active

Set the active AI provider to use for agent jobs.

**Request Body**:
```json
{
  "provider": "openai" | "openrouter"
}
```

**Response (200)**:
```json
{
  "activeProvider": "openai",
  "providers": {
    "openai": { "configured": true, "last4": "abcd", "updatedAt": "..." },
    "openrouter": { "configured": false, "last4": null, "updatedAt": null }
  }
}
```

**Errors**:
- `400 Bad Request`: Provider not configured (no key saved)

### DELETE /api/settings/ai-keys

Remove the user's key for a specific provider.

**Request Body**:
```json
{
  "provider": "openai" | "openrouter"
}
```

**Response (200)**:
```json
{ "ok": true }
```

**Notes**:
- If the deleted key belongs to the active provider, `activeProvider` is set to `null`
- User must configure a new key before running agent jobs

---

## GitHub PAT API (`/api/github`)

Legacy/PAT-backed routes used by Engineer and repo tooling. OAuth-based GitHub lives under `/api/integrations/github/*`.

### GET /api/github/repos

**Errors**:
- `401 Unauthorized`: Missing or invalid AKIS session
- `403 Forbidden`: `{ "error": { "code": "GITHUB_NOT_CONNECTED", "message": "GitHub not connected" } }` when no GitHub token is stored for the user. **Not** a session expiry — clients must not map this to “logout”.

### POST /api/github/repos

Same `GITHUB_NOT_CONNECTED` shape as above when GitHub is not connected.

### GET /api/github/repos/:owner/:repo/context

Same `GITHUB_NOT_CONNECTED` shape as above when GitHub is not connected.

---

## Authentication

AKIS uses a **multi-step authentication flow** for improved UX and security. All auth endpoints return consistent error formats.

### Current (Single-Step – Legacy, deprecated)

These endpoints are kept for backward compatibility but will be removed in a future version.

#### POST /auth/signup

Single-step signup (deprecated).

**Request Body**:
```json
{
  "name": "User Name",
  "email": "user@example.com",
  "password": "password123"
}
```

**Response (201)**:
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "User Name"
}
```

**Errors**:
- `409 Conflict`: `{ "error": "Email in use" }`

#### POST /auth/login

Single-step login (deprecated).

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response (200)**:
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "User Name"
}
```

**Errors**:
- `401 Unauthorized`: `{ "error": "Invalid credentials" }`

---

### Multi-Step Sign Up (New Flow)

#### POST /auth/signup/start

**Step 1: Name + Email**

Creates a new user in `PENDING_VERIFICATION` state and sends a 6-digit verification code.

**Request Body**:
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john.doe@example.com"
}
```

**Response (201)**:
```json
{
  "userId": "uuid",
  "email": "john.doe@example.com",
  "message": "Verification code sent to your email",
  "status": "pending_verification"
}
```

**Errors**:
- `400 Bad Request`: Invalid email format
- `409 Conflict`: `{ "error": "Email already registered" }`

**Notes**:
- Verification code is 6 digits, valid for 15 minutes
- Dev mode: Code logged to console
- Prod mode: Code sent via email (SendGrid)

---

#### POST /auth/signup/password

**Step 2: Set Password**

Sets the password for a user in `PENDING_VERIFICATION` state.

**Request Body**:
```json
{
  "userId": "uuid",
  "password": "securePassword123"
}
```

**Response (200)**:
```json
{
  "ok": true,
  "message": "Password set successfully"
}
```

**Errors**:
- `400 Bad Request`: Password < 8 characters
- `404 Not Found`: `{ "error": "User not found" }`
- `403 Forbidden`: `{ "error": "User already verified" }`

---

#### POST /auth/verify-email

**Step 3: Verify Email Code**

Verifies the 6-digit code and activates the user account.

**Request Body**:
```json
{
  "userId": "uuid",
  "code": "123456"
}
```

**Response (200)**:
```json
{
  "user": {
    "id": "uuid",
    "email": "john.doe@example.com",
    "name": "John Doe",
    "status": "active"
  },
  "token": "jwt-token",
  "message": "Email verified successfully"
}
```

**Sets Cookie**: `akis_session` with JWT (HTTP-only, 7 days)

**Errors**:
- `400 Bad Request`: `{ "error": "Invalid or expired code" }`
- `404 Not Found`: `{ "error": "User not found" }`
- `429 Too Many Requests`: `{ "error": "Too many attempts. Wait 15 minutes." }`

**Rate Limit**: 3 attempts per 15 minutes per user

---

#### POST /auth/resend-code

Resends verification code.

**Request Body**:
```json
{
  "userId": "uuid"
}
```

**Response (200)**:
```json
{
  "ok": true,
  "message": "Verification code resent"
}
```

**Errors**:
- `404 Not Found`: User not found
- `403 Forbidden`: User already verified
- `429 Too Many Requests`: Max 3 resends per 15 minutes

---

### Multi-Step Sign In (New Flow)

#### POST /auth/login/start

**Step 1: Email Check**

Validates if user exists and returns user info (without sensitive data).

**Request Body**:
```json
{
  "email": "john.doe@example.com"
}
```

**Response (200)**:
```json
{
  "userId": "uuid",
  "email": "john.doe@example.com",
  "requiresPassword": true,
  "status": "active"
}
```

**Errors**:
- `404 Not Found`: `{ "error": "No account found with this email" }`
- `403 Forbidden`: `{ "error": "Email not verified", "userId": "uuid" }` (redirects to verification)

---

#### POST /auth/login/complete

**Step 2: Password Verification**

Verifies password and issues JWT session.

**Request Body**:
```json
{
  "userId": "uuid",
  "password": "securePassword123"
}
```

**Response (200)**:
```json
{
  "user": {
    "id": "uuid",
    "email": "john.doe@example.com",
    "name": "John Doe"
  },
  "needsDataSharingConsent": false
}
```

**Sets Cookie**: `akis_session` with JWT

**Errors**:
- `401 Unauthorized`: `{ "error": "Incorrect password" }`
- `404 Not Found`: `{ "error": "User not found" }`
- `429 Too Many Requests`: `{ "error": "Too many attempts" }` (5 per 15min)

**Notes**:
- `needsDataSharingConsent: true` if user hasn't seen consent screen yet (frontend redirects to `/auth/privacy-consent`)

---

### User Preferences

#### POST /auth/update-preferences

Updates user consent and preferences.

**Request Body**:
```json
{
  "dataSharingConsent": true,
  "hasSeenBetaWelcome": true
}
```

**Headers**:
- `Cookie: akis_session=<jwt>`

**Response (200)**:
```json
{
  "ok": true
}
```

**Errors**:
- `401 Unauthorized`: Invalid or missing token

---

### Session Management

#### POST /auth/logout

Clears session cookie.

**Headers**:
- `Cookie: akis_session=<jwt>` (optional)

**Response (200)**:
```json
{
  "ok": true
}
```

**Clears Cookie**: `akis_session` (maxAge=0)

---

#### GET /auth/me

Get current authenticated user.

**Headers**:
- `Cookie: akis_session=<jwt>`

**Response (200)**:
```json
{
  "id": "uuid",
  "email": "john.doe@example.com",
  "name": "John Doe",
  "status": "active",
  "emailVerified": true,
  "dataSharingConsent": true,
  "hasSeenBetaWelcome": true
}
```

**Errors**:
- `401 Unauthorized`: `{ "user": null }` (invalid/expired token)

---

### OAuth (Future – S0.4.2)

#### GET /auth/oauth/:provider

Initiates OAuth flow (redirects to provider).

**Params**:
- `provider`: `google` | `github` | `apple`

**Response**: `302 Redirect` to provider's OAuth consent screen

**Example**:
```
GET /auth/oauth/google
→ Redirects to https://accounts.google.com/o/oauth2/v2/auth?...
```

---

#### GET /auth/oauth/:provider/callback

Handles OAuth callback from provider.

**Query Params**:
- `code`: Authorization code from provider
- `state`: CSRF token (optional)

**Response**: `302 Redirect` to `/dashboard` with session cookie set

**Errors**:
- `400 Bad Request`: `{ "error": "Invalid OAuth code" }`
- `409 Conflict`: `{ "error": "Email already linked to another account" }`

---

### Auth Error Response Format

All auth errors follow this structure:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": {}
}
```

**Common Error Codes**:

| Code | HTTP | Description |
|------|------|-------------|
| `EMAIL_IN_USE` | 409 | Email already registered |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `EMAIL_NOT_VERIFIED` | 403 | User must verify email first |
| `INVALID_CODE` | 400 | Verification code wrong/expired |
| `TOO_MANY_ATTEMPTS` | 429 | Rate limit exceeded |
| `UNAUTHORIZED` | 401 | Missing or invalid token |
| `USER_NOT_FOUND` | 404 | User doesn't exist |
| `USER_DISABLED` | 403 | Account suspended |

---

## Conversations API (S0.5.4)

Conversation endpoints provide backend-persistent threads, messages, plan candidates, and trust snapshots for Agents Hub.

### Thread Status
- `active`
- `awaiting_user_input`
- `awaiting_plan_selection`
- `queued`
- `completed`
- `failed`

### Plan Candidate Status
- `unbuilt`
- `queued`
- `building`
- `built`
- `failed`

### Endpoints
- `POST /api/conversations/threads`
- `GET /api/conversations/threads`
- `GET /api/conversations/threads/:threadId`
- `POST /api/conversations/threads/:threadId/messages`
- `GET /api/conversations/threads/:threadId/messages`
- `GET /api/conversations/threads/:threadId/stream` (SSE)
- `GET /api/conversations/threads/:threadId/plans`
- `POST /api/conversations/threads/:threadId/plans/generate`
- `POST /api/conversations/threads/:threadId/plans/:planId/generate-alternatives`
- `POST /api/conversations/threads/:threadId/plans/build`
- `POST /api/conversations/tasks/:taskId/respond`
- `GET /api/conversations/threads/:threadId/trust-snapshots`
- `POST /api/conversations/threads/:threadId/trust-snapshots`

### Build Guardrail
- Per user maximum active run limit: `3`
- When limit is exceeded, plan build request is queued with `status: queued`

---

## Error Handling

All errors follow a consistent format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": { ... }
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid request payload |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Rate Limiting

- Default: 100 requests per minute per IP
- Configurable via `RATE_LIMIT_MAX` environment variable
- Returns `429 Too Many Requests` when exceeded

## CORS

- Allowed origins configurable via `CORS_ORIGINS` environment variable
- Default: `http://localhost:5173` (development)

---

## Metrics

### GET /metrics

Prometheus metrics endpoint.

**Response**: Text format (Prometheus exposition format)

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/health",status="200"} 42
...
```
