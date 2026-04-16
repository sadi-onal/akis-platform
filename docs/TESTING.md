# Test Rehberi (Canonical)

## Tek terminal — tam yerel gate (önerilen)

Workspace kökünde sırayla backend birim testleri, frontend birim + build, ardından Playwright E2E:

```bash
./scripts/run-local-gate.sh
```

> **Not:** Kök `package.json` workspace tanımlı değilse `pnpm -r …` yerine bu script veya aşağıdaki paket bazlı komutları kullanın. E2E bazı speclerde API mock kullanır; kırmızı testler çoğunlukla selector/i18n gecikmesi veya ortam kaynaklıdır — `frontend/playwright-report/` ve `test-results/` ile hata ayıklayın.

## Zorunlu Kalite Kapıları (pnpm workspace kullanan monorepolar)

Reponun kökünden çalıştırın:

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r build
pnpm -r test
```

## Paket Bazlı Komutlar

### Backend

```bash
pnpm -C backend test
```

### Frontend

```bash
pnpm -C frontend test
```

## Staging Doğrulama

- Release process: `docs/release/STAGING_RELEASE_CHECKLIST.md`
- Smoke checks: `docs/ops/STAGING_SMOKE_CHECKLIST.md`
- Rollback steps: `docs/deploy/STAGING_ROLLBACK_RUNBOOK.md`
