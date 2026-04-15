#!/bin/bash
# Make a user admin by email address.
# Usage: ./scripts/make-admin.sh email@example.com
#
# Runs against the local Docker PostgreSQL container (akis-postgres).

set -euo pipefail

EMAIL=${1:?"Usage: ./scripts/make-admin.sh email@example.com"}

docker exec -i akis-postgres psql -U postgres -d akis_v2 -c \
  "UPDATE users SET role = 'admin', updated_at = NOW() WHERE email = '$EMAIL' AND role != 'admin';"

echo "Done: $EMAIL is now admin"
