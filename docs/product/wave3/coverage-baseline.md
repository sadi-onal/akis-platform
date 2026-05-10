# Coverage Baseline — PDP-2 Sonu

**Tarih:** 2026-05-10 (PDP-2 dalgası tamamlandıktan sonra)
**Yöntem:** Test/source LOC oranı + test sayıları + 04-quality.md NFR-3/NFR-4 hedeflerine göre boşluk analizi.
**Not:** Bu rapor `@vitest/coverage-v8` veya `c8` ile **doğrudan satır kapsamı** ölçmüyor — paket henüz kurulu değil. Sayısal kapsam ölçümü için bir sonraki dalgada coverage paketi eklemek + CI'ya gate eklemek hedefleniyor.

---

## 1. Test/source LOC oranı (proxy metrik)

| Paket | Source LOC | Test LOC | Test/Source oranı | Yorum |
|---|---:|---:|---:|---|
| Backend | 58,308 | 53,149 | **0.91** | Yüksek — pipeline core + agents + AI service yoğun test edilmiş |
| Frontend | 23,472 | 10,129 | **0.43** | Orta — components iyi covered, hooks + pages için boşluk var |

**Güven aralığı:** test/source ≥ 0.5 genellikle iyi unit kapsamı işaret eder; ≥ 0.8 ise integration testler dahil çok güçlü kapsam. Backend bu eşiği aştı; frontend yarısında.

---

## 2. Test sayıları (PDP-2 sonu)

| Paket | Sayı | PDP-2 öncesi | Δ | NFR-3 hedefi (04-quality) | Durum |
|---|---:|---:|---:|---:|---|
| Backend (unit + integration) | ~3,260 | ~3,179 | +81 | ≥ 220 (PDP-2 hedef) | ✅ aşıldı (15× üstünde) |
| Frontend (vitest) | 860 | 813 | +47 | ≥ 90 (PDP-2 hedef) | ✅ aşıldı (9.5× üstünde) |
| E2E (Playwright) | 12 spec | 10 spec | +2 | ≥ 14 | 🟡 12/14 (intent disambiguation + chat-qa eksik) |

