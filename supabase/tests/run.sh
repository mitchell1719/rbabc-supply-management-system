#!/usr/bin/env bash
# Applies the stub + migrations + seed to a fresh database, then runs the workflow tests.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists rbabc_test" -c "create database rbabc_test"
for f in tests/supabase_stub.sql migrations/*.sql seed.sql tests/workflow_test.sql; do
  echo "== $f"; $P -d rbabc_test -f "$f"
done
echo "All migrations and workflow tests passed."
