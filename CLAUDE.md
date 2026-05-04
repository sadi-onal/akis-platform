# AKIS Platform v0.6.5 — Claude Code Guide

> **Bu dosya bu projedeki TUM Claude oturumlari icin birincil referanstir.**
> **Her oturumda ILK bu dosyayi oku, sonra calismaya basla.**

## Proje Ozeti

AKIS (Adaptive Knowledge Integrity System), bir **AI Agent Workflows Engine**'dir. Yazilim gelistirme surecinde "fikir → kod → test" zincirini 3 AI agent workflow'u ile otomatize eder. Ayni zamanda universite bitirme projesidir.

- **Versiyon:** 0.6.5
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
| File Upload | @fastify/multipart (bellekte isleme, Scribe context injection) |
| Test | Vitest (unit — 754 test), Node test (backend — 3177 test), Playwright (e2e) |
| Deployment | OCI x86_64, Docker Compose, Caddy |
| RAG/Knowledge | pgvector, RepoDocsIngester, hybrid search (keyword + semantic) |

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

### GitHub: Login vs. Integration (ayri akislar)

GitHub'la **login** ile pipeline **integration** birbirinden tamamen ayri:

- **Login OAuth** (`/auth/oauth/github`) → kullanici dogrulama. Scope: `user:email`. Token `oauth_accounts` tablosuna yazilir.
- **Integration OAuth** (`/api/integrations/github/oauth/start`) → pipeline'in repo acmasi/push'lamasi icin. Scope: `read:user user:email repo`. Token AYRI tabloda: `github_integrations`.

Sonuc: GitHub ile giris yapmis bir kullanici bile pipeline'i kullanabilmek icin integration OAuth'unu ayrica tetiklemek zorunda. UI bunu `GithubConnectModal` ile yapar — chat ilk acilista, integration row yoksa modal cikar; tek tikla `/api/integrations/github/oauth/start` baslar. `oauth_accounts.github` row'unun varligi ASLA "GitHub bagli" anlamina gelmez — kontrol her zaman `github_integrations` uzerinden.

Token cozumu: `services/auth/githubToken.ts` resolver'i sadece `github_integrations` (ve dev modda env `GITHUB_TOKEN`) okur. Eski `users.github_token` kolonu (PAT) ve `oauth_accounts` icin GitHub fallback'i kaldirildi.

### Plan/Billing kaldirildi

