# AKIS Platform — Development Constitution

Bu belge projenin geliştirme süreç kurallarını, kalite geçitlerini ve çalışma prensiplerini tanımlar. SDD (Spec-Driven Development) çerçevesinin "constitution" pillar'ı olarak hem AI agent'lar hem geliştiriciler tarafından takip edilir.

---

## 1. Session Disiplini

### 1 Session = 1 Concern = 1 PR

Her AI geliştirme session'ı **tek bir concern** (feature, bugfix, veya refactor) ile sınırlıdır. Session sırasında keşfedilen ilgisiz sorunlar not edilir, ayrı session'da ele alınır.

**Doğru**: `PR-T1: AI logging persistence` (tek concern)
**Yanlış**: `A1-A4 holistic + chat-history fix + z-index` (3 concern)

Paralel concern'lar için `/parallel` komutu kullanılarak her biri kendi worktree + branch + PR'ına ayrılır.

### Session Başlangıç Checklist

1. Session scope'unu tek cümlede tanımla
2. Mevcut spec/doc varsa oku (SDD Phase 1)
3. Yoksa önce spec yaz, sonra implement et
4. Session sonunda: commit + typecheck + lint + test

---

## 2. Spec-Driven Development (SDD) Akışı

Her non-trivial feature için 4 aşamalı SDD akışı takip edilir:

```
Specify → Plan → Tasks → Implement
    ↑ human review at each boundary ↑
```

### Phase 1: Specify
- Kullanıcı hikayesi, kabul kriterleri, kapsam dışı tanımları
- Konum: `docs/superpowers/specs/` veya `docs/product/`
- Çıktı: `spec.md` (proposal + acceptance criteria)

### Phase 2: Plan
- Teknik tasarım, dosya etki haritası, mimari kararlar
- Repository-scoped task tanımı (BE ve FE ayrı)
- Çıktı: `plan.md` (architecture + file impact map)

### Phase 3: Tasks
- Atomic, bağımsız iş kalemleri
- Her task'ın kendi done criteria'sı
- Çıktı: Numbered checklist veya task list

### Phase 4: Implement
- Her task bağımsız olarak implement + test edilir
- Task tamamlandığında gate çalıştırılır
- Çıktı: Commit(s) + passing gate

### Ne Zaman SDD Atlanabilir

- Tek dosyada < 20 satır değişiklik
- Salt i18n/typo/style düzeltmeleri
- Emergency hotfix (ama post-mortem yazılır)

---

## 3. Kalite Geçitleri (Gate SLA)

### Pre-commit Gate (Zorunlu)

Her commit öncesi `scripts/gate.sh` veya eşdeğeri çalışmalıdır:

| Gate | Komut | Beklenen |
|------|-------|----------|
| Backend typecheck | `pnpm -C backend typecheck` | 0 hata |
| Backend lint | `pnpm -C backend lint` | 0 hata |
| Backend unit test | `pnpm -C backend test:unit` | %100 pass |
| Frontend typecheck | `pnpm -C frontend typecheck` | 0 hata |
| Frontend lint | `pnpm -C frontend lint` | 0 hata |
| Frontend test | `pnpm -C frontend test` | %100 pass |
| Frontend build | `pnpm -C frontend build` | Başarılı |

### PR Gate (CI Otomatik)

| Gate | Workflow | Tetik |
|------|----------|-------|
| ci.yml | Her push | Typecheck + lint + unit test |
| pr-gate.yml | main'e PR | ci.yml + security audit + coverage (>=%70 FE lines) |
| nightly-smoke.yml | Hafta içi gece | Migration + Playwright E2E + CLI smoke |

### Coverage Eşikleri (NFR-3.5)

| Metrik | Frontend | Backend |
|--------|----------|---------|
| Lines | >= %70 | Henüz enforced değil |
| Statements | >= %65 | — |
| Functions | >= %60 | — |
| Branches | >= %55 | — |

---

## 4. Commit Disiplini

### Commit Mesaj Formatı

```
type(scope): kısa açıklama

[opsiyonel body]

FR-X.Y | F-XX | NFR-X.Y (traceability anchor)
```

