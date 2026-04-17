# DB Volume Migration: `akis-staging-pgdata` → `akis-prod_prod_pgdata`

## When this applies

You hit this runbook because the production Deploy workflow's preflight safety
gate halted with:

```
DB volume migration required.
  Found: akis-staging-pgdata (legacy, has production data)
  Missing: akis-prod_prod_pgdata (new architecture)
```

## Background

The production stack is moving from a flat layout (single
`/opt/akis/docker-compose.yml` with Caddy + backend + db) to an
edge-split layout:

- `/opt/akis/prod/docker-compose.yml` — prod app + db
- `/opt/akis/docker-compose.edge.yml` — edge Caddy (ports 80/443)

The new prod compose declares volume `prod_pgdata` which Docker Compose
scopes to `akis-prod_prod_pgdata`. The legacy flat compose (also named
`akis-prod`) was historically seeded from a staging snapshot and carries
the volume name `akis-staging-pgdata`.

Running the new compose without migrating the data would create an empty
`akis-prod_prod_pgdata` and orphan the live production data.

## Prerequisites

- SSH access to the prod host as `ubuntu`
- Latest `prod-pre-deploy-*.dump` in `/opt/akis/backups/` (the previous
  deploy attempt creates one automatically)

## Steps

```bash
ssh ubuntu@<PROD_HOST>
cd /opt/akis

# 1. Take a fresh dump from the running legacy DB — do not skip this.
BACKUP="/opt/akis/backups/prod-pre-migration-$(date -u +%Y%m%d-%H%M%SZ).dump"
docker exec akis-prod-db pg_dump -U akis -Fc akis_prod > "$BACKUP"
ls -lh "$BACKUP"   # sanity-check the size (should be >0, typically several MB)

# 2. Stop the legacy stack (keeps volumes).
docker compose -f /opt/akis/docker-compose.yml down

# 3. Create the new named volume and load the dump into it via a
#    throwaway postgres container. The volume name must match what the
#    new compose expects: akis-prod_prod_pgdata.
docker volume create akis-prod_prod_pgdata

docker run --rm \
  -v akis-prod_prod_pgdata:/var/lib/postgresql/data \
  -v /opt/akis/backups:/backups:ro \
  -e POSTGRES_USER=akis \
  -e POSTGRES_PASSWORD="$(grep ^POSTGRES_PASSWORD /opt/akis/prod/.env | cut -d= -f2-)" \
  -e POSTGRES_DB=akis_prod \
  postgres:16-alpine bash -c '
    docker-entrypoint.sh postgres &
    PG_PID=$!
    until pg_isready -U akis; do sleep 1; done
    pg_restore -U akis -d akis_prod --clean --if-exists "/backups/$(basename '"$BACKUP"')"
    pg_ctl -D /var/lib/postgresql/data -m fast stop
    wait $PG_PID
  '

# 4. Re-run the Deploy workflow. The safety gate will now pass because
#    akis-prod_prod_pgdata exists.
```

## Rollback

If anything goes wrong during step 3, the legacy volume
`akis-staging-pgdata` is untouched. Bring the old stack back with:

```bash
docker compose -f /opt/akis/docker-compose.yml up -d
```

## After successful migration

Once the new edge-split stack is running and verified healthy, the legacy
volume can be removed (optional, reclaim disk):

```bash
docker volume rm akis-staging-pgdata
```
