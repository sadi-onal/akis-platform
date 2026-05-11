# AKIS — Teknik Mimari

## Genel Bakış

AKIS, modüler monolit mimarisi üzerine inşa edilmiş bir AI ajan orkestrasyon platformudur. Frontend bir React SPA, backend ise Fastify tabanlı bir TypeScript sunucusudur.

**Son güncel:** 2026-05-11 (PDP-2 dalgası sonrası — bkz. [`docs/product/03-architecture.md`](./product/03-architecture.md) için delta detayları).

## Katmanlar

### Frontend (React 19 + Vite 7)

- **SPA**: Tek sayfa uygulama, Vite dev server + production build
- **Routing**: React Router 7 ile client-side routing
- **Styling**: Tailwind CSS 4, custom design token'lar (`--ak-*` prefix)
- **State**: React hooks + local state (global store yok). PDP-2 dalgasında F-06 refactor planlanmış durumda — `ChatPage` (1409 satır) odaklı hook'lara bölünecek (PR [#525](https://github.com/OmerYasirOnal/akis-platform/pull/525) merge sonrası: ~372 satır + 11 hook: `useConversationLoader`, `useIterationChildPoll`, `useGithubOAuthRestore`, `useChatPageKeyboard`, `useHandleSend`, `useChatQaAsk`, `useSplitResize`, `useTraceToggle`, `useModelPicker`, `useShowPreview`, `useProtoFiles`, `usePipelineControls`, + `ChatPageLayout` shell)
- **Chat surface**: `ChatRouter` (intent-aware dispatch) + `DisambiguationModal` (low-confidence fork) + per-message components
- **API**: `HttpClient` wrapper ile fetch-based REST calls
- **SSE**: `usePipelineStream` hook ile gerçek zamanlı ajan aktivite akışı; chat-qa için ayrı async-iterable SSE client (`chatQaApi.ask()`)
- **i18n**: Türkçe/İngilizce, `frontend/src/i18n/locales/{tr,en}.json` — TR ↔ EN tam senkron (1436 key), bakkal-language sözlüğü `docs/product/02-ux.md` § 6'da

### Backend (Fastify 4 + TypeScript)

- **Framework**: Fastify 4 plugin mimarisi
- **ORM**: Drizzle ORM + PostgreSQL 16
- **Auth**: Cookie-based session (JWT), OAuth (GitHub, Google)
- **AI Service**: Provider-agnostic (Anthropic, OpenAI, OpenRouter, mock)
- **Pipeline**: `backend/src/pipeline/` altında konsolide

### Pipeline Orchestrator

Merkezi orkestratör tüm ajan iletişimini yönetir:

```
PipelineOrchestrator
├── FSM (Finite State Machine)
│   scribe_clarifying → scribe_generating → critic_reviewing_spec
│   → awaiting_approval → proto_building → critic_reviewing_code
│   → fix_loop_iteration (opsiyonel) → trace_testing → ci_running
│   → completed | completed_partial | failed | cancelled
├── ScribeAgent      — AI ile clarification + spec üretimi
├── CriticAgent      — spec + code adversarial review (6 boyut)
├── ProtoAgent       — AI ile scaffold üretimi + GitHub push
│   └── ScaffoldEnricher — install.sh + Türkçe README + Dockerfile + .env.example
├── TraceAgent       — AI ile BDD/Playwright test yazımı
├── ExplainabilityService — agent reasoning (DB-backed, write-through cache)
├── ActivityEmitter  — activity feed (DB append + memory ring cache)
├── RegressionService — iteration confidence report
├── FixLoopService   — Critic findings → 3-deneme fix döngüsü
└── Adapters
    ├── GitHubMCPAdapter  — MCP gateway üzerinden
    └── GitHubRESTAdapter — Doğrudan REST API
```

### Chat Surface (PDP-2'de eklendi)

```
ChatRouter (FE)
├── IntentClassifier (BE) — BUILD / ASK / FEEDBACK / CHAT + confidence
│   └── DisambiguationModal (FE) — confidence < 0.7 ise kullanıcıya 4 buton
├── BUILD → workflowsApi.create (mevcut pipeline tetikleyici)
├── ASK   → ChatQAService (RAG-augmented SSE streaming, pipeline tetiklemez)
├── FEEDBACK → log + "düzeltelim mi?" CTA
└── CHAT → simple conversational response (placeholder, PDP-3'te)
```

### Veritabanı

PostgreSQL 16 + Drizzle ORM. Ana tablolar:

- `users` — Kullanıcı hesapları
- `pipelines` — Pipeline durumu, conversation, spec, output
- `pipeline_reasonings` — Per-stage AgentReasoning (NFR-1 kalıcı, soft-delete via `archived_at`) — PDP-2
- `pipeline_activities` — Append-only activity feed (DB + memory ring cache) — PDP-2
- `intent_classifications` — Intent classifier audit (SHA-256 hash only, no raw text) — PDP-2
- `github_integrations` — OAuth token encrypted (AES-256-GCM)
- `ai_usage` — Token kullanım takibi
- `knowledge_chunks` — RAG için pgvector embedding'leri

Migration zinciri: 0000-0048 (bkz. `backend/migrations/`). PDP-2 dalgası 0047 (reasonings + activities) ve 0048 (intent_classifications) ekledi.

### MCP Gateway

Model Context Protocol adapter layer. GitHub API çağrılarını standart MCP formatına çevirir.

## API Routes

Tam liste: [`docs/openapi.yaml`](./openapi.yaml). PDP-2'de eklenen yeni route'lar:

- `GET /api/pipelines/:id/explanation` — agent reasoning + attention points (Level-4 surface)
- `GET /api/pipelines/:id/regression` — iteration regression confidence report
- `POST /api/chat/intent` — intent classification (BUILD/ASK/FEEDBACK/CHAT)
- `PATCH /api/chat/intent/:classificationId` — user-override after disambiguation
- `POST /api/chat-qa/ask` — pipeline-free Q&A (SSE streaming)

## Güvenlik

- Cookie-based auth (HttpOnly, Secure, SameSite=Lax)
- AI API key'leri AES-256-GCM ile şifreli DB'de saklanır
- Rate limiting (Fastify plugin)
- CORS origin kontrolü
- Caddy ile otomatik HTTPS (Let's Encrypt)
- IDOR korunması: kullanıcı-controlled id'li route'larda `WHERE user_id = currentUserId` zorunlu (PDP-2'de F-10 audit'iyle PATCH /api/chat/intent eklendi)
- SSE error mesajları sanitize edilir (raw stack-trace user'a sızmaz) — `CHAT_QA_AUTH | RATELIMIT | FAILED` ile bakkal-Türkçesi
- Intent classifier mesaj içeriğini saklamaz — sadece SHA-256 hash (NFR-1.3 audit privacy)

## Geliştirme tooling

`.claude/` altında ürün ile ayrı bir tooling katmanı: 8 subagent, 5 skill, 6 slash command, 3 hook, JSON state schemas. Detay: [`.claude/README.md`](../.claude/README.md). Bakkal-language audit script `scripts/lint/bakkal-language.mjs` (zero-dep Node, 2 modes + allowlist).
