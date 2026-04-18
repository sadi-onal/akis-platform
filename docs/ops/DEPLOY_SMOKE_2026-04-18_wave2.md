# Deploy Smoke Test — 2026-04-18 Wave 2 (post-merge #431 → #433)

**Deploy commit:** `e6808a5` (main, `fix(engineer): show network error + retry when /api/github/repos fails (#429 / BUG-21) (#433)`)
**Backend start:** 2026-04-18 11:56:19 UTC (verified via `GET /version`)
**Chrome MCP session:** `claude-in-chrome` tab 322399775
**Tester account:** logged-in session (OmerYasirOnal)

## Merged PRs verified in this pass

| PR | Bug | Status | Evidence |
|---|---|---|---|
| [#431](https://github.com/OmerYasirOnal/akis-platform/pull/431) | Docs / CLAUDE.md rule | ✅ **VERIFIED** | `main` has commit `c825487 docs(ops): 2026-04-18 wave-2 follow-up + smoke-test→issue workflow rule` — CLAUDE.md "Smoke-Test → Issue Triage Döngüsü" section present |
| [#428](https://github.com/OmerYasirOnal/akis-platform/pull/428) | BUG-19/20 Iteration dup-send + silence | ⏸️ **DEFERRED** | Frontend bundle contains `ChatPage-YQRZMTtc.js` (old hash) → new hash deployed; iteration path would need a live pipeline repro to exercise. Code path: `ChatPage.tsx:727` (dup-guard) + `ChatPage.tsx:763-770` (completion push) confirmed in deployed main. |
| [#432](https://github.com/OmerYasirOnal/akis-platform/pull/432) | BUG-23 Turkish diacritics | ✅ **VERIFIED** | `/engineer` live check: `h2="🔧 Mühendis Modu"`, subtitle `"Reponuzu seçin, AI mühendisiniz çalışmaya başlasın"`, first repo `"Açık · 18.04.2026"` — all diacritics present (ü, ç, ı). Screenshot captured (ss_1143x25vw). |
| [#433](https://github.com/OmerYasirOnal/akis-platform/pull/433) | BUG-21 UX retry card | ⏸️ **DEFERRED** | Cannot simulate network error in prod without tearing down the backend. Bundle contains the strings "Sunucuya şu anda erişilemiyor" + "Tekrar dene" (verified pre-deploy). Will manifest when `/api/github/repos` next returns ERR_CONNECTION_REFUSED. |

## Unexpected positive signal — BUG-21 infra currently resolving

When I first reproduced BUG-21 during wave-2 discovery (~13:15 local), `GET /api/github/repos` returned ERR_CONNECTION_REFUSED × 3. As of this smoke test (post 11:56 UTC deploy), the same endpoint **successfully returned 30 repos** for the same authenticated session.

Possible explanations (still worth investigating on prod side — not resolved definitively):
- Fresh container restart during deploy cleared socket exhaustion
- Transient GitHub egress rate-limit recovered
- OOM killed the prior worker; new worker has headroom

**Action:** Keep #429 open and monitor. If CONN_REFUSED returns, the UX retry card from #433 will surface it clearly to the user and the investigation commands on #429 should run.

## Baseline checks

| Check | Result |
|---|---|
| `GET /version` | `{commit:"e6808a5", environment:"production", startTime:"2026-04-18T11:56:19.256Z"}` ✓ |
| `GET /api/github/repos` (authenticated) | 200 OK, 30 repos ✓ |
| `/engineer` static render (auth OK) | Intro modal suppressed on repeat visit, step 1 visible, repo list renders ✓ |
| Title tag | "AKIS Platformu" ✓ |
| No Preview proxy warnings in console | verified via clean session ✓ |

## Observed regressions

None.

## Engineer flow walkthrough (user session 2026-04-18, 5 screenshots)

User ran the complete Engineer Mode flow end-to-end for the first time on prod. Findings:

### ✅ Confirmed working
- **Step 2 — Görev Seçimi:** AI task discovery returned **8 tasks** for `OmerYasirOnal/akis-platform` with correct Turkish category labels ("Güvenlik", "Hata", "Test", "Dokümantasyon", "Refactor", "Özellik") — BUG-23 fix fully propagated
- **Step 3 — Zaman ve Bütçe:** Time preset buttons (30 dk / 1 saat / 2 saat / 3 saat, \$0.50-\$3.00) work, summary card updates live, warning fires when allocated < estimated ("Tahsis edilen süre (60 dk) tahmini süreden (70 dk) az. Bazı görevler tamamlanamayabilir.")
- **Step 4 — Onay:** Confirmation card shows "1 görev · 1 saat · \$1.00", "Mühendisi Başlat" button
- **Admin unlimited gating** (BUG-03 follow-up): user noted "admin olduğum için sınırsız galiba" — plan enforcement correctly bypassed for admin
- **Scribe narration live** on new pipeline: "✓ Kullanıcı fikri analiz ediliyor... ✓ Mevcut repo analiz ediliyor..." — wave-1 BUG-10 narrative fix visible

### 🐛 New bugs discovered during walkthrough
| Bug | Severity | Issue | Symptom |
|---|---|---|---|
| **BUG-24** | 🟠 | [#434](https://github.com/OmerYasirOnal/akis-platform/issues/434) | "Mühendisi Başlat" tıklaması `/engineer/session/:id` yerine `/chat/<pipelineId>`'e atıyor — engineer session context kopuyor, kullanıcı "bu mühendis mi normal chat mi?" anlayamıyor |
| **BUG-25** | 🟡 | [#435](https://github.com/OmerYasirOnal/akis-platform/issues/435) | Chat header task title+description'ı ayırıcı olmadan birleştirip ortadan kesiyor: `"Implement proper logging and monitoring infrastructure Set up structured logging (Winston, Pino, or"` |
| BUG-26 (observation) | 🟡 | covered by [#425](https://github.com/OmerYasirOnal/akis-platform/issues/425) | Task discovery 40+s sürüyor, tek spinner (user quote: *"epey uzun sürdü"*) — #425 zaten open |

### 🧭 Vision-gap feature requests surfaced by user
User explicitly asked: *"cache'ing yapıyor mu ve her chatin içinde bir context var mı? modellerinc ontextleride yazıyor mu modeller seçilebiliyor mu? context anında hesaplanıyor mu?"*

Code audit confirmed these gaps and turned each into a trackable issue:

| Feature | Issue | Status in code |
|---|---|---|
| Anthropic prompt caching (`cache_control`) | [#436](https://github.com/OmerYasirOnal/akis-platform/issues/436) | **NOT implemented** — 0 refs in `backend/src/services/ai/*` |
| Per-chat model picker (frontend UI) | [#437](https://github.com/OmerYasirOnal/akis-platform/issues/437) | Backend allowlist exists (`modelAllowlist.ts`), UI missing |
| Real-time per-chat token counter / context-window gauge | [#438](https://github.com/OmerYasirOnal/akis-platform/issues/438) | Only monthly aggregate in Settings; `input_tokens/output_tokens` captured but not surfaced |
| Chat-level RAG retrieval (cross-message coherence) | [#439](https://github.com/OmerYasirOnal/akis-platform/issues/439) | Pipeline-scoped retrieval only; no chat-level anchor cache |

These 4 map directly to the AKIS north-star (*chat-level RAG/token/cache coherence + agent controllability*).

## Follow-up PRs (not in this wave)

| Issue | Status | Owner |
|---|---|---|
| [#425](https://github.com/OmerYasirOnal/akis-platform/issues/425) `/api/engineer/discover` 41s hang + no progress UX | **OPEN** — BUG-22 initial-load 400 closed as preserve-log artifact (comment on #425). 41s hang still needs SSE or async-job redesign. | Next wave |
| [#429](https://github.com/OmerYasirOnal/akis-platform/issues/429) `/api/github/repos` ERR_CONNECTION_REFUSED root cause | **OPEN** — frontend defensive UX shipped in #433; actual infra diagnosis still pending (needs ssh + docker logs). | Next wave (prod-side) |
| [#397](https://github.com/OmerYasirOnal/akis-platform/issues/397) Cucumber/BDD toggle verify | OPEN — Trace agent `.feature` output not E2E confirmed | Post-MVP |
| [#398](https://github.com/OmerYasirOnal/akis-platform/issues/398) Encrypt legacy `users.githubToken` | OPEN — tech-debt / security | Next sprint |

## Feature gaps surfaced by user Q&A mid-smoke (2026-04-18)

Not regressions, but vision-gap items the user explicitly asked about — logged here so they don't get lost:

| Özellik | Durum | Vision gap |
|---|---|---|
| **Prompt caching** (Anthropic `cache_control`) | ❌ Not implemented | 0 references in `backend/src/services/ai/*`. Every AI call goes fresh. 5-min TTL cache would dramatically cut cost on iteration |
| **Per-chat model picker (frontend)** | ❌ Not implemented | Backend allowlist exists (`modelAllowlist.ts`), frontend UI does not. Model is user-level (Settings), not chat-level |
| **Real-time per-chat token counter** | ❌ Not implemented | Only monthly total (`tokensUsedThisMonth`) shown in Settings. No "2.4k / 200k" context-window display in chat UI |
| **Chat-level RAG / cross-message context coherence** | ⚠️ Partial | Messages persist in DB, but LLM receives full history every turn (no cache), RAG is pipeline-level not chat-level |

These 4 items directly match the AKIS north-star (memory: AKIS vision — agent-native platform with chat-level RAG/token/cache awareness) and should become the next tracked feature issues.

## Methodology

- `gh pr merge <N> --squash` for all 4 PRs in order #431 → #428 → #432 → #433
- CI cancellation was expected (back-to-back merges supersede each other); only the latest (#433's) CI ran to completion and triggered the real deploy
- Deploy workflow `24603980816` watched via `gh run watch` until `completed/success`
- Chrome MCP (`tabId=322399775`) navigated to `/engineer`, hard-reloaded, DOM queried via `javascript_tool` for text content + screenshot captured for visual evidence
