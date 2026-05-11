# Changelog

## Unreleased

### PDP-2 quality wave (2026-05-10) — 11 PRs

**Bug fixes (F-01..F-07):**
- **fix(F-01)** [#516] Reset `lastMessagesKeyRef` on Yeni Sohbet — chat content now reloads correctly when navigating back to a previous conversation. Five reset sites (handleNewConversation, handleBack, handleDelete, /chat empty path, fetch-error redirect).
- **fix(F-02)** [#514] Make pipeline-detail rail body scrollable — `max-h-[55vh] sm:max-h-[60vh] overflow-y-auto`, plus `tabIndex={0}` + `role="region"` for keyboard a11y, `overscroll-contain` to prevent chat scroll-chain.
- **fix(F-04)** [#515] Keep rail visible for completed pipelines that still have outputs — new `pipelineHasOutputs` prop derived in ChatPage from workflow stages; Regresyon tab also gated on `(activities OR outputs)` so it surfaces post-restart.
- **fix(F-05)** [#522] Mode-badge tooltip in bakkal-Türkçesi via i18n catalogue (`chat.modeBadge.{ask,plan,act,review,failed}`); replaces "Pipeline ASK" jargon with "Sorularını yanıtlıyoruz" etc. HATA branch now tested.
- **fix(F-07)** [#521] Live clarification counter — per-question ✓ marker added to header so users see selection feedback without pressing Next.

**New features (F-08..F-11):**
- **feat(F-08)** [#518] ScaffoldEnricher — Proto's output now includes `install.sh`/`setup.sh` (8 stack templates), Turkish README sections "Kendi bilgisayarında çalıştır" + "Sunucuya kur", optional Vite-aware Dockerfile + docker-compose, `.env.example` with Turkish comments. Wired into all three Proto push paths with integration tests.
- **feat(F-11)** [#517] Reasoning + activities **persisted to PostgreSQL** (NFR-1 quality-trust permanence). New tables `pipeline_reasonings` (write-through cache, soft-delete) and `pipeline_activities` (append-only, DB falls through cache). Stable stage ordering. `persistencePreEpoch` flag gated on terminal pipeline status. `setActivityDb(null)` default under `NODE_ENV=test`.
- **feat(F-10)** [#519] Intent classifier (BUILD / ASK / FEEDBACK / CHAT) + `ChatRouter` + `DisambiguationModal`. Turkish-aware regex boundaries. SHA-256 hash only — raw messages never persisted. IDOR-safe PATCH ownership; UUID format validation.
- **feat(F-09)** [#520] Chat Q&A with SSE streaming — pipeline-free Q&A using spec/proto/findings as context. Sanitized error messages (CHAT_QA_AUTH/RATELIMIT/FAILED in bakkal-Türkçesi). Frontend AbortController per send. `needsBuild` heuristic surfaces "Bunu özellik olarak ekleyelim mi?" CTA.

**Bakkal-language polish (F-12):**
- **chore(F-12)** [#523] Bakkal-language audit script (`scripts/lint/bakkal-language.mjs`) — zero-dep Node, 24-term glossary (incl. `push → yükle/gönder`). 13 node:test cases. Top 7 i18n fixes landed. 33 warns + 102 infos remain for follow-up.

**Tooling (Layer B):**
- **chore(tooling)** [#512] `.claude/` developer tooling pack — 8 subagents, 5 skills, 6 slash commands, 3 hooks, JSON state schemas, README. Hooks opt-in via `settings.json` snippet.

**Documentation (PDP-2):**
- **docs(pdp)** [#513] Product Discovery & Design Pack: 7 documents under `docs/product/`. Target-first ordering (vision → requirements → ux → architecture → quality → gap → roadmap).

**Test count delta:** Backend ~178 → ~3260 (+~80 new). Frontend 58 → 844 (+~30 new). 7 new backend integration tests for persistence + intent + chat-qa.

### Bakkal onboarding — JIT GitHub gate (no upfront modal, no PAT)
- **feat(auth):** Replace the upfront `GithubConnectModal` with a **just-in-time** `GithubConnectGate` panel. The gate only appears the moment the user submits their first idea on `/chat` — at which point the value of GitHub is concrete (we need it to ship the user's app). The user's idea is persisted to `sessionStorage`; after the OAuth redirect returns to `/chat?github=connected`, the page surfaces a success toast and **auto-resumes** the pipeline send with the saved idea. No interruption on first-visit, no idea lost across the OAuth dance.
- **feat(auth):** Settings → Integrations remains the canonical permanent home for the connect/disconnect button (`SettingsPage > GitHubSection`) — no changes there; the JIT gate is an additional contextual entry point, not a replacement.
- **feat(frontend):** New copy for the bakkal persona — three plain-Turkish permission bullets ("Senin için yeni bir depo açar / Yazdığı kodu o depoya gönderir / Mevcut depolarına dokunmaz") + the user's own idea quoted back so it's clear what's being authorized for.
- **feat(auth):** Wire the GitHub integration OAuth flow into the bakkal onboarding so the user goes from signup → "GitHub ile Bağla" → fikir → spec → onay → kod without ever pasting a personal access token. The full chain (`/api/integrations/github/oauth/start` with `read:user user:email repo`, encrypted token in `github_integrations`, `getGitHubToken(userId)` resolver, pipeline factory using the per-user OAuth token) was already in place; this change makes the flow demoable on a dev box and softens the surface copy for non-developers.
- **feat(auth):** DEV_MODE bypass for `/api/integrations/github/oauth/start`. When `DEV_MODE=true`, `NODE_ENV !== 'production'`, and `GITHUB_OAUTH_CLIENT_ID/SECRET` are unset/placeholder, the start route synthesizes a successful OAuth callback: writes a `github_integrations` row using `GITHUB_TOKEN` (encrypted) when it looks real, or the `__AKIS_DEV_MOCK_GITHUB_TOKEN__` sentinel otherwise. The sentinel is filtered out by `getGitHubToken` so pipeline calls fail fast instead of silently sending a junk token. Production is double-gated and never bypasses.
- **test:** Pure-function unit tests for `evaluateGithubOAuthDevBypass` (production-safe, dev-only, sentinel selection) and the new `getGitHubToken` filter that rejects the dev sentinel. Vitest tests for `GithubConnectGate` (render + persist + cancel). **Playwright e2e** for the full JIT round-trip: idea → gate appears → connect (mocked OAuth-callback redirect) → toast + URL cleanup → state idempotency.
- **docs:** `backend/.env.example` documents the dev-mode bypass and the OAuth scopes the integration uses.

Backward compatible: the legacy server-side `GITHUB_TOKEN` env fallback in `getGitHubToken` still works for single-tenant deploys; user-stored OAuth tokens take precedence as before.

## v0.7.1 (2026-05-09)

### Regression Confidence Surface (Tier 1.A)
- **feat:** New `RegressionReport` aggregating per-pipeline regression signals (files changed in iteration, parent baseline test summary, FixLoop runs, status).
- **feat:** `GET /api/pipelines/:id/regression` route mounted in pipeline.plugin.ts; same auth as /explanation.
- **feat:** New `RegressionPanel` component + third "Regresyon" tab in PipelineDetailRail, surfacing the bakkal-readable confidence summary.
- 18 new backend tests (regressionFactory + RegressionService + route handler), 18 new frontend tests (RegressionPanel + rail tab + workflowsApi).

## v0.7.0 (2026-05-07)

### Level-4 Explainability Surface (Major Feature)
- **feat:** ExplainabilityService now receives reasoning from **all four** agent layers (was 2). Scribe (analysis + regenerate), Critic (spec + code review), Proto (post-push), Trace (post-tests) all push `AgentReasoning` records via `reasoningFactory` pure builders.
- **feat:** `GET /api/pipelines/:id/explanation` route mounted in `pipeline.plugin.ts` (handler existed but was unreachable in v0.6.x).
- **feat:** PipelineActivity stage type extended with `'critic' | 'fix-loop'`; SSE payload now carries an optional compact `reasoning` snippet (decision + confidence) so cinema/explainability surfaces don't need a second fetch.
- **feat:** Critic spec/code transitions emit start + done activity events with reasoning attached.

### New Frontend Components
- **feat:** `ConfidenceBadge` — colour-coded 0-100 score with hover/click tooltip surfacing factors.
- **feat:** `AttentionBanner` — high/medium/low severity attention points sorted + capped with overflow note.
- **feat:** `ExplanationPanel` — fetches `/explanation` (DI-friendly), renders per-stage reasoning cards with collapsible assumptions/alternatives/risks, surfaces overall narrative.
- **feat:** `PipelineCinema` — four-column live pipeline view (Scribe / Critic / Proto / Trace), fix-loop folded into Proto column, reduced-motion-aware progress bars, reasoning bubble per active stage.
- **feat:** `PipelineDetailRail` — opt-in collapsible rail wired into ChatPanel between header and messages. Auto-expands on `running` (Akış tab) and `awaiting_approval` (Açıklama tab); manual collapse + tab-switch persist for the conversation lifetime.

### Dogfooding & Thesis Harness
- **feat:** `docs/dogfooding/benchmark-set.yaml` — five fixed problems sized for ≤5min mock-provider runs.
- **feat:** `scripts/benchmark/run.mjs` — dependency-free Node runner that drives the pipeline API end-to-end, captures `confidenceByStage` + `attentionPoints` + coverage, writes per-run JSON reports.
- **feat:** `scripts/smoke/walkthrough.mjs` — Playwright-driven local smoke test: signup → activate → new chat → idea → screenshot rail in both tabs. Output goes to `docs/dogfooding/screenshots/`.
- **docs:** `docs/learnings/benchmark-2026-may.md` — thesis chapter outline tying the empirical study to Sonar 2026 / Sherlock 2026 / FORGE'26 / TRiSM literature.

### Local Dev Env Recovery
- **fix:** `docker-compose.dev.yml` recreated (was missing locally; `dev-up.sh` references it). Uses `pgvector/pgvector:pg16` so backend migrations finish — vanilla `postgres:16-alpine` lacks the `vector` extension.

### Tests
- 27 new backend tests (`reasoningFactory`).
- 51 new frontend tests (`ConfidenceBadge`, `AttentionBanner`, `ExplanationPanel`, `PipelineCinema`, `PipelineDetailRail`).
- All test suites green: backend 3167/3167, frontend 786/786.

### Notes
- Level-4 backend scaffolding (ExplainabilityService, FixLoopService, LearningService, DeterministicValidator, SecurityGate) was already present in v0.6.5; this release wires the explainability layer end-to-end and adds the user-visible surface.
- A live local smoke test verified the new rail renders both tabs (`docs/dogfooding/screenshots/2026-05-06T22-12-31*-0[678]-*.png`). Mock provider produces specs that fail Scribe schema validation, so reasoning records are empty in the captured run — pipeline run with a real provider will populate them.

## v0.6.5 (2026-04-15)

### File Upload (New Feature)
- **feat:** End-to-end file upload — ChatInput → FormData API → @fastify/multipart → Scribe
- **feat:** FileUploadService: in-memory processing for text (.ts/.tsx/.js/.md/.json/.html/.css), images (.png/.jpeg/.gif/.webp), basic PDF
- **feat:** Attachment context injection into Scribe knowledgeContext (reuses existing RAG pattern)
- **feat:** Backend multipart/JSON auto-detection — full backward compatibility

### Chat UX Improvements
- **feat:** Info messages shown when user sends notes during running pipeline stages
- **feat:** Iteration mode error feedback — ChatMessage error shown on failure
- **fix:** Iteration mode navigation preserves browser history (removed replace:true)
- **fix:** Updated Turkish placeholder text for all pipeline terminal states
- **feat:** ChatSkeleton used as Suspense fallback instead of plain text

### Landing Page Fixes
- **fix:** framer-motion opacity:0 animation failure — removed all opacity from initial states
- **fix:** LazyMotion domAnimation → domMax (enables whileInView support)
- **fix:** WCAG AA contrast — text-secondary → text-primary, bg-surface/30 → /70
- **fix:** Mobile responsive padding — px-4 sm:px-6 lg:px-8 on all sections
- **fix:** HowItWorks grid gap responsive — gap-4 md:gap-6

### DocsPage Improvements
- **feat:** Inline markdown rendering — **bold**, \`code\`, [links](url) now properly rendered
- **feat:** Fenced code blocks (\`\`\`) render as styled \<pre\>\<code\> blocks
- **fix:** Sidebar nav accessibility — aria-label, aria-current="page"

### Accessibility
- **fix:** ChatInput: aria-labels for file/image buttons, dynamic remove label
- **fix:** ChatMessage: aria-labels for copy buttons
- **fix:** ErrorBoundary: Turkish character fixes, aria-expanded toggle
- **feat:** File upload validation toast messages (size, count, type errors)

### i18n
- **feat:** StatusBadge labels internationalized (7 keys TR+EN)
- **feat:** common.loading key added to both locale files

### Security
- **fix:** Path traversal guard on getFileContent endpoint (rejects ../ and absolute paths)
- **fix:** Error message no longer leaks file path structure (404 instead of path in message)
- **fix:** HTTP status codes: 400 for invalid input, 404 for not found (was 500 for all)

### Type Safety
- **refactor:** Eliminated all 25 \`as any\` assertions from backend (0 remaining)
- **fix:** fastify.d.ts: added hijack(), routerPath, user, raw, delete() type declarations
- **fix:** StripeService: proper unknown cast for subscription period fields

### Code Quality
- **fix:** Silent .catch(() => {}) handlers replaced with dev console.warn
- **fix:** console.debug → logger.debug in ScribeAgent and GitHubMCPService
- **fix:** localStorage SSR safety guards in EmptyState, ProfileSetupWizard

### Deploy Reliability
- **fix:** deploy_prebuilt.sh: sudo for frontend cleanup (prevents permission denied)
- **fix:** deploy.sh: GITHUB_REPOSITORY sync in .env (prevents image tag mismatch)
- **fix:** @fastify/multipart v10 → v8 (Fastify 4 compatibility)
- **fix:** @fastify/compress v8 → v7 (Fastify 4 compatibility)

### Test Coverage
- **test:** LandingPage.test.tsx — 24 tests (hero, steps, features, stats, navigation, auth)
- **test:** DocsPage.test.tsx — 23 tests (sections, markdown, a11y, navigation)
- **test:** file-upload-service.test.ts — 15 tests (text extraction, image encoding, limits)
- **test:** pipeline-multipart.test.ts — 18 tests (field parsing, context string, e2e flow)
- **test:** pipeline-orchestrator.test.ts — +4 tests (attachment threading)
- **test:** ErrorBoundary tests updated for Turkish character fixes
- **stats:** Frontend 620 → 673 (+53), Backend 3075 → 3112 (+37), Total +90

### Knowledge Base
- **feat:** 30 project documents ingested into RAG (188 chunks)
- **docs:** CLAUDE.md updated to v0.6.5 with file upload and RAG docs

## v0.5.0 (2026-04-13)

### Pipeline Engine
- **fix:** JSON parse errors when AI wraps response in \`\`\`json fences — shared `json-extract.ts` utility
- **fix:** Pipeline continuation — follow-up pipelines reuse existing repo instead of creating new
- **fix:** Double-approve guard on spec approval
- **fix:** Polling optimization for pipeline status checks
- **feat:** Agent context injection — RAG knowledge appended to Scribe/Proto/Trace system prompts
- **feat:** Pipeline completion auto-ingests specs, scaffolds, and test results into knowledge base

### RAG System (New)
- **feat:** Local embedding with Transformers.js (all-MiniLM-L6-v2, 384d) — zero cost
- **feat:** pgvector integration for cosine similarity search
- **feat:** Hybrid retrieval: keyword (55%) + semantic (45%) with user/project isolation
- **feat:** Knowledge API: CRUD documents, hybrid search, statistics
- **feat:** Automatic knowledge ingestion on pipeline completion

### Billing & Pricing
- **feat:** Anthropic Claude model pricing (Haiku, Sonnet, Opus) + OpenAI GPT-4.1 family
- **feat:** Token budget enforcement — monthly limit check before job execution
- **feat:** Pipeline token tracking — completion triggers billing usage update
- **fix:** Billing race condition — atomic SQL for concurrent usage increment
- **fix:** Admin accounts set to unlimited (production DB verified)

### UI & Animations
- **feat:** Stage-colored glow bar when agents run (blue/orange/purple)
- **feat:** Conversation sidebar: hover scale + active accent border
- **feat:** TraceProgressStepper: smooth icon transitions + border-glow
- **feat:** EmptyState: logo glow-pulse effect (respects reduced-motion)
- **feat:** Settings tab content fade+slide transition
- **feat:** Clarification card: bigger chips (border-2, font-medium), checkmark on selection
- **feat:** Sidebar empty state: icon + "Yeni Sohbet Başlat" button
- **feat:** Settings loading skeletons replace plain text
- **feat:** Chat performance: content-visibility:auto on message list
- **fix:** Sandpack preview: Proto path mapping (src/App.tsx → /App.tsx)
- **fix:** Delete confirmation dialogs for conversations and API keys
- **fix:** Turkish character search normalization (toLocaleLowerCase)
- **fix:** Search debounce (300ms) for conversation sidebar

### Preview System
- **feat:** StackBlitz → Sandpack migration (15-30s → 1-3s boot time)
- **fix:** Template + custom files hybrid — Proto code renders instead of "Hello world"
- **feat:** Vendor chunk splitting — Sandpack lazy-loaded separately (620KB)

### Testing
- **feat:** 2102 total tests (1645 backend + 457 frontend), 0 failures
- **feat:** Agent unit tests: ScribeAgent (22), ProtoAgent (19), TraceAgent (17)
- **feat:** JSON extract utility tests (36 tests)
- **feat:** Frontend component tests: ConversationSidebar, ChatHeader, TraceProgressStepper, ChatSkeleton

### Documentation
- **feat:** AGENT_VERIFICATION.md — thesis defense documentation
- **feat:** CHANGELOG.md (this file)

### Infrastructure
- **feat:** Database composite indexes: (userId, createdAt), (stage, updatedAt)
- **feat:** DB pool default increased: 10 → 20 connections
- **fix:** All console.log/warn/error → structured pino logger (150+ calls migrated)
- **fix:** nodemailer security update (7.x → 8.0.5)
- **fix:** Pipeline ON DELETE CASCADE for user foreign keys

### Security
- **verified:** API keys encrypted with AES-256-GCM, never exposed to frontend
- **verified:** Admin role with unlimited billing override
- **verified:** Rate limiting on auth endpoints
- **verified:** CORS whitelist, httpOnly cookies, bcrypt passwords
- **verified:** OAuth HMAC-signed state tokens (stateless)

---

## v0.2.0 (2026-03-xx)

Initial release with pipeline engine, chat UI, and OAuth authentication.