**Type**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
**Scope**: `chat`, `pipeline`, `auth`, `scribe`, `proto`, `trace`, `critic`, `i18n`, vb.

`pre-commit-fr-link.sh` hook'u, kod değişikliği içeren commit'lerde FR-/NFR-/F- referansı zorunlu kılar. `AKIS_SKIP_FR_HOOK=1` ile bypass edilebilir (emergency only).

### Concern Separation

- Commit'ler tek concern taşır (BE veya FE, ikisi birden değil)
- PR'lar da tek concern taşır (bkz. Session Disiplini)
- PR başlığında "+" ile birleştirilen concern'lar = kırmızı bayrak

---

## 5. Branch Stratejisi

### İsimlendirme

```
{type}/{scope}-{kısa-açıklama}
```

Örnekler: `feat/scribe-clarification`, `fix/auth-session`, `docs/constitution`

### Yaşam Döngüsü

1. Main'den branch aç
2. Çalış, commit et
3. PR aç, CI geçsin
4. Squash-merge to main
5. **Branch'i sil** (lokal + remote)

### Worktree Yönetimi

- Worktree oluştur → çalış → merge → **temizle**
- `orchestrator.json`'daki worktree referansları merge sonrası "archived" yapılır
- Rutin: ayda 1 `git branch --merged main | xargs git branch -d` + `git remote prune origin`

---

## 6. Test Yazma Prensipleri

### Ne Zaman Test Yazılır

- Her yeni feature'da: implementation commit'iyle birlikte (TDD tercih edilir)
- Her bugfix'te: önce hatayı reproduce eden test, sonra fix
- Refactor'da: mevcut testler kırılmadığını doğrula

### Ne Zaman Test Atlanabilir

- Type-only değişiklikler
- Config/env değişiklikleri
- i18n string güncellemeleri
- Tek satırlık style düzeltmeleri

### Backend Test Runner

Node.js built-in test runner (`node --test`) via `tsx`. Vitest/Jest yok.

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
```

### Frontend Test Runner

Vitest + React Testing Library. E2E için Playwright.

---

## 7. Analiz → Aksiyon Pipeline

Analiz çalışmaları (dead-code sweep, simplifier scan, dependency audit) bir bulgu raporu üretir. Bulgular **48 saat kuralına** tabidir:

- **48 saat içinde**: Her bulgu ya uygulanır (PR açılır) ya "defer" etiketlenir (neden + ne zaman)
- **Defer edilen**: `.claude/state/backlog-YYYY-MM-DD.md`'ye eklenir
- **Uygulanmayan, defer edilmeyen**: Rapordan silinir (aksiyon almayacaksak analiz yapmayız)

---

## 8. Dokümantasyon Hiyerarşisi

```
CLAUDE.md                  → AI agent talimatları (session başında okunur)
docs/CONSTITUTION.md       → Süreç kuralları (bu belge)
docs/product/01-*.md       → PDP requirement + UX + architecture
docs/architecture/ADR-*.md → Mimari kararlar
docs/openapi.yaml          → API contract (source of truth)
docs/ops/                  → Deployment runbook'ları
```

### CLAUDE.md'nin Rolü

CLAUDE.md **sadece** AI agent talimatlarını içerir: proje yapısı, komutlar, mimari notlar, konvansiyonlar. İnsan onboarding'i ayrı tutulmalıdır.

---

## 9. Rollback Prosedürü

### Kırılan PR merge edilmişse

1. `git revert <merge-commit>` ile revert PR aç
2. CI geçsin
3. Merge et
4. Root cause analizi → ayrı fix PR

### Kırılan migration uygulanmışsa

1. **ÖNCELİKLE** backend'i durdur
2. Migration rollback: `pnpm -C backend db:rollback` (varsa) veya manual SQL
3. Backend'i eski commit'ten restart et
4. Fix migration → test → yeniden apply

### Production kırılmışsa

`docs/ops/` altındaki runbook'a başvur. `prod-db-reset.sh` **asla** onay almadan çalıştırılmaz.

---

## Değişiklik Geçmişi

| Tarih | Değişiklik |
|-------|-----------|
| 2026-05-24 | İlk sürüm — SDD akışı, gate SLA, session disiplini, commit kuralları |