Bu bitirme projesi — gercek billing yok. `plans`, `subscriptions`, `usage_counters`, `workspace_billing_settings`, `user_billing_overrides`, `billing_notifications` tablolari ve Stripe entegrasyonu tamamen kaldirildi (`migrations/0045`). `BillingService`, `StripeService`, `api/billing.ts`, settings'deki Plan tab silindi. Pipeline.routes quota gate kaldirildi — her hesap sinirsiz. Token/maliyet analitigi `pipelines.metrics` JSONB'sinden okunmaya devam ediyor (sadece `/api/usage*` analitik amacli).

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
│       │   ├── services/            FileUploadService.ts (multipart dosya isleme)
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
├── deploy/                            Deployment configs (oci/prod/)
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
- Docker Desktop (Postgres + Adminer container'lari icin)
- Node.js 20+, pnpm
- `backend/.env` ve `frontend/.env` symlink'leri `~/.env.d/`'ye baglanmis olmali

### Tek komutla baslatma
```bash
./scripts/dev-up.sh
```
Bu script:
1. Postgres (pgvector/pgvector:pg16) ve Adminer'i ayaga kaldirir
2. DB migration'larini uygular
3. Backend'i :3000 portunda arka planda baslatir (log: backend.log)
4. Frontend'i :5173 portunda arka planda baslatir (log: frontend.log)

### Durdurma
```bash
./scripts/dev-down.sh
```

### Manuel calistirma (debug icin)
```bash
docker compose -f docker-compose.dev.yml up -d   # sadece DB
pnpm -C backend dev                               # backend foreground
pnpm -C frontend dev                              # frontend foreground
```

### Endpoint'ler
- Frontend: http://localhost:5173
- Backend:  http://localhost:3000/health
- Adminer:  http://localhost:8080 (server=`db`, user=`postgres`, pass=`postgres`, db=`akis_v2`)

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
./scripts/gate.sh
```
Bu script backend ve frontend icin sirasiyla typecheck, lint, unit test ve build calistirir. Manuel calistirmak istersen:
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
- Co-author: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` (otomatik — Claude Code oturumu hangi sürümü kullaniyorsa ona göre yazar)
- Hatalari lint kurallarini devre disi birakarak susturma — tamamen gerekcelenmeden
- Minimum kod yorumu (sadece acik olmayan mantik)

### PR Review Otomasyonu (zorunlu)

Her PR acildiginda ve CI yesile dondugunde, ASAGIDAKI DONGUYU OTOMATIK
CALISTIR — kullanicidan tekrar istek beklemeden:

1. **Review**: `superpowers:code-reviewer` alt-ajanina PR diff'ini ver;
   READY/NEEDS-WORK/BLOCKED sonucunu al. NEEDS-WORK ise PR'a yorum bas,
   fix-up commit plani ver, durur.
2. **Merge** karari:
   - READY + dusuk-risk → otomatik merge
   - READY + audit-gated kategori + PR'da bagimsiz pre-merge audit raporu var → otomatik merge
   - READY + mutlak high-risk (DB migration / billing) → KULLANICI onayi bekle
   - NEEDS-WORK / BLOCKED → fix-up plani yaz, dur

> **NOT (2026-05-04):** `main`'e merge artik prod'a otomatik deploy ETMEZ.
> `main` gelistirme integration dali; prod sadece GitHub Actions'tan manuel
> "Deploy to Production" workflow'u ile yayina alinir. Merge sonrasi smoke
> ve deploy adimlari kullanici tarafindan manuel tetiklendiginde calisir.

Dusuk-risk PR kategorisi (otomatik mergelenebilir):
- Pure i18n (sadece tr.json/en.json)
- CSS/typography/a11y degisikleri (no logic)
- Flag-gated yeni ozellikler (default off)
- Yalniz yeni bilesen ekleyen PR'lar (mevcut bilesenleri degistirmeyen)
- Docs-only / runbook / CLAUDE.md guncellemeleri

Audit-gated kategori (otomatik mergelenebilir, ASAGIDAKI 3 KOSUL TAMAMI saglanirsa):
1. PR'da bagimsiz pre-merge audit raporu var:
   `docs/ops/DEPLOY_SMOKE_<pr>_*_PRE_MERGE_AUDIT.md` veya esdeger
2. CI tum check'lerde yesil (PR Gate dahil)
3. PR DB migration veya billing/quota logic icermiyor

Bu kosullar altinda asagidaki kategoriler otomatik mergelenebilir:
- Auth/OAuth/token/cookie degisikligi (cookie/JWT unit test eslik etmeli)
- Backend API contract degisikligi (schema/integration test eslik etmeli)
- Pipeline orchestrator veya agent prompt degisikligi (golden test eslik etmeli)
- CI workflow / deployment script degisikligi (script/yml only, infra change yok)

3 kosulun herhangi biri eksikse audit-gated PR'lar mutlak high-risk gibi davranilir
ve kullanici onayini bekler.

Mutlak high-risk PR kategorisi (audit'le bile KULLANICI onayi sart):
- DB migration/schema degisikligi (irreversible — rollback rotasi yok)
- Billing/quota/limit logic (yan etki para etkili)
- External credential rotation (OAuth client secret, GitHub PAT, JWT secret)

### Smoke-Test → Issue Triage Dongusu (zorunlu)

Prod veya staging smoke-test sirasinda yeni bir bug kesfedildiginde
ASAGIDAKI ADIMLARI OTOMATIK CALISTIR — kullanicidan tekrar istek beklemeden:

1. **Log**: `docs/ops/PROD_SMOKE_BUGS_<date>.md` dosyasini ac/guncelle:
   - Her bug icin: `BUG-N`, severity (🔴🟠🟡🟢), konum, semptom, kok neden,
     onerilen fix, issue ID kolonu (TBD ile basla)
   - Ustteki "GitHub Issue Haritasi" tablosuna satir ekle
2. **Duplicate kontrolu**: `gh issue list --state all --limit 100` calistir.
   Yeni bug mevcut bir open/closed issue ile ortusuyor mu? Ortusuyorsa:
   - Open issue varsa → yeni yorum olarak "prod re-verify" / "yeni semptom"
     bilgisini ekle, issue ID'yi log'a yaz (yeni issue acma)
   - Closed issue varsa ve regresyon varsa → reopen et + yorum bas
3. **Yeni issue (sadece gercekten yeni bug icin)**: `gh issue create` ile
   detayli body (Observed, Repro, Root cause, Fix plan, Severity) + `bug`
   label. Issue numarasini log'a geri yaz.
4. **Stale issue temizligi**: Ayni anda `gh issue list --state open` cikti-
   sina bak. 30+ gun updatedAt'i olan, PR linki olmayan, supersede edilmis
   issue'lari kapat:
   - "Closing as superseded by #N" veya "No longer reproducible in vX.Y" yorumu
   - `gh issue close <N> --comment "..."`.
   - EMIN DEGILSEN kullaniciya sor, otomatik kapatma.
5. **Rapor**: Oturum sonunda kullaniciya ozet — kac issue acildi, kac
   yorum dusuldu, kac stale kapandi, acilan issue URL'leri.

Bu dongu **her smoke-test** sonrasi calistirilir (wave-1, wave-2, vb.).
Her yeni bug-log dosyasi AYNI GUN issue'lara baglanir — hicbir bug "sadece
markdown'da" kalmaz.

Duplicate issue patlamasini onlemek icin: yeni issue acmadan ONCE
`gh issue list --search "<key phrase>"` zorunlu. "BUG-N" numarasi kod/log
dosyasinda, issue numarasi GitHub'da — ikisi farkli namespace, log
dosyasi kopruyu tutar.

## PM → Senior → Developer Is Akisi (zorunlu)

Her dev oturumunda bu 3-katmanli hiyerarsi kullanilir. Detayli tasarim:
`docs/superpowers/specs/2026-04-18-senior-hierarchy-agent-office-design.md`

### Hiyerarsi

```
Kullanici istegi
      |
  [PM — main Claude session]   triage, oncelik, risk, kapsam
      |
  [Senior X]                   (Frontend | Backend | AI/Platform | QA)
      |  Agent tool (nested)
  [Developer agents]           somut kod yazimi, test
      |
  Senior review & unified diff -> PM
      |
  PM opens PR -> CLAUDE.md PR review + smoke-test dongusu
```

### Senior rolleri

| Senior | Domain | Ornek issue |
|---|---|---|
| **Sr Frontend** | React 19, Tailwind 4, Vite, chat UI, auth pages | UI bug, layout, state mgmt |
| **Sr Backend** | Fastify, Drizzle, auth, REST API, GitHub adapter, multipart | API bug, migration, perf |
| **Sr AI/Platform** | Claude API, Scribe/Proto/Trace agents, RAG, caching, streaming | prompt caching, token counter, RAG |
| **Sr QA** | Playwright, Cucumber/BDD, post-deploy smoke, Chrome MCP | e2e tests, smoke reports |

### Ne zaman delege edilir

**HER ZAMAN delege et:**
- >=3 dosya degisikligi
- >=100 LOC
- Yeni DB migration
- Yeni API endpoint
- Herhangi bir vision-gap feature
- Auth / billing / pipeline orchestrator degisikligi

**PM direkt yapabilir (delegasyon overhead gereksiz):**
- Typo / tek satir string fix
- README / docs-only degisiklik
- Revert of known-bad commit
- i18n key-only add (no logic)

### Agent tool invocation sablonu

PM senior'u soyle spawn eder:

```
Agent({
  subagent_type: "general-purpose",
  description: "Senior <Role> — issue #<N>",
  prompt: `
You are Senior <Role> Engineer for the AKIS platform.
Project: /Users/omeryasironal/Projects/akisflow
Read CLAUDE.md before anything.

Your task: Issue #<N> — <baslik>.
Context: <issue body, ilgili dosya yollari, acceptance criteria>

Responsibilities:
1. Plan the implementation (files, tests, migration).
2. Spawn Developer agents via Agent tool (subagent_type: general-purpose) for atomic tasks.
3. Integrate developer outputs into one coherent diff.
4. Run local quality gates: typecheck, lint, test:unit, build.
5. Update docs/agent-office/state.json at each milestone (working, dev spawn, complete).
6. Report back: summary, files changed, tests added, risks, followups.

Hard rules:
- NEVER push to main directly. PM opens the PR.
- NEVER modify .env files.
- NEVER bypass CLAUDE.md rules.
- temperature=0 for all agent prompts you write.
`
});
```

### Agent Office dashboard

- Path: `docs/agent-office/index.html`
- State: `docs/agent-office/state.json` (gitignored, ephemeral)
- Serve lokal: `python3 -m http.server 8088 --directory docs/agent-office`
- Erisim: `http://localhost:8088/index.html` (veya `file://` protokolune gore)
- Oturum basi PM `state.initial.json` -> `state.json` kopyalar
- PM ve Senior'lar her lifecycle transition'da (spawn, working, complete) state.json'u Write tool ile gunceller
- Kullanici istediginde Chrome MCP ile acilir: `tabs_create_mcp` + `navigate`

### Concurrency kurali

- Ayni dosya / ayni modul ise **sequential**
- Disjoint (farkli domain) ise **parallel** Agent call'lar tek mesajda
- Cakisma riski varsa PM sequential'a duserir

### ASLA

- Senior'un Senior'u spawn etmesi (sadece Senior -> Developer)
- Developer'in Developer'i spawn etmesi
- Ayni issue'da 2 senior paralel calismasi (merge conflict riski)
- state.json'i Developer'in dogrudan yazmasi (Senior aggregates)

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

> **STATUS (2026-05-04): PROD DORMANT.** akisflow.com is intentionally
> offline until the thesis project is complete. All AKIS containers,
> volumes (DB included), and the edge Caddy were torn down on the OCI VM.
> Ports 80/443 are free, the VM is still running but only `unisum-backend`
> (a separate, unrelated project) is active.
>
> **Bring prod back up** when ready: SSH `oci-prod`, then:
> ```
> cd /opt/akis/prod && docker compose up -d
> cd /opt/akis     && docker compose -f docker-compose.edge.yml up -d
> ```
> Backend will boot against an empty DB (volume was wiped). Migrations run
> automatically on first start.
>
> **Auto-deploy is disabled** (workflow_dispatch only) — main → prod
> never triggers automatically.

- **Production target:** `akisflow.com` — OCI x86_64 VM (`oci-prod` SSH alias), Docker Compose + Caddy
- **Prod path on VM:** `/opt/akis/prod/`
- **CI/CD:** GitHub Actions (ci.yml, pr-gate.yml, deploy-prod.yml)
- **Docker image:** `ghcr.io/omeryasironal/akis-platform-devolopment/akis-backend`
- **Deploy script:** `deploy/oci/prod/deploy.sh`
- Staging environment was retired earlier (single-env on `akisflow.com`).
  The `staging.akisflow.com → akisflow.com` 301 redirect in `devops/compose/Caddyfile.edge` is kept for graceful degradation of old links.