PDP-2 dalgası test piramidini gerçekten dengeledi (unit %70, integration %25, e2e %5'e yakın oran).

---

## 3. Coverage gap (04-quality NFR-3 ↔ mevcut)

NFR-3 ise sayısal kapsam hedefi:
- Backend ≥ %75 line coverage
- Frontend ≥ %70 line coverage

Manuel inceleme + LOC oranıyla tahmini durum:

### Backend (tahmini ~%75-80 covered)

✅ **Çok iyi covered:**
- `pipeline/core/explainability/` — reasoning factory + service unit + integration (PDP-2)
- `pipeline/core/regression/` — service + factory + route handler
- `pipeline/agents/{scribe,critic,proto,trace}` — her agent için ayrı suite
- `pipeline/agents/proto/ScaffoldEnricher.ts` — 45 unit + 3 integration suite (F-08, PDP-2)
- `pipeline/core/intent/IntentClassifier.ts` — unit + integration (F-10, PDP-2)
- `pipeline/core/chat-qa/ChatQAService.ts` — unit + integration (F-09, PDP-2)
- `services/auth/` — JWT, OAuth, GitHub token resolver
- `services/ai/` — provider abstraction + circuit breaker

🟡 **Orta covered (gap aday):**
- `pipeline/core/learning/` — LearningService bazı path'ler test'siz
- `pipeline/core/security-gate/` — sadece happy path
- `services/billing/` — production dormant, low priority
- `services/embedding/` — RAG ilgili; F-09 follow-up'ında genişler
- `api/admin.ts` — admin tools, edge case'ler

🔴 **Düşük covered:**
- `migrations/` — entry tests yok (manuel test var, NFR-1 ile beraber gelmesi planlandı)
- `templates/` — template'ler unit test edilmemiş, integration üzerinden dolaylı

### Frontend (tahmini ~%65-70 covered)

✅ **Çok iyi covered:**
- `components/chat/*` — ChatPanel, ChatHeader, ClarificationCard, AgentStartedLine, **ChatRouter** (F-10), **ChatMessage** (F-09)
- `components/pipeline/*` — ExplanationPanel, AttentionBanner, PipelineCinema, PipelineDetailRail, RegressionPanel, ConfidenceBadge
- `components/onboarding/GithubConnectGate` — vitest + playwright e2e
- `services/api/*` — workflows, chatQa, chatIntent, HttpClient
- `utils/*` — mapPipelineEvent, conversationToChatMessages, cn

🟡 **Orta covered:**
- `pages/chat/ChatPage.tsx` (1100+ satır) — mount test + integration test bazılarını kapsıyor; F-06 refactor sonrası hook bazlı 80%+ hedefi gelir
- `pages/settings/*` — Integrations, Profile bazı edge case'ler eksik
- `hooks/usePipelineStream` — SSE handling unit test bazları var, gerçek-zamanlı senaryolar manuel

🔴 **Düşük covered:**
- `pages/landing/*` — sadece smoke test
- `pages/dashboard/*` — entry test, etkileşimler yok
- `components/ui/*` — bazıları (Skeleton, Pill) sadece smoke

---

## 4. Eksik test alanları — sonraki dalga (PDP-3) önerisi

Sıralama: en yüksek leverage önce.

| # | Alan | Öneri | NFR bağı | Tahmini efor |
|---|---|---|---|---:|
| 1 | F-09 ChatQA RAG full integration tests | `RAGService` mock yerine gerçek pgvector retrieval | FR-10.2 | M |
| 2 | F-06 ChatPage refactor sonrası hook test'leri | `useConversationLoader`, `useGithubOAuthRestore` ≥ 80% | F-06 NFR teknik borç | L |
| 3 | E2E disambiguation flow + chat-qa SSE | 2 yeni Playwright spec | FR-11.3 + FR-10 | M |
| 4 | Coverage tooling kurulumu | `@vitest/coverage-v8` + `c8` + CI gate | NFR-3.5 | S |
| 5 | `pages/dashboard/*` etkileşim test'leri | metrics polling + filter | NFR-3.2 | M |
| 6 | Migration up/down test'leri | drizzle migration roundtrip | NFR-1 | M |
| 7 | a11y audit (axe-core in Playwright) | NFR-4.2 0 critical/serious | NFR-4 | S |
| 8 | `services/billing/*` test'leri | production dormant ama future-proof | — | M |

---

## 5. CI gate matrisinde durum (04-quality § 4)

| Gate | Şu an | Hedef (PDP-2 sonu) | Durum |
|---|---|---|---|
| Backend typecheck | ✅ blocker | ✅ blocker | ✅ |
| Backend lint | ✅ blocker | ✅ blocker | ✅ |
| Backend unit test | ✅ blocker | ✅ blocker | ✅ |
| Backend integration test | ✅ blocker | ✅ blocker | ✅ |
| Frontend typecheck/lint/test/build | ✅ blocker | ✅ blocker | ✅ |
| FR-link in commit (pre-commit hook) | ⚠️ wired ama opt-in | ✅ blocker | 🟡 hook kuruldu, settings.json'a wire kullanıcı tarafında |
| i18n key sync | 🔴 yok | ✅ blocker | 🟡 F-12 audit'i bunun temeli, sonraki dalgada CI'a |
| Bakkal-language lint | 🔴 yok (F-12 manuel) | ⚠️ warn-only başla | 🟡 sonraki dalga |
| Lighthouse Performance ≥ 80 | 🔴 yok | ⚠️ warn-only | 🟡 NFR-3.5 sonraki dalgada nightly |
| axe-core a11y | 🔴 yok | ✅ blocker | 🟡 NFR-4.2 sonraki dalgada |

---

## 6. Sonuç

PDP-2 dalgası test piramidini ciddi şekilde güçlendirdi (BE +81, FE +47 testler). Fakat **sayısal kapsam ölçümü** henüz CI'da yapılmıyor; bir sonraki dalga için ilk iş `@vitest/coverage-v8` kurulumu + CI gate (warn-only) olması beklenir.

**Bakkal-personası açısından:** çıktının kalitesi konusunda kullanıcının görsel kanıtları (Critic findings + Trace coverage matrix + Regression report) artık DB-backed kalıcı (NFR-1 ✅). Bu noktadan itibaren gerçek kullanıcı testi (NFR-5.4 — Q2 self-pilot v2) yapılabilir.
