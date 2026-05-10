# 06 — Uygulama Yol Haritası (Roadmap)

**Status:** ✍️ Taslak — onay bekliyor
**Önceki bağlam:** [`00-README.md`](./00-README.md), [`01-requirements.md`](./01-requirements.md), [`02-ux.md`](./02-ux.md), [`03-architecture.md`](./03-architecture.md), [`04-quality.md`](./04-quality.md), [`05-findings.md`](./05-findings.md)

> **Disiplin:** Sıralı uygulama planı. Her PR self-contained: kendi spec referansı + acceptance criteria + test'leri + DoD checklist. Paralel çalışma sadece gerçekten bağımsız PR'lar arasında.

---

## 1. Genel akış (Gantt-vari)

```
Saat ─►   0   1   2   3   4   5   6   7   8   9  10  11  12
Wave 1    ████░░░ (paralel)  F-01 / F-02 / F-04
Wave 2          ██████░░░░░ F-11+F-03 (persistence)
Wave 3                ██████░ F-08 ScaffoldEnricher
Wave 4                      ██████ F-10+F-09 paralel (intent + chat-qa)
Wave 5                                ████ F-05 / F-07 / F-12 cleanup
```

**Toplam tahmini efor:** 10-12 aktif geliştirme saati. Paralelleştirme + tooling pack subagent'ları ile takvim süresi 1-2 gün.

---

## 2. Wave 1 — P0 + zincirli P1 fix'leri (paralel)

3 paralel subagent (worktree). Her biri tek dosyaya odaklanır, çakışma riski yok.

### PR 1.1 — `fix/F-01-chat-reload`

**Hedef:** F-01 — sohbetler arası geçiş sonrası eski içerik render edilmiyor.
**Branch:** `fix/F-01-chat-reload` (worktree: `../akis-f01`)
**Subagent:** code-implementer
**Brief:**
- `frontend/src/pages/chat/ChatPage.tsx` `handleNewConversation` (line ~503): `lastMessagesKeyRef.current = ''` ekle.
- Logout handler'da da reset.
- Test ekle: `ChatPage.tsx`'in mevcut testlerine + yeni `vitest` integration test.
**Acceptance:** 05-findings F-01 listesi, dört kabul kriteri.
**Tahmini efor:** XS (≤ 30 dk).
**Bağımlılık:** yok.

### PR 1.2 — `fix/F-02-rail-scroll`

**Hedef:** F-02 — Açıklama tab içinde scroll edilemiyor.
**Branch:** `fix/F-02-rail-scroll` (worktree: `../akis-f02`)
**Subagent:** code-implementer
**Brief:**
- `frontend/src/components/pipeline/PipelineDetailRail.tsx:302` body'sine `max-h-[60vh] overflow-y-auto` ekle.
- Vitest snapshot: class listesi içeriyor.
**Acceptance:** 05-findings F-02.
**Tahmini efor:** XS.
**Bağımlılık:** yok.

### PR 1.3 — `fix/F-04-rail-completed`

