-- Make a user admin by email address
-- Usage: psql -d akis_v2 -f scripts/make-admin.sql -v email="'engomeryasironal@gmail.com'"
-- Or:    docker exec -i akis-postgres psql -U postgres -d akis_v2 -f - < scripts/make-admin.sql

UPDATE users SET role = 'admin', updated_at = NOW()
WHERE email = 'engomeryasironal@gmail.com'
  AND role != 'admin';
