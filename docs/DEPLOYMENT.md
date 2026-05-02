# AKIS — Deploy Adımları

## Ortamlar

| Ortam | URL | Altyapı |
|-------|-----|---------|
| Local | localhost:5173 | Docker (PostgreSQL) + Node.js dev server |
| Production | akisflow.com | OCI Free Tier ARM64 VM |

> **Staging retired (2026-05-02):** Staging ortamı kaldırıldı; tek prod ortamı `akisflow.com` üzerinde. Eski `staging.akisflow.com` linkleri için Caddy edge proxy'sinde 301 redirect bırakıldı (`devops/compose/Caddyfile.edge`).

## Local Geliştirme

```bash
# PostgreSQL başlat
./scripts/db-up.sh

# Backend (DEV_MODE — auth bypass, otomatik dev user)
cd backend
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/akis_v2 \
  DEV_MODE=true npx tsx watch src/server.ts

# Frontend
cd frontend
pnpm dev
```

## Production (`akisflow.com`)

### Altyapı

- **VM**: OCI Free Tier Ampere A1 (ARM64, 4 OCPU, 24GB RAM)
- **Reverse Proxy**: Caddy 2 (otomatik HTTPS, Let's Encrypt)
- **Container**: Docker Compose
- **CI/CD**: GitHub Actions → SSH deploy (`.github/workflows/deploy-prod.yml`)

### Dosya Yapısı (Server)

```
/opt/akis/prod/
├── docker-compose.yml    # deploy/oci/prod/docker-compose.yml'den kopyalanır
├── Caddyfile             # deploy/oci/prod/Caddyfile'dan kopyalanır
├── .env                  # Gizli ortam değişkenleri (manuel oluşturulur)
├── frontend/             # Frontend build çıktısı (dist/)
└── repo-src/             # Backend kaynak kodu (CI tarafından kopyalanır)
```

### Deploy Akışı

1. GitHub Actions tetiklenir (`workflow_dispatch`, GitHub Environment: `production`, onay gerekebilir)
2. Frontend build yapılır (`pnpm -C frontend build`)
3. Backend kaynak kodu + Dockerfile sunucuya SCP ile kopyalanır
4. `deploy.sh` çalıştırılır:
   - GHCR'dan image pull dener (varsa)
   - Pull başarısızsa sunucuda local build yapar
   - DB migration çalıştırır
   - Backend container'ı force-recreate eder
   - Caddy config reload eder (zero-downtime)
5. Health check ile doğrulama

### Docker Compose Servisleri

| Servis | Image | Port |
|--------|-------|------|
| caddy | caddy:2-alpine | 80, 443 |
| backend | akis-backend:latest | 3000 (internal) |
| db | postgres:16-alpine | 5432 (internal) |
| mcp-gateway | akis-mcp-gateway:latest | 4010 (internal) |

### Dikkat Edilecekler

- `.env` dosyası sunucuda manuel oluşturulur, repo'da YOKTUR (`deploy/` git-ignored)
- Caddy, frontend static dosyalarını `/srv/frontend` altından sunar
- Backend sadece internal network'te expose edilir (Caddy arkasında)
- MCP Gateway, GitHub token gerektirir (PAT: repo + read:org)
- DB volume adı historical olarak `akis-staging-pgdata` (rename = data move; bkz. `devops/runbooks/db-volume-migration.md`)
- `AUTH_COOKIE_DOMAIN=akisflow.com` env vars'da set olmalı (auth loop fix; bkz. `docs/ops/AUTH_DEPLOY_RUNBOOK_2026-05-02.md`)

### Edge Proxy (graceful redirect)

- `devops/compose/docker-compose.edge.yml` + `devops/compose/Caddyfile.edge` — tek giriş noktası 80/443
- `akisflow.com` → prod backend
- `www.akisflow.com` → 301 → `akisflow.com`
- `staging.akisflow.com` → 301 → `akisflow.com` (eski linkler için)