**Hedef:** F-04 — completed pipeline'da activities sıfırsa rail tamamen gizli.
**Branch:** `fix/F-04-rail-completed` (worktree: `../akis-f04`)
**Subagent:** code-implementer
**Brief:**
- `PipelineDetailRail.tsx:119` koşulunu `uiState === 'idle' && activities.length === 0 && !pipelineHasOutputs` yap.
- `pipelineHasOutputs` prop'u: parent'tan paslanır (proto/trace output bool).
- Vitest: completed + zero activities + outputs varsa render edilir.
**Acceptance:** 05-findings F-04.
**Tahmini efor:** S (~1 saat).
**Bağımlılık:** yok (F-11 ile pek ilgisi yok — F-04 UI'da gizleme kuralı, F-11 backend persistence).

**Wave 1 paralel dispatch komutu (orchestrator):**
```
/parallel \
  "fix F-01 — bkz 06-roadmap PR 1.1" | \
  "fix F-02 — bkz 06-roadmap PR 1.2" | \
  "fix F-04 — bkz 06-roadmap PR 1.3"
```

---

## 3. Wave 2 — Persistence (F-11 + F-03 birleşik)

### PR 2.1 — `feat/persist-reasoning-and-activities`

**Hedef:** NFR-1 + F-03 + F-11 — reasoning + activities DB-backed.
**Branch:** `feat/persist-reasoning-and-activities` (ana repo, worktree gerekmez)
**Subagent:** code-implementer (single track, bağımlılık zinciri yüksek)
**Brief:**
1. **DB schema** — `backend/src/db/schema/pipeline-reasonings.ts` + `pipeline-activities.ts` (03-architecture § 4.1, 4.2)
2. **Drizzle migration** — `pnpm -C backend db:generate` + `db:migrate`
3. **`ExplainabilityService`** refactor — write-through cache; `addReasoning` → in-memory + DB upsert. `getExplanation` → cache miss DB read.
4. **`ActivityEmitter`** — append + DB persist; `getRecentActivities(pipelineId)` DB query (mevcut ring buffer cache olarak kalır).
5. **Backfill stratejisi (default: skip)** — eski completed pipeline'lar için boş; UI'da "Bu pipeline persistence öncesi tamamlandı" mesajı (`PipelineDetailRail` veya `ExplanationPanel`).
6. **Integration test** — backend restart sonrası reasoning recovered.

**Acceptance:** 03-architecture D-4, D-5, D-6 + 04-quality NFR-1 satırları.
**Tahmini efor:** M (2-3 saat).
**Bağımlılık:** Wave 1 PR'larından bağımsız (farklı dosyalar). Ama Wave 1 önce merge edilirse sıralama temiz.
**Risk:** Migration test edilmeli; production DB hassas — bu PDP-2 prod dormant olduğundan risk düşük.

---

## 4. Wave 3 — Scaffold Enricher (F-08)

### PR 3.1 — `feat/scaffold-enricher`

**Hedef:** F-08 — Proto çıktısı taşınabilir hale gelir (FR-6.5..6.8).
**Branch:** `feat/scaffold-enricher`
**Subagent:** code-implementer
**Brief:**
1. `backend/src/pipeline/agents/proto/ScaffoldEnricher.ts` — stack tespiti + template render (03-architecture § 3.3)
2. Templates: `install.sh` (npm/pnpm/yarn varyantları), `setup.sh` (python venv), README sections (TR), `Dockerfile` (Node, Python başlangıç), `docker-compose.yml`, `.env.example` Türkçe yorumlu
3. ProtoAgent'a post-AI hook olarak entegre et
4. Unit testler: stack tespiti her stack için, template render her dosya için
5. Integration test: bir mock pipeline → enriched output assertion

**Acceptance:** 03-architecture D-14 + 04-quality FR-6.5..6.8 satırı.
**Tahmini efor:** M.
**Bağımlılık:** Wave 1 + 2'den bağımsız.

---

## 5. Wave 4 — Intent + Chat Q&A (paralel)

### PR 4.1 — `feat/intent-classifier`

**Hedef:** F-10 — IntentClassifier + frontend ChatRouter (FR-11).
**Branch:** `feat/intent-classifier` (worktree: `../akis-intent`)
**Subagent:** code-implementer
**Brief:**
1. **DB schema** — `intent_classifications` tablosu (03 § 4.3) + migration
2. **Backend** — `IntentClassifier` service + `POST /api/chat/intent` route + mock provider deterministic classifier
3. **Frontend** — `ChatRouter` component (FR-11.2 routing), `DisambiguationModal` (FR-11.3)
4. **`ChatPage.tsx`** — `handleSend`'i `ChatRouter`'a delegate et
5. Unit testler: 4 sınıf + low-conf path + override
6. E2E: disambiguation modal full round-trip

**Acceptance:** 03-architecture D-7..D-11 + 04-quality FR-11 satırı.
**Tahmini efor:** M.
**Bağımlılık:** Wave 1 (F-01 fix) iyi olur (ChatPage temiz state), ama zorunlu değil.

### PR 4.2 — `feat/chat-qa`

**Hedef:** F-09 — ChatQAService + SSE stream (FR-10).
**Branch:** `feat/chat-qa` (worktree: `../akis-chatqa`)
**Subagent:** code-implementer
**Brief:**
1. **Backend** — `ChatQAService` + `POST /api/chat-qa/ask` SSE route (03 § 3.2, 5.3)
2. **RAG entegrasyonu** — mevcut `RAGService` retrieve(spec + proto + findings, message)
3. **Frontend** — `ChatRouter` `ASK` handler `chatQaApi.ask`'e bağlanır
4. "Bu yeni feature gibi duruyor — build mi edelim?" suggestion logic'i
5. Test: mock provider answer + RAG retrieval + streaming
6. E2E: ASK intent → QA response

**Acceptance:** 03-architecture D-12, D-13 + 04-quality FR-10 satırı.
**Tahmini efor:** M.
**Bağımlılık:** **Wave 4.1 ile aynı `ChatRouter` dosyasına dokunur** — paralel yapılırsa son entegrasyonda merge conflict beklenir; ya 4.1 önce merge sonra 4.2 rebase, ya da ortak bir hazırlık PR'ında ChatRouter scaffold'u atılır.

**Wave 4 paralel dispatch (önerilen):**
```
/parallel \
  "feat F-10 intent — bkz PR 4.1" | \
  "feat F-09 chat-qa — bkz PR 4.2 (ChatRouter çakışmasına dikkat)"
```

---

## 6. Wave 5 — Cleanup (paralel)

3 küçük PR. Paralel veya seri, fark etmez.

### PR 5.1 — `fix/F-05-mode-badge`

**Brief:** ChatHeader'da mode badge'i ya **tooltip + Türkçe açıklama** olarak iyileştir, ya **kaldır** (UX karar). Default: tooltip.
**Acceptance:** 05-findings F-05.
**Efor:** S.

### PR 5.2 — `fix/F-07-clarify-counter`

**Brief:** ClarificationCard cevap sayacı seçim yapılınca anlık güncellensin (FR-3.2).
**Acceptance:** 05-findings F-07.
**Efor:** S.

### PR 5.3 — `chore/bakkal-language-audit`

**Brief:** F-12 — `scripts/lint/bakkal-language.mjs` audit script + i18n catalogue diff + Proto README üretici prompt revizyonu.
**Acceptance:** 05-findings F-12 + NFR-5.1 hedefi (≥ %95 tutarlılık).
**Efor:** S.

---

## 7. Sonraki dalgaya devr

| ID | Başlık | Sebep |
|---|---|---|
| F-06 | ChatPage refactor (1100+ → ≤ 500 satır) | L efor; mevcut testler yeterli koruma; PDP-2 etkisi düşük |
| Q4 manuel rubric scoring | tez veri toplama | tez aşamasına ait, ürün geliştirme dışında |
| Q2 self-pilot v2 | bakkal kullanıcı testi | NFR-5.4 release gate'i; PDP-2 sonu otomatik tetiklenir |

---

## 8. Definition of Done — paket bazında

**Bir wave done sayılır eğer:**
- Tüm wave PR'ları main'e merge
- Her PR'da DoD (04-quality § 5) doğrulanmış
- `06-roadmap.md` ilgili wave kutucukları check'lenmiş

**PDP-2 dalgası done sayılır eğer:**
- Wave 1-5 tamamlanmış
- Smoke walkthrough yeşil (mevcut + yeni feature'lar)
- Q2 self-pilot v2 sonucu rapor edilmiş (≤ 2 yardım talebi)
- Lighthouse + axe-core nightly CI yeşil
- 00-README'de tüm doc'lar ✅
- `learnings/benchmark-2026-may.md` PDP-2 sonu ile güncellenmiş

---

## 9. Risk yönetimi

| Risk | Etki | Azaltıcı |
|---|---|---|
| Wave 4 (ChatRouter) merge conflict | Düşük | 4.1 önce, 4.2 rebase; veya ortak prep PR |
| Wave 2 migration prod-dormant ama dev DB'yi etkiler | Düşük | Local rollback test edildi (drizzle down) |
| Wave 3 stack detection edge case | Orta | Unknown stack için graceful skip + README + .env-only |
| Wave 4 mock-real divergence | Orta | Real provider integration test nightly |
| Toplam efor öngörüsünden sapma | Orta | Wave 5 cleanup zamanlamada esnek |

---

## 10. Kabul kriterleri (bu doc için)

- [ ] Wave sıralaması mantıklı (P0 önce, sonra zincirli P1, sonra yokluk-gap'leri, sonra cleanup)
- [ ] Her PR'ın brief'i `code-implementer` agent'ın direkt çalışabileceği detayda
- [ ] Paralel/seri kararları gerekçeli (özellikle Wave 4.1 + 4.2)
- [ ] Risk listesi gerçekçi
- [ ] Tahmini eforlar (XS/S/M/L) tutarlı

---

## 11. Sonraki adım

PDP-2 paket onayı sonrası, **Wave 1** subagent dispatch'leri başlatılır. Tooling pack'in `.claude/agents/code-implementer.md` + `.claude/skills/parallel-implementation/SKILL.md` bu plan'ı operasyonel hâle getirir.
