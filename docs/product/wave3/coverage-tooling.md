# Coverage Tooling — PDP-3 (NFR-3.5 hedefi karşılandı)

**Status:** Scaffold landed 2026-05-11 (PR `chore/wave3-prep`); **CI gate aktif PDP-3'te** (PR `feat/pdp-3-coverage-push`).

## Komutlar

### Frontend
```bash
pnpm -C frontend test:coverage
# Reporters: text (terminal), html → coverage/, json-summary → coverage/coverage-summary.json
```

### Backend
```bash
pnpm -C backend test:coverage
# Same reporters via c8. Excludes test files + __tests__.
```

## Eşikler — aktif

Frontend `vite.config.ts` `test.coverage.thresholds`:
- **lines: 70** (NFR-3.5 direct floor — regresyon halinde CI fail)
- statements: 65, functions: 60, branches: 55 (gerçek değerlere göre küçük tampon)

CI gate aktif: `.github/workflows/pr-gate.yml` `frontend-gate` job'una `Frontend Coverage Gate (NFR-3.5 ≥ 70% lines)` step eklendi. Threshold'un altına düşen PR otomatik fail eder.

## Çıktılar

| Konum | İçerik | Repo'da takip? |
|---|---|---|
| `frontend/coverage/` | HTML report + json-summary | gitignored |
| `backend/coverage/` | HTML report + json-summary | gitignored |
| `coverage/coverage-summary.json` | CI gate için JSON metrik | gitignored, ama CI artifact |

## CI gate önerisi (PDP-3)

```yaml
# .github/workflows/coverage.yml — sample
on: [pull_request]
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm -C frontend install --frozen-lockfile
      - run: pnpm -C frontend test:coverage
      - run: pnpm -C backend install --frozen-lockfile
      - run: pnpm -C backend test:coverage
      - name: Check thresholds
        run: |
          node -e "
            const fe = require('./frontend/coverage/coverage-summary.json');
            const be = require('./backend/coverage/coverage-summary.json');
            const FE_TARGET = 70, BE_TARGET = 75;
            if (fe.total.lines.pct < FE_TARGET) {
              console.error('FE coverage', fe.total.lines.pct, '< target', FE_TARGET);
              process.exit(1);
            }
            if (be.total.lines.pct < BE_TARGET) {
              console.error('BE coverage', be.total.lines.pct, '< target', BE_TARGET);
              process.exit(1);
            }
          "
```

## Gerçek baseline — PDP-2 sonu (2026-05-11, commit `057e164`)

İlk `test:coverage` çalıştırması sonucu — bu sayılar PDP-3 hedef ayarlamasının başlangıç noktasıydı.

| Paket | Lines | Statements | Functions | Branches | NFR-3 hedef | Durum |
|---|---:|---:|---:|---:|---:|---|
| Backend | **79.13%** | 79.13% | 79.86% | 81.84% | ≥ 75% | ✅ aşıldı |
| Frontend | 41.97% | 41.21% | 40.45% | 40.54% | ≥ 70% | 🔴 PDP-2 sonu — PDP-3 ana iş |

## Gerçek baseline — PDP-3 sonu (2026-05-11, PR [#532](https://github.com/OmerYasirOnal/akis-platform/pull/532))

4 paralel worktree subagent (A: services/api, B: pages+theme, C: utils+chat hooks, D: pages/auth) toplam **+359 yeni test** ekleyerek frontend coverage'ı NFR-3.5 hedefine taşıdı.

| Paket | Lines | Statements | Functions | Branches | NFR-3 hedef | Durum |
|---|---:|---:|---:|---:|---:|---|
| Backend | 79.13% | 79.13% | 78.45% | 81.02% | ≥ 75% | ✅ aşıldı |
| Frontend | **70.77%** | 69.38% | 66.46% | 62.70% | ≥ 70% | ✅ **karşılandı** |

**PDP-3 dalga sonuçları (PR `feat/pdp-3-coverage-push`):**

| Grup | Kapsam | Δ lines |
|---|---|---:|
| A | `services/api/*` — 10 fetch wrapper | +4.77pp |
| B | `pages/legal + settings + theme` — 4 file | +5.53pp |
| C | `utils/conversationToChatMessages` + 4 F-06 hook | +1.80pp |
| D | `pages/auth/*` — 8 file | +8.34pp |
| **Toplam** | **27 source file, 359 yeni test** | **+20.44pp** |

Threshold (`vite.config.ts` `test.coverage.thresholds`):
- lines: **70** (NFR-3.5 direct floor)
- statements: 65 (4pp tampon)
- functions: 60 (6pp tampon)
- branches: 55 (8pp tampon)

**Tahmin (LOC oranı) vs gerçek:**
- Backend tahmin ~75-80% → gerçek 79% ✓
- Frontend tahmin ~65-70% → gerçek 42% — LOC oranı yanılttı (test'ler component-yoğun, hooks/pages az covered)

**Frontend gap'i nereden:**
- `hooks/usePipelineStream`, `hooks/useReducedMotion`, `hooks/useScreenshotMode` — sıfır test
- `pages/dashboard/*`, `pages/landing/*`, `pages/settings/*` — sadece smoke
- `pages/chat/ChatPage.tsx` — 1409 satır, mount test'i partial cover (F-06 refactor sonra hook-bazlı %80+ hedeflenir)
- `utils/format.ts`, `utils/returnTo.ts`, `hooks/useTheme.ts` — sıfır test

**Threshold karar:**
- `vite.config.ts` `test.coverage.thresholds`: **35** (asla altına düşme çizgisi, %42 → %35 ~7-puan buffer)
- Gerçek hedef NFR-3.5 = ≥ %70 → PDP-3'te `lines: 70` olarak ayarlanır + CI gate açılır

> **Not:** Detaylı gap analizi için `coverage-baseline.md` adlı paralel doc PR [#524](https://github.com/OmerYasirOnal/akis-platform/pull/524)'te (`chore/wave2-followups` branch'i) — o PR merge edilince çapraz referanslı olacak.

## Düşük öncelikli not

Mevcut `vite.config.ts` halen build için `defineConfig` kullanıyor. Vitest config'i ayrı bir `vitest.config.ts`'e ayırmak modüler olur, ama mevcut yapı çalışıyor — PDP-3'te ayırmak gerekirse o zaman.
