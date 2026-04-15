# AKIS Platform v0.2.0 — Claude Code Guide

> **Bu dosya bu projedeki TUM Claude oturumlari icin birincil referanstir.**
> **Her oturumda ILK bu dosyayi oku, sonra calismaya basla.**

## Proje Ozeti

AKIS (Adaptive Knowledge Integrity System), bir **AI Agent Workflows Engine**'dir. Yazilim gelistirme surecinde "fikir → kod → test" zincirini 3 AI agent workflow'u ile otomatize eder. Ayni zamanda universite bitirme projesidir.

- **Versiyon:** 0.5.0
- **Tez Temasi:** Knowledge Integrity & Agent Verification
- **Ogrenci:** Omer Yasir Onal (2221221562)
- **Danismanl:** Dr. Ogr. Uyesi Nazli Dogan
- **Universite:** Fatih Sultan Mehmet Vakif Universitesi (FSMVU)
- **Tez Deadline:** 1 Mayis 2026
- **Repo:** `OmerYasirOnal/akis-platform-devolopment` (private)

## Mimari: Sequential Agent Pipeline

```
[Kullanici fikri — serbest metin]
       |
   SCRIBE ("Dusun ve yaz")
   Fikri structured spec dokumanlarina cevirir
   Kullanici spec'i UI'da gorur ve onaylar <- human-in-the-loop
       |
   PROTO ("Insa et")
   Onaylanan spec'ten MVP scaffold uretir
   GitHub'a push eder (branch: main — direkt push, PR yok)
       |
   TRACE ("Dogrula")
   Proto'nun push ettigi main branch'teki kodu GitHub'dan okur
   O koda ozel Playwright otomasyon testleri yazar
```

### Dogrulama Zinciri (Tez temasiyla ortusur)
- Scribe spec uretiyor → INSAN dogruluyor (human-in-the-loop)
- Proto kod uretiyor → TRACE dogruluyor (automated verification)
- Trace test yaziyor → Testler OTOMATIK calisip dogruluyor

## Pipeline FSM (Durum Makinesi)
```
scribe_clarifying → scribe_generating → awaiting_approval
→ proto_building → trace_testing → completed | completed_partial
Her adimda → failed (retryable) | cancelled
```

## Agent Tanimlari

### SCRIBE — Spec Writer
- **Rol:** Business analyst — fikri yapilandirir
- **Input:** `ScribeInput` { idea, context, targetStack, existingRepo? }
- **Output:** `ScribeOutput` { spec: StructuredSpec, rawMarkdown, confidence, clarificationsAsked }

### PROTO — MVP Builder
- **Rol:** Onaylanan spec'ten calisir MVP scaffold uretir
- **Input:** `ProtoInput` { spec: StructuredSpec, repoName, repoVisibility, owner, dryRun? }
- **Output:** `ProtoOutput` { ok, branch, repo, repoUrl, files[], prUrl?, setupCommands[] }

### TRACE — Test Writer
- **Rol:** Proto'nun urettigi GERCEK kodu GitHub'dan okuyup Playwright testleri yazar
- **Input:** `TraceInput` { repoOwner, repo, branch, spec?, dryRun? }
- **Output:** `TraceOutput` { ok, testFiles[], coverageMatrix, testSummary }

---

## Tech Stack

| Katman | Teknoloji |
|--------|-----------|
| Frontend | React 19 + Vite 7 SPA (Tailwind 4, React Router 7) |
| Backend | Fastify 4 + TypeScript |
| Database | PostgreSQL + Drizzle ORM |
| AI Provider | Anthropic (claude-sonnet-4-6) |
| GitHub Entegrasyon | GitHub REST API (pipeline), OAuth (kullanici login) |
| Test | Vitest (unit), Playwright (e2e) |
| Deployment | OCI x86_64, Docker Compose, Caddy |

### Mimari Kisitlamalar
- Backend: Fastify + TypeScript, PostgreSQL + Drizzle. Express, NestJS, Prisma, Next.js YASAK.
- Frontend: React SPA + Vite. SSR framework YASAK.
- Agent'lar birbirini dogrudan cagirmaz — tum iletisim PipelineOrchestrator uzerinden.
- temperature=0 tum agent prompt'lari icin.
- Tool'lar orchestrator tarafindan inject edilir — agent'lar DB/API client'larini kendileri olusturmaz.

---

## Ortam Degiskenleri

### `.env` Yapisi
Secret'lar `~/.env.d/` klasorunde merkezi tutulur, proje dizinlerinde symlink ile baglanir.
Detayli sablona bak: `backend/.env.example`

### Key Haritasi

