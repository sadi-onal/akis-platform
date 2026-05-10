# 04 — Kalite Stratejisi

**Status:** ✍️ Taslak — onay bekliyor
**Önceki bağlam:** [`00-README.md`](./00-README.md), [`01-requirements.md`](./01-requirements.md), [`02-ux.md`](./02-ux.md), [`03-architecture.md`](./03-architecture.md)
**Mevcut test rehberi:** [`docs/TESTING.md`](../TESTING.md)

> **Disiplin:** Her FR ve her NFR'in en az bir test'le bağlandığını garanti et. Testler kabul kriterlerini *kanıtlar*, beyan etmez. CI gate'leri yeşil olmadan PR merge edilmez.

---

## 1. Test piramidi

```
            ╱─────────────╲
           ╱   E2E (~5%)   ╲       Playwright — kritik kullanıcı yolları
          ╱─────────────────╲
         ╱  Integration ~25% ╲     Backend route + DB + service-to-service
        ╱─────────────────────╲
       ╱     Unit ~70%          ╲  Vitest (FE) + node:test (BE)
      ─────────────────────────────
```

### Mevcut taban

- **Backend** — 178 test (`pnpm -C backend test`), node:test runner
- **Frontend** — 58 test (`pnpm -C frontend test`), vitest
- **E2E** — 10+ Playwright spec (`frontend/tests/e2e/`)
- **CI** — GitHub Actions; backend + frontend ayrı job (PR Gate)

PDP-2 dalgası bu sayıları artıracak; hedef + ölçüm § 6'da.

---

## 2. Test stratejisi — FR'lere göre

