# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

AKIS Platform — an AI agent orchestration engine. Three sequential agents drive the pipeline: **Scribe** (idea → spec) → human gate → **Proto** (spec → code) → **Trace** (code → tests). The "verification chain" between stages (specs human-approved, code tested by Trace, tests run automatically) is the platform's core design principle — preserve it when refactoring.

Two-package monorepo, **not** a `pnpm` workspace — root `package.json` only has `@playwright/test` / `puppeteer` for top-level e2e. Use `pnpm -C backend` / `pnpm -C frontend` to scope commands; never `pnpm install` from the root expecting workspace resolution.

- `backend/` — Fastify 4 + TypeScript (strict) + Drizzle ORM + PostgreSQL 16. Pino structured logs.
- `frontend/` — React 19 + Vite 7 + Tailwind v4 SPA. Vitest unit, Playwright e2e.
- `scripts/` — dev/prod orchestration. **Always prefer these over hand-rolled commands** (they handle port conflicts, migrations, log routing).
- `docs/` — architecture, API spec, runbooks. `docs/openapi.yaml` is the source of truth for API shape; frontend regenerates types from it via `pnpm -C frontend generate:types`.

## Common commands

### Local dev (preferred path)
```bash
./scripts/dev-up.sh        # Docker Postgres + Adminer + backend (:3000) + frontend (:5173) in background
./scripts/dev-logs.sh      # Tail both, pino-pretty for backend, prefixed [BE]/[FE]
./scripts/dev-down.sh      # Stop everything
```
`dev-up.sh` kills any stale process on `:3000`/`:5173` first — needed because previously-spawned backends keep holding the port with their old env, making env edits look inert.

