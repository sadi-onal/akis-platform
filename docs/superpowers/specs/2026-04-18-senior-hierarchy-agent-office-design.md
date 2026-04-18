# Senior Hierarchy Workflow + Agent Office — Design Spec

- **Tarih:** 2026-04-18
- **Yazar:** Claude (Ömer Yasir Onal adına)
- **Versiyon:** 0.1 (onaylandı, implementation-ready)
- **İlgili:** CLAUDE.md, docs/AGENTS.md, 9 açık GitHub issue

## 1. Problem

Açık 9 issue, 3 farklı alan (UI bug, AI/platform feature, security tech-debt). Her birini tek Claude oturumunda "hepsini ben yaparım" tarzında halletmek üç şeyi kaybettiriyor:

1. **PM perspektifi** — öncelik, risk, kapsam önceden triage edilmiyor.
2. **Uzmanlaşma** — AI feature ile UI bug aynı düşünme çerçevesinden çıkıyor.
3. **Görünürlük** — "şu an ne yapılıyor, kim ne kadar ilerledi" opak.

Çözüm: **kalıcı PM → Senior → Developer** iş akışı + **canlı görsel ofis** (kim ne yapıyor).

## 2. Yüksek seviye özet

```
Kullanıcı isteği
      ↓
  [PM — main Claude]                      (triage, öncelik, kapsam, risk)
      ↓  Agent tool call
  [Senior X]  (Frontend | Backend | AI | QA)   (tasarım, implementasyon planı)
      ↓  nested Agent tool call (0..N)
  [Developer agents]                       (somut kod yazımı, test)
      ↓
  Senior review & merge (tek bir diff olarak PM'e döner)
      ↓
  PM: PR oluştur → CLAUDE.md PR review + smoke-test döngüsü
      ↓
  Merge + prod deploy + smoke-test + issue close
```

Tüm bu adımlarda `docs/agent-office/state.json` güncellenir. Lokal HTML dashboard o state'i gösterir.

## 3. Senior hiyerarşisi

### 3.1 Roller

| Senior | Domain | Araçlar | Örnek issue |
|---|---|---|---|
| **Senior Frontend** | React 19, Tailwind 4, Vite 7, Router 7, Chat UI | vitest, typecheck, lint | #427 iter duplicate, #425 stuck step-2 UI kısmı |
| **Senior Backend** | Fastify 4, Drizzle, PostgreSQL, auth, REST API, file upload, GitHub REST adapter | node test, typecheck, lint | #429 /api/github/repos, #425 /discover hang, #398 token encryption |
| **Senior AI/Platform** | Claude API (Anthropic SDK), pipeline agents (Scribe/Proto/Trace), RAG/pgvector, prompt caching, streaming | vitest, mock AI service | #436 prompt caching, #437 per-chat model, #438 token counter, #439 chat-level RAG |
| **Senior QA** | Playwright e2e, Cucumber/BDD toggle, post-deploy smoke, Chrome MCP | Playwright, claude-in-chrome | #397 Cucumber toggle, tüm post-deploy smoke-test'ler |

### 3.2 Yetki & sorumluluk

**PM (main Claude session)**
- Issue triage (öncelik, scope, risk, karmaşıklık)
- Senior seçimi
- `state.json` genel koordinasyonu
- Senior çıktısını review & PR oluşturma
- CLAUDE.md PR review loop'u tetikleme
- Smoke-test raporlama & issue kapama

**Senior (Agent tool subagent)**
- Issue'yu alır, kendi domain'inde planlar
- Plan: hangi dosyalar, hangi testler, hangi migration
- Developer agent'ları (nested Agent call) ile kod yazar
- Developer output'larını birleştirir, uyumlu tek diff üretir
- Local quality gates çalıştırır (typecheck, lint, test:unit, build)
- PM'e rapor döner (yapılan değişiklikler, test sonuçları, risk notu)

**Developer (Senior'un nested Agent call'u)**
- Atomik kod yazar (tek dosya / küçük alan)
- Test ekler
- Senior'a diff döner
- Review kendi boyutunda değil

### 3.3 Ne zaman delege edilir, ne zaman edilmez