| Env Variable | Ne Icin | Nerede Kullaniliyor |
|---|---|---|
| `GITHUB_TOKEN` | Pipeline repo/push/PR | `pipeline/adapters/GitHubRESTAdapter.ts` |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub ile login | `api/auth.oauth.ts` |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub ile login | `api/auth.oauth.ts` |
| `GOOGLE_OAUTH_CLIENT_ID` | Google ile login | `api/auth.oauth.ts` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google ile login | `api/auth.oauth.ts` |
| `ANTHROPIC_API_KEY` / `AI_API_KEY` | Agent Claude API cagrisi | `config/env.ts` → tum agent'lar |
| `AUTH_JWT_SECRET` | Session token imzalama | `services/auth/jwt.ts` |
| `AI_KEY_ENCRYPTION_KEY` | Token sifreleme | `services/auth/OAuthTokenCrypto.ts` |
| `RESEND_API_KEY` | E-posta gonderimi | `services/email/` |
| `DATABASE_URL` | PostgreSQL baglantisi | `db/client.ts` |

### OAuth Callback Mantigi
- Callback URL'ler `.env`'de TANIMLANMAZ — kod `FRONTEND_URL`'den uretir
- Pattern: `${FRONTEND_URL}/auth/oauth/${provider}/callback`
- Local: `http://localhost:5173/auth/oauth/google/callback`
- Production: `https://akisflow.com/auth/oauth/google/callback`

---

## Repo Yapisi

```
devagents/
├── backend/                           Fastify 4 + TypeScript (ana backend)
│   └── src/
│       ├── api/                       REST API route'lari
│       ├── pipeline/                  PIPELINE KODU (konsolide)
│       │   ├── agents/               scribe/, proto/, trace/
│       │   ├── core/                 contracts/, orchestrator/, pipeline-factory.ts
│       │   ├── adapters/             GitHubMCPAdapter.ts, GitHubRESTAdapter.ts
│       │   ├── db/                   pipeline-schema.ts
│       │   └── api/                  pipeline.routes.ts, pipeline.plugin.ts
│       ├── db/                       Drizzle ORM schema + client
│       ├── config/                   env.ts
│       ├── services/                 AI, email, auth servisleri
│       └── utils/                    auth.ts, crypto.ts, errorHandler.ts
├── frontend/                          React 19 + Vite 7 SPA
│   └── src/
│       ├── pages/                    LandingPage, DocsPage, chat/, auth/, settings/
│       ├── services/api/             API client'lari
│       ├── types/                    workflow.ts, pipeline.ts
│       └── components/              Chat, UI bilesenleri
├── mcp-gateway/                       HTTP-to-stdio bridge for GitHub MCP Server
├── deploy/                            Deployment configs (oci/, staging/)
├── scripts/                           Local dev helper'lari
└── docs/                              Product + architecture referanslari
```

## API Endpoint'leri

### Pipeline API
| Method | Path | Islem |
|--------|------|-------|
| POST | `/api/pipelines` | Pipeline baslat (kullanici fikri) |
| GET | `/api/pipelines` | Pipeline gecmisini listele |
| GET | `/api/pipelines/:id` | Pipeline durumunu getir |
| POST | `/api/pipelines/:id/message` | Scribe'a mesaj gonder (soruya yanit) |
| POST | `/api/pipelines/:id/approve` | Spec'i onayla → Proto baslatilir |
| POST | `/api/pipelines/:id/reject` | Spec'i reddet → Scribe yeniden sorar |
| POST | `/api/pipelines/:id/retry` | Basarisiz adimi tekrar dene |
| POST | `/api/pipelines/:id/skip-trace` | Trace'i atla → completed_partial |
| DELETE | `/api/pipelines/:id` | Pipeline'i iptal et |

### GitHub API
| Method | Path | Islem |
|--------|------|-------|
| GET | `/api/github/status` | GitHub baglanti durumu |
| GET | `/api/github/repos` | Kullanicinin repo listesi |
| POST | `/api/github/repos` | Yeni repo olustur |
| POST | `/api/github/connect` | GitHub PAT ile baglan |
| POST | `/api/github/disconnect` | GitHub baglantisini kes |

### Auth / Account API
| Method | Path | Islem |
|--------|------|-------|
| GET | `/auth/profile` | Kullanici profili (github bilgisi dahil) |
| PUT | `/auth/profile` | Profil guncelle (name, email) |
| PUT | `/auth/password` | Sifre degistir |
| DELETE | `/auth/account` | Hesabi soft-delete et |

## Hata Yonetimi

Tum hatalar `PipelineError` tipinde: code, message (Turkce), technicalDetail, retryable, recoveryAction.
- Retry politikasi: Max 3 deneme, backoff: [5s, 15s, 30s]. Stage timeout: 5 dakika (Trace: 10 dk).
- Hata kodlari: backend/src/pipeline/core/contracts/PipelineErrors.ts

## Local Gelistirme Ortami

### Onkosullar
1. PostgreSQL (Docker): `./scripts/db-up.sh`
2. Node.js 20+, pnpm

