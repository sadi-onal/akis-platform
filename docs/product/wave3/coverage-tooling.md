# Coverage Tooling — Scaffold (PDP-3 hazırlığı)

**Status:** Scaffold landed 2026-05-11 (PR `chore/wave3-prep`); CI gate ⏭️ PDP-3'te.

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

## Eşikler (warn-only)

Frontend `vite.config.ts` `test.coverage.thresholds`:
- lines / statements / functions / branches: **50%** (warn-only baseline)

Bu eşikler PDP-2 sonu baseline (manuel tahmin: FE ~65-70%, BE ~75-80%). 50% şu an "asla altına düşme" çizgisi. PDP-3'te:
1. Gerçek coverage ölç → baseline'ı raporla
2. Eşikleri **75% / 70%** olarak ayarla (04-quality.md NFR-3 hedefi)
3. CI workflow'a ekle (`.github/workflows/coverage.yml` veya mevcut PR Gate)

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

## Gerçek baseline (2026-05-11)

İlk `test:coverage` çalıştırması sonucu — bu sayılar PDP-3 hedef ayarlamasının temelidir.

| Paket | Lines | Statements | Functions | Branches | NFR-3 hedef | Durum |
|---|---:|---:|---:|---:|---:|---|
| Backend | **79.13%** | 79.13% | 79.86% | 81.84% | ≥ 75% | ✅ aşıldı |
| Frontend | 41.97% | 41.21% | 40.45% | 40.54% | ≥ 70% | 🔴 hedef altında — PDP-3 ana iş |

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