### Backend (`pnpm -C backend`)
```bash
pnpm -C backend dev            # tsx watch
pnpm -C backend typecheck      # tsc --noEmit
pnpm -C backend lint           # eslint .
pnpm -C backend test           # unit only (skips MCP/DB tests)
pnpm -C backend test:unit      # NODE_ENV=test, SKIP_MCP_TESTS=true SKIP_DB_TESTS=true, node --test
pnpm -C backend test:integration   # hits real DB, no skip flags
pnpm -C backend test:ci        # unit + integration, only SKIP_MCP_TESTS
pnpm -C backend test:mcp       # MCP gateway integration only
pnpm -C backend db:generate    # drizzle-kit generate (after schema edit)
pnpm -C backend db:migrate     # apply migrations
pnpm -C backend db:studio      # drizzle-kit studio
```
Run a single backend test: `pnpm -C backend exec tsx --test test/unit/<file>.test.ts` (uses node's built-in test runner — no jest/vitest in backend).

### Frontend (`pnpm -C frontend`)
```bash
pnpm -C frontend dev           # vite, :5173
pnpm -C frontend typecheck     # tsc --noEmit
pnpm -C frontend lint
pnpm -C frontend test          # vitest --run
pnpm -C frontend test:e2e      # playwright (backend must be on :3000)
pnpm -C frontend generate:types    # regen OpenAPI types from http://localhost:3000/openapi.json
```

### Production / staging
`docker-compose.yml` runs Postgres + backend + Caddy. Production is currently **dormant** (see `docs/ops/` runbook before bringing it back up). `./scripts/prod-db-reset.sh` exists — destructive, never run unless explicitly told.

## Backend architecture notes

Two layers of "agents" coexist — easy to confuse:

- `backend/src/agents/{scribe,trace,proto}` — the legacy single-agent endpoints (Plan → Execute → Reflect → Validate per agent). Each is a self-contained module.
- `backend/src/pipeline/` — the **newer** orchestrator coordinating the full Scribe→Proto→Trace pipeline as a state machine. Has its own `adapters/`, `agents/`, `api/`, `db/`, `services/`, `templates/`. Pipeline-level changes go here.

`backend/src/api/` is the public HTTP surface (Fastify routes registered in `index.ts`). Anything user-facing — auth, conversations, agent-configs, billing webhooks, dashboard-metrics, etc. — is wired here. `server.ts` boots, `server.app.ts` builds the app (testable via Fastify `inject`).

`backend/src/services/` holds domain services consumed by routes and pipeline: `ai/` (provider abstraction over OpenRouter/OpenAI/mock), `mcp/` (GitHub MCP gateway client), `auth/`, `billing/` (Stripe), `embedding/`, `rag/`, `knowledge/`, `quality/`, `checks/` (lint/typecheck-as-tool for reflection).

`AI_PROVIDER` env switches between `openrouter | openai | mock` — `mock` is the path to use during dev when you don't want to burn credits. Three model slots: `AI_MODEL_PLANNER`, `AI_MODEL_DEFAULT`, `AI_MODEL_VALIDATION` (different strengths per phase).

GitHub MCP is **required for Scribe to function**. Either run the local Docker gateway (`./scripts/mcp-up.sh` if present, with `GITHUB_TOKEN`) and point `GITHUB_MCP_BASE_URL` at it, or use the remote hosted endpoint. Tests gate this behind `SKIP_MCP_TESTS=true`.

## Database / migrations

Drizzle schema lives in `backend/src/db/`, generated SQL in `backend/migrations/`. Schema-drift symptom: backend logs `column "X" does not exist` and job creation 500s with `DATABASE_ERROR`. Fix: `pnpm -C backend db:migrate`. **Always** generate + apply locally before committing schema changes — frontends and tests assume HEAD migration state.

## Environment

`backend/.env` is required for `dev-up.sh`. **Do not set `NODE_ENV` in `.env`** — scripts override it (`dev` → development, `test` → test). Setting it in `.env` causes validation failures.

## Testing posture

Backend: node's built-in test runner (`node --test`) via `tsx`. Three skip flags control what runs:
- `SKIP_MCP_TESTS=true` — skip GitHub MCP integration
- `SKIP_DB_TESTS=true` — skip tests requiring live Postgres

The default `pnpm -C backend test` skips both (unit-only, fast). Use `test:integration` or `test:ci` when DB is up.

Frontend: Vitest for components/hooks, Playwright for e2e. Playwright assumes backend at `http://localhost:3000`.

## Level-4 explainability surface (added v0.7.0)

Per-stage reasoning is the user-visible side of `pipeline/core/explainability/`. Two pieces work together:

- **Backend factories** (`pipeline/core/explainability/reasoningFactory.ts`) — pure builders that turn `ScribeOutput` / `ProtoOutput` / `TraceOutput` / `CriticReviewOutput` into `AgentReasoning`. Orchestrator's private helpers (`recordScribeReasoning`, `recordProtoReasoning`, `recordTraceReasoning`) just delegate; testable in isolation.
- **Frontend rail** (`frontend/src/components/pipeline/PipelineDetailRail.tsx`) — collapsible tab between ChatHeader and messages. Auto-expands at active/awaiting_approval, shows `PipelineCinema` (4-column) on the Akış tab and `ExplanationPanel` (per-stage reasoning cards) on the Açıklama tab. Compact + manual collapse supported.

When you add a new agent (or a new stage of an existing one), the wiring is:
1. Add a `buildXReasoning` factory function next to the existing four.
2. Call `this.explainability.addReasoning(pipelineId, buildXReasoning(output))` from the orchestrator at the success path.
3. If the new stage should appear as a column in cinema, extend `PipelineActivity['stage']` and the `STAGE_ORDER` in `PipelineCinema`. Otherwise emit activity events with one of the existing `stage` values.

The route `GET /api/pipelines/:id/explanation` returns the full `PipelineExplanation` (stages + narrative + attentionPoints). Mounted in `pipeline.plugin.ts`. Auth uses the same cookie as everywhere else.

## Local dev env quick-start (was missing in v0.6.x checkouts)

If `./scripts/dev-up.sh` complains about missing `backend/.env` or `docker-compose.dev.yml`:

- `cp backend/.env.example backend/.env` and fill `AUTH_JWT_SECRET=$(openssl rand -hex 32)`. `AI_PROVIDER=mock` is fine for local dev.
- The dev compose file (`docker-compose.dev.yml`) ships in v0.7+. It uses `pgvector/pgvector:pg16` because backend migrations require the `vector` extension — vanilla `postgres:16-alpine` will fail at migration time with `extension "vector" is not available`.
- After signup the user lands as `pending_verification`. With `EMAIL_PROVIDER=mock` no real email is sent. For smoke tests, flip your test user with: `psql ... -c "UPDATE users SET status='active' WHERE email = '<your-test-email>';"`. `requireAuth` rejects non-active users so /api/pipelines returns 401 until you do.

`scripts/smoke/walkthrough.mjs` already does all of the above end-to-end with Playwright and writes screenshots to `docs/dogfooding/screenshots/`.

## Session discipline

**1 session = 1 concern = 1 PR.** Each AI session tackles exactly one feature, bugfix, or refactor.

- Good: "PR-T1: AI logging persistence" (tek concern, tek PR)
- Bad: "A1-A4 holistic + chat-history fix + z-index" (3 concern, tek PR)

**Mid-session bulgu yönetimi** — session sırasında farklı bir sorun fark edildiğinde:

| Durum | Aksiyon |
|---|---|
| **Blocker** — mevcut işi engelliyor | Inline düzelt, aynı PR'da kabul edilebilir (engeli kaldırmak işin parçası) |
| **İlişkili ama bağımsız** — aynı alandaki ayrı concern | `/parallel` ile ayrı worktree + PR'a dispatch et. Aynı session, ayrı PR |
| **İlgisiz** — tamamen farklı alan | `.claude/state/inbox.md`'ye 1 satır not ekle, dokunma |

**Inbox kuralları**: `.claude/state/inbox.md` append-only, her entry `- [ ] {concern} — {context} — {tarih}` formatında. Session başında inbox kontrol edilir; doluysa kullanıcıyla öncelik belirlenir.

The T1-T5 series is the model to follow for parallel concerns.

## Conventions worth respecting

- Auto-formatting on edit is wired via `.claude/hooks/format-on-edit.sh` (Prettier on `backend/` and `frontend/` files). Don't fight it — write code, let the hook normalize.
- Logs: backend uses Pino single-line pretty in dev, JSON in prod. Don't add `console.log` to backend code; use the request logger or `pino` instances.
- The dashboard polls — historical noisy 2xx routes were quieted in the logger, not in code. If you see weird missing log lines for healthy routes, check the pino redaction config before hunting in handlers.
- i18n: frontend ships TR + EN. New user-visible strings go through the i18n catalogue under `frontend/src/i18n/`, not hardcoded.
- UI task'ı olan plan step'lerine **visual spec zorunlu**: mockup referansı + Tailwind class listesi (arka plan, border, padding, renk). Subagent mockup'ı görmez — CSS detayları plan'a inline yazılmalı. Smoke test'te fonksiyonel AC'lerin yanında mockup-vs-ekran görsel karşılaştırması da yapılmalı.