### Backend Baslatma
```bash
pnpm -C backend dev
```
- `DEV_MODE=true` (.env'de): Auth bypass (otomatik dev user)
- `DATABASE_URL` local'e baktigi icin `.env` dosyasinda dogru oldugundan emin ol

### Frontend Baslatma
```bash
pnpm -C frontend dev
```
- Vite dev server: http://localhost:5173
- Vite proxy `/auth/*` ve `/api/*` isteklerini `localhost:3000`'a yonlendirir

## Canonical Commands

### Frontend (`pnpm -C frontend`)

| Task | Command |
|------|---------|
| Dev server | `pnpm -C frontend dev` |
| Build | `pnpm -C frontend build` |
| Typecheck | `pnpm -C frontend typecheck` |
| Lint | `pnpm -C frontend lint` |
| Test | `pnpm -C frontend test` |

### Backend (`pnpm -C backend`)

| Task | Command |
|------|---------|
| Dev server | `pnpm -C backend dev` |
| Build | `pnpm -C backend build` |
| Typecheck | `pnpm -C backend typecheck` |
| Lint | `pnpm -C backend lint` |
| Unit tests | `pnpm -C backend test:unit` |
| Integration tests | `pnpm -C backend test:integration` |
| DB migrate | `pnpm -C backend db:migrate` |
| DB studio | `pnpm -C backend db:studio` |

### Quality Gate (commit oncesi)
```bash
pnpm -C backend typecheck && pnpm -C backend lint && pnpm -C backend test:unit && pnpm -C backend build
pnpm -C frontend typecheck && pnpm -C frontend lint && pnpm -C frontend test && pnpm -C frontend build
```

## Kritik Kurallar

### ASLA Yapilmayacaklar
- ASLA `.env` dosyalarini degistirme veya olusturma
- ASLA dosyalari backup olmadan silme
- ASLA scope disi ozellik ekleme
- ASLA agent'larin birbirini dogrudan cagirmasina izin verme
- ASLA pipeline ciktilarini platform repo'suna (`akis-platform-devolopment`) push etme

### Kod Kalitesi
- Commit oncesi: `typecheck + lint + test:unit + build`
- Commit prefix: `feat()`, `fix()`, `refactor()`, `docs()`, `chore()`
- Co-author: `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
- Hatalari lint kurallarini devre disi birakarak susturma — tamamen gerekcelenmeden
- Minimum kod yorumu (sadece acik olmayan mantik)

## AI Provider Yapilandirmasi

Desteklenen provider'lar: `anthropic`, `openai`, `openrouter`, `mock`
- API key prefix'e gore auto-detect: `sk-ant-` → anthropic, `sk-or-` → openrouter, `sk-` → openai
- Default model: `claude-sonnet-4-6` (Anthropic)
- Kullanicilar Ayarlar sayfasindan kendi API key'lerini ekleyebilir (AES-256-GCM ile sifrelenir)
- Oncelik sirasi: kullanici key > platform default key > mock fallback

### Route Yapisi (Chat-Centric)
```
/              → LandingPage (public, authenticated → /chat redirect)
/login         → Login (multi-step)
/signup        → Signup (multi-step)
/docs          → DocsPage (public)
/chat/*        → ChatPage (protected, splat routing)
/settings      → SettingsPage (protected, AI key yonetimi)
/agents        → AgentsPage (protected)
*              → / redirect
```

## Mock Test Sistemi

- `AI_PROVIDER=mock` → `MockAIService` aktif
- Mock cevaplari `backend/src/services/ai/__fixtures__/` altinda JSON
- `GitHubServiceLike` interface → mock kolay, test'lerde gercek GitHub'a push yok
- `pnpm test:unit` ve `pnpm test:e2e` → DAIMA mock

## UI/UX Yonergesi

- "Liquid-glass / frosted surfaces" temasi
- Tema degiskenleri: `--ak-bg`, `--ak-surface`, `--ak-surface-2`, `--ak-primary`
- Marka renkleri: bg `#0A1215`, primary accent `#07D1AF` (teal), danger `#FF6B6B`

## Vizyon & Strateji

- Ozet: `docs/plans/AKIS_VISION.md`
- Bilimsel temeller: TRiSM (Gartner), Reflexion/Self-Refine (NeurIPS 2023), METR 2025, McKinsey 2026
- Kultur ilkesi: "AI uretir, AI denetler, insan karar verir"
- Level 3: CriticAgent, FixLoop, Validator, Explainability, SecurityGate, LearningService
- Level 4: Orchestrator entegrasyonu — FixLoop auto-trigger, SecurityGate regression check, LearningService recording


## Deployment

- **Production:** `akisflow.com` — OCI x86_64, Docker Compose + Caddy
- **CI/CD:** GitHub Actions (ci.yml, pr-gate.yml, oci-staging-deploy.yml)
- Docker image: `ghcr.io/omeryasironal/akis-platform-devolopment/akis-backend`
- Deploy script: `deploy/oci/staging/deploy.sh`