Her FR (01-requirements'dan) için: hangi test türü gerekli + dosya yolu önerisi + acceptance assertion.

| FR | Unit | Integration | E2E | Acceptance test |
|---|---|---|---|---|
| FR-1 (auth) | hash/JWT pure fn | `/auth/*` route | login/signup spec'ler (mevcut) | "Yanlış parola → 401, doğru → 200 + cookie" |
| FR-2 (JIT GH gate) | `pendingGithubIdea` reducer | OAuth callback route | `github-oauth-gate.spec.ts` (mevcut, genişlet) | "Idea preserved across redirect, auto-resume çalışır" |
| FR-3 (Scribe clarify+spec) | `parseQuestions`, `validateSpec` | scribe.routes test | mock provider e2e | "Sayaç anlık, spec schema valid, plan card render" |
| FR-3.5 (plan stays active) | `conversationToChatMessages` (mevcut) | — | — | `critic_reviewing_spec` → status 'active' |
| FR-4 (Critic) | `criticPromptBuilder`, `findingsParser` | critic agent integration | — | "Findings'da severity + category zorunlu" |
| FR-4.2 (Critic UI rose) | `mapStageToUIState` (mevcut) | — | — | `critic_reviewing_*` → `'critic_running'` |
| FR-5 (approve/reject) | `handleApprove` reducer | `/api/pipelines/:id/approve` | spec onay e2e | "Çift-tıklama tek call, status approved" |
| FR-6 (Proto + scaffold) | stack detection, repo-name sanitize | proto agent run | — | "Repo açılır, push'lanır" |
| FR-6.5..6.8 (taşınabilirlik) | `ScaffoldEnricher` template render | proto integration | — | "install.sh executable, README TR sections var" |
| FR-7 (Trace) | gherkin parser | trace agent run | — | "Coverage matrix non-empty" |
| FR-8 (rail) | `PipelineDetailRail` (mevcut) | `/explanation` + `/regression` route | rail tab e2e | "Akış/Açıklama/Regresyon erişilebilir" |
| FR-8.4 (rail scroll) | snapshot test (CSS classes) | — | — | "body has overflow-y-auto + max-h" |
| FR-8.6 (rail visible at idle) | `PipelineDetailRail` render | — | — | "completed + zero activities + outputs varsa render" |
| FR-9 (iteration) | mevcut | iteration child polling | iteration e2e | "Child pipeline parent ref korunur" |
| FR-10 (chat Q&A) | `ChatQAService` answer composer | RAG + AI integration | qa e2e (mock) | "Pipeline tetiklenmez, RAG citations döner" |
| FR-11 (intent) | `IntentClassifier.classify` (mock) | real provider integration | disambiguation e2e | "≥ 0.7 routed; < 0.7 modal açılır" |
| FR-12 (sohbet yönetimi) | sidebar state | `/api/pipelines list` | mevcut | "Geçişte içerik kaybolmaz" (F-01 fix) |

---

## 3. Test stratejisi — NFR'lere göre

Her NFR sayısal hedef + ölçüm aracı + CI gate.

### NFR-1 — Kalıcılık

| Hedef | Test tipi | Araç | CI gate |
|---|---|---|---|
| Backend restart sonrası reasoning %100 geri | Integration | node:test, gerçek pg container | `pnpm -C backend test:integration` |
| Activities backfill yok mesajı doğru | Unit (FE) | vitest mock empty response | `pnpm -C frontend test` |
| Soft-delete query default'ta archived'ı gizler | Unit | drizzle query test | backend test |

### NFR-2 — Resilience

| Hedef | Test tipi | Araç | CI gate |
|---|---|---|---|
| AI provider 5xx → 3 retry | Unit | mock fetch fail | backend test |
| Network drop → polling backoff | Unit (FE) | vitest fake timers | frontend test |
| Cancel temiz durdurma | Integration | route + DB | backend test |

### NFR-3 — Performans

| Hedef | Test tipi | Araç | CI gate |
|---|---|---|---|
| TTI < 2s | Lighthouse CI | `lighthouse-ci` action | nightly (uyarı, blocker değil) |
| Sohbet geçişi < 200ms | Manual perf marker | `performance.mark` | manuel smoke |
| Lighthouse Performance ≥ 80 | Lighthouse CI | github action | PR gate (warn-only başlangıçta, sonra block) |

### NFR-4 — Erişilebilirlik

| Hedef | Test tipi | Araç | CI gate |
|---|---|---|---|
| 0 critical/serious axe-core | E2E + axe | `@axe-core/playwright` | PR gate |
| Klavye navigasyonu | E2E | playwright keyboard | nightly |
| WCAG AA kontrast | Static check | design tokens audit script | manuel |

### NFR-5 — Usability

| Hedef | Test tipi | Araç | CI gate |
|---|---|---|---|
| 5-dk think-aloud, ≤ 2 yardım talebi | Manuel | Q2 self-pilot v2 | release gate (dalga sonu) |
| Bakkal sözlüğü tutarlı | Lint | i18n catalogue scanner (custom) | PR gate |
| Mode badge ya açık ya yok | Manuel | UX review | per-PR |

### NFR-6 — i18n

| Hedef | Test tipi | Araç | CI gate |
|---|---|---|---|
| Missing-key 0 | Unit | vitest i18n test | PR gate |
| TR ↔ EN catalogue diff = 0 | Lint | jq diff script | PR gate |

---

## 4. CI gate matrisi

PR Gate (her PR'da çalışır):

| Gate | Komut | Süre | Bloker |
|---|---|---:|---|
| Backend typecheck | `pnpm -C backend typecheck` | <30s | ✅ |
| Backend lint | `pnpm -C backend lint` | <30s | ✅ |
| Backend unit test | `pnpm -C backend test` | <60s | ✅ |
| Backend integration test | `pnpm -C backend test:integration` | 2-3 min | ✅ |
| Frontend typecheck | `pnpm -C frontend typecheck` | <30s | ✅ |
| Frontend lint | `pnpm -C frontend lint` | <30s | ✅ |
| Frontend test | `pnpm -C frontend test` | <60s | ✅ |
| Frontend build | `pnpm -C frontend build` | 1 min | ✅ |
| i18n key sync | custom script | <10s | ✅ |
| Bakkal language lint | custom script | <10s | ⚠️ warn (önce uyar, sonra blocker) |
| FR-link in commit | `.claude/hooks/pre-commit-fr-link.sh` | <1s | ✅ |
| Acceptance check (gate-keeper agent) | `/gate-check` | manuel | ⚠️ önerilen |

Nightly Gate (1 günde 1 kez):

| Gate | Süre | Notlar |
|---|---:|---|
| Playwright e2e (full) | 5-10 min | LR provider gerekirse mock |
| Lighthouse CI | 2 min | warn-only |
| axe-core a11y | 3 min | critical/serious'ta blocker |
| Real-AI integration tests | 5-10 min | aylık dataset audit |

Release Gate (dalga sonu):

| Gate | Çıktı |
|---|---|
| Q2 self-pilot v2 | bakkal kullanıcı testi sonucu, ≤ 2 yardım talebi |
| Q4 manuel rubric | manuel scoring → Pearson r |
| Smoke walkthrough | uçtan uca canlı test |

---

## 5. Definition of Done (DoD)

Bir PR merge'lenmeye hazır sayılır eğer:

- [ ] FR/NFR/F-ID etiketi commit mesajında ve PR description'da var
- [ ] Yeni veya değişen kod için unit test eklenmiş; mevcut test failure yok
- [ ] Acceptance criteria (linkli FR/NFR'den) test ile kanıtlanmış
- [ ] PR Gate yeşil (yukarıdaki tablo)
- [ ] PR description'da: Özet + Test plan + Manuel test gerektiriyorsa not
- [ ] Eğer UI değişikliği: bakkal-language sözlük taraması yapıldı
- [ ] Eğer DB değişikliği: migration up + down test edildi
- [ ] Eğer yeni feature: `06-roadmap.md`'deki ilgili item check'lendi

---

## 6. Hedef metrikler (PDP-2 sonu)

| Metrik | Bugün | Hedef | Ölçüm |
|---|---:|---:|---|
| Backend test sayısı | 178 | ≥ 220 | `pnpm -C backend test` |
| Frontend test sayısı | 58 | ≥ 90 | `pnpm -C frontend test` |
| Playwright e2e spec sayısı | 10 | ≥ 14 | `frontend/tests/e2e/*.spec.ts` |
| Backend coverage | bilinmiyor | ≥ %75 | c8 report |
| Frontend coverage | bilinmiyor | ≥ %70 | vitest coverage |
| Lighthouse Performance (chat sayfası) | bilinmiyor | ≥ 80 | LH CI |
| axe-core critical findings | bilinmiyor | 0 | playwright + axe |
| Bakkal-language taraması | yok | %95 tutarlılık | custom lint |

Coverage hedeflerini ilk dalgada zorunlu kılmıyoruz; ölçümü açıyoruz, baseline'ı kayda alıyoruz, sonraki dalgada CI gate'leyebiliriz.

---

## 7. Test verisi & ortam

- **Mock provider** — pipeline tetiklemede default test profili. Deterministic, sıfır maliyet.
- **Real provider integration suite** — nightly, Anthropic key gerekli. Sayılı (≤ 10 spec) tut, maliyet kontrol altında.
- **Test DB** — `docker-compose.dev.yml`'in `pgvector/pgvector:pg16` image'ı. Her test suite başında `db:migrate`.
- **E2E test user** — `smoke-XXX@akis.local` deseni. DB'de aktif yapılır (mevcut walkthrough.mjs pattern).

---

## 8. Risk ve azaltıcı önlemler

| Risk | Azaltıcı |
|---|---|
| Coverage hedefi hızlı yetişemez | İlk dalgada warn-only; CI gate'i sonraki dalgada |
| Playwright flake | retries: 1; özellikle async timing'e dikkat |
| Real-AI integration ücreti | Nightly only; minimum spec sayısı |
| Bakkal-language linti false-positive | Whitelist + opt-out yorum (`// allow:term`) |

---

## 9. Kabul kriterleri (bu doc için)

- [ ] Test piramidi oranları gerçekçi
- [ ] Her FR ve NFR en az bir test'le eşleşmiş
- [ ] CI gate matrisi mevcut + yeni gate'ler ayrılmış
- [ ] DoD checklist comprehensive
- [ ] Hedef metrikler ulaşılabilir (koruyucu, agresif değil)
- [ ] Real-AI vs mock policy net

---

## 10. Sonraki adım

**05-findings revize**: 01-04 hedef hâline göre mevcut kod gap'ini güncelle. Sonra **06-roadmap**: writing-plans skill ile sıralı uygulama planı.