**Her zaman delege et:**
- ≥3 dosya değişikliği
- ≥100 LOC
- Yeni DB migration
- Yeni API endpoint
- Herhangi bir vision-gap feature (#436-439 gibi)
- Auth, billing, pipeline orchestrator değişikliği

**PM direkt yapabilir:**
- Typo / tek satır string fix
- README / docs-only değişiklik
- Revert of known-bad commit
- i18n tr.json/en.json sadece key ekleme (no logic)

### 3.4 Concurrency

- **Sequential** eğer aynı dosya / aynı modül etkileniyorsa
- **Parallel** eğer disjoint (örn. #429 backend + #427 frontend aynı anda)
- PM, `state.json`'da çakışma varsa sequential'a düşürür

### 3.5 Mekanizma (Claude Code Agent tool)

PM senior'u şöyle spawn eder:

```
Agent({
  subagent_type: "general-purpose",
  description: "Senior <Role> — issue #<N>",
  prompt: `
You are Senior <Role> Engineer for the AKIS platform.

Context: <ilgili CLAUDE.md bölümleri, issue body, ilgili dosya yolları>

Your task: Issue #<N> — <başlık>.

Responsibilities:
1. Break the task into 1-N atomic developer tasks.
2. For each, spawn a Developer agent via the Agent tool (subagent_type: general-purpose).
3. Integrate developer outputs into one coherent diff.
4. Run local quality gates (typecheck, lint, test:unit, build) — fix any failures.
5. Update docs/agent-office/state.json with your progress at each milestone.
6. Report back: summary, files changed, tests added, risks, followups.

Hard rules:
- NEVER push to main directly. PM will open the PR.
- NEVER modify .env files.
- NEVER bypass CLAUDE.md rules.
- temperature=0 for all agent prompts you write.
`
});
```

## 4. Agent Office — görsel dashboard

### 4.1 Dosya yerleşimi

```
docs/agent-office/
├── index.html          # Tek dosya, embedded CSS + JS
├── state.json          # Canlı state (gitignore edilir, ephemeral)
├── state.initial.json  # Oturum başı varsayılan (kaynak kontrollü)
├── README.md           # Nasıl açılır, nasıl kullanılır
└── .gitignore          # state.json'u ignore
```

### 4.2 state.json şema (strict)

```json
{
  "ts": "ISO-8601 timestamp",
  "pm": {
    "status": "idle | triaging | reviewing | creating_pr",
    "task": "string | null",
    "issueNumber": "number | null"
  },
  "seniors": {
    "frontend": {
      "status": "idle | planning | working | reviewing",
      "task": "string | null",
      "issueNumber": "number | null",
      "devs": [
        { "id": "string", "status": "spawning | working | done", "task": "string" }
      ]
    },
    "backend":  { /* aynı şema */ },
    "ai":       { /* aynı şema */ },
    "qa":       { /* aynı şema */ }
  },
  "log": [
    "[HH:MM:SS] event string (append-only, max 100 satır)"
  ]
}
```

### 4.3 HTML render

- **Canvas**: 960×600 logical, responsive scale up (max 1920×1200)
- **Tilemap**: 30 kolon × 18 satır, 32px logical tile = 64px rendered (2x)
- **Karakter sprite**: 16×16 logical, `image-rendering: pixelated`, Canvas-drawn
- **Polling**: 500ms `fetch('./state.json')` → diff uygula
- **Status bubble**: DOM overlay (absolute positioned), ≤24 karakter
- **Activity log**: sağ alt scrollable div, son 20 event

### 4.4 Karakter slotları (sabit grid)

```
Col:    0         10         20         30
Row 0:  🌿  ┄┄┄  AKIS AGENT OFFICE  ┄┄┄  🪟
Row 4:                      [PM]
Row 8:  [Sr FE]     [Sr BE]     [Sr AI]     [Sr QA]
Row 10: [dev][dev][dev] | [dev][dev][dev] | ... | ...
Row 14: ━━━━━━━━━━━━━━━━━━━ ACTIVITY LOG ━━━━━━━━━━
```

### 4.5 Karakter renk paleti

| Karakter | Primary | Secondary | Aksesuar |
|---|---|---|---|
| PM | `#2E4A7D` (navy) | `#F5C76C` (gold tie) | klipboard 📋 |
| Sr Frontend | `#E8823E` (orange) | `#FFF` | fırça 🖌 |
| Sr Backend | `#3FA85E` (green) | `#1A1A1A` | terminal ⌨ |
| Sr AI | `#8B5CF6` (purple) | `#E0D4F7` | chip 🧠 |
| Sr QA | `#F0F0F0` (lab white) | `#FF6B6B` | büyüteç 🔍 |
| Developer | `#9AA0A6` (gray) | `#607D8B` | baret 👷 |

### 4.6 Animasyon (basic)

- **Idle**: 2 frame loop (breathe), 800ms
- **Working**: 2 frame loop (type), 300ms + status bubble
- **Walking**: tile-to-tile interpolation, 400ms, yalnız delegation ve complete anında
- **Spawn**: opacity 0 → 1, 300ms ease-in
- **Despawn**: opacity 1 → 0, 300ms ease-out

### 4.7 Status-bubble içeriği

- Max 24 karakter
- Format: `"<verb-ing> <object>"` (örn: `"fixing #429"`, `"writing CacheService"`)
- Claude her `Write state.json` sırasında günceller

### 4.8 Activity log

- Append-only, max 100 satır (FIFO)
- Format: `[HH:MM:SS] <actor> → <action> <subject>`
- Örnek: `[13:45:22] PM → assigned #436 to Sr AI`

## 5. CLAUDE.md değişiklikleri

`CLAUDE.md`'ye yeni bir bölüm eklenecek, "Kritik Kurallar" ile "AI Provider Yapılandırması" arasına:

### Yeni bölüm: "PM → Senior → Developer İş Akışı (zorunlu)"

İçerik özeti:
- Hiyerarşi açıklaması (PM, 4 Senior, Developer)
- Ne zaman delege edilir, ne zaman edilmez (§3.3)
- Agent tool spawn şablonu (§3.5)
- `docs/agent-office/` tool'unun rolü
- Her oturum başı: `state.initial.json` → `state.json` kopyala, Chrome MCP ile ofisi aç

## 6. Rollout planı (9 issue)

### Aşama 1 — Bugfix dalgası (paralel mümkün olduğunca)

| # | Issue | Senior | Tahmini süre | Risk |
|---|---|---|---|---|
| 1 | #429 `/api/github/repos` ERR_CONNECTION_REFUSED | Sr Backend | 30 dk | Low (net hata) |
| 2 | #427 iteration duplicate + silent | Sr Frontend | 45 dk | Medium (UI state) |
| 3 | #425 `/api/engineer/discover` 41s hang | Sr Backend | 60 dk | Medium (perf) |

### Aşama 2 — Vision features (sequential — birbirine bağımlı olabilir)

| # | Issue | Senior | Süre | Risk |
|---|---|---|---|---|
| 4 | #436 Anthropic prompt caching | Sr AI | 2 saat | High (cost impact, cache key design) |
| 5 | #438 real-time token counter | Sr AI + Sr FE | 90 dk | Medium (streaming usage) |
| 6 | #437 per-chat model picker | Sr AI + Sr FE | 60 dk | Low (UI + request param) |
| 7 | #439 chat-level RAG | Sr AI + Sr BE | 3 saat | High (pgvector, scoping, recall) |

### Aşama 3 — Tech-debt / verify

| # | Issue | Senior | Süre | Risk |
|---|---|---|---|---|
| 8 | #398 users.githubToken encryption | Sr Backend | 90 dk | High (auth, migration, backfill) |
| 9 | #397 Cucumber/BDD toggle | Sr QA | 2 saat | Medium (yeni entegrasyon) |

## 7. Quality gates (CEO mandate)

### Her PR öncesi (local)
- [ ] `pnpm -C backend typecheck`
- [ ] `pnpm -C backend lint`
- [ ] `pnpm -C backend test:unit`
- [ ] `pnpm -C backend build`
- [ ] `pnpm -C frontend typecheck`
- [ ] `pnpm -C frontend lint`
- [ ] `pnpm -C frontend test`
- [ ] `pnpm -C frontend build`

### PR sonrası (CLAUDE.md otomasyonu)
- [ ] superpowers:code-reviewer → READY (NEEDS-WORK ise blok)
- [ ] Low-risk ise auto-merge, high-risk ise user onayı
- [ ] GitHub Actions "Deploy to Production" → success
- [ ] Chrome MCP smoke-test on akisflow.com
- [ ] `docs/ops/DEPLOY_SMOKE_<pr>_<date>.md` raporu
- [ ] Issue kapat + body'ye link

## 8. YAGNI — yapılmayacaklar

- ❌ WebSocket (500ms polling yeterince canlı)
- ❌ Backend DB tablosu (agent_sessions) — dev tool kalsın
- ❌ Multi-user / remote state — tek kullanıcı lokal
- ❌ Sprite sheet / dış asset — Canvas ile çizim
- ❌ Ses efekti, animasyon zenginleştirme
- ❌ Persistent session history (state.json ephemeral)
- ❌ Senior'un Senior'u spawn etmesi (sadece Senior → Developer)
- ❌ Developer'ın Developer'ı spawn etmesi
- ❌ 5+ senior (Senior DevOps, Senior Security) — Sr Backend kapsar

## 9. Başarı kriterleri

### Oturum 1 (bu oturum) — altyapı + ilk dalga
1. `docs/agent-office/index.html` Chrome'da açıldığında 4 senior + PM görünür, state.json değişince animasyonlu güncellenir.
2. CLAUDE.md güncelleme sonrası yeni oturumlar otomatik bu akışı kullanır (persistent dokümante edilmiş).
3. Aşama 1 (bugfix dalgası — #429, #427, #425) tamamen fix'lenir, merge edilir, prod'a gider, smoke-test yapılır, issue'lar kapanır.
4. Her issue için ofis dashboard'u tüm PM → Senior → Developer aşamalarını canlı yansıtır.

### Oturum 2+ (sonraki oturumlar)
5. Aşama 2 (vision features #436-439) sequential olarak tamamlanır.
6. Aşama 3 (tech-debt #398, #397) tamamlanır.
7. Tüm 9 issue kapanır, regresyon yok.

## 10. İlişkili dökümanlar

- `CLAUDE.md` (güncellenecek)
- `docs/AGENTS.md` (mevcut pipeline agent'ları — Senior'lar farklı bir katman)
- `docs/AKIS_VISION.md` (vision features için)
- `docs/ops/` (smoke-test raporları)

---

**Onay**: Ömer Yasir Onal (Slack/message: "Onaylıyorum devam et", 2026-04-18)
**Sonraki adım**: `superpowers:writing-plans` skill'i ile implementation plan oluşturulacak.
