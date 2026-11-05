#!/usr/bin/env bash
# Fails if the embedded migration copies drift from the SSOT
# (data/sqlite/migrations/). Mirrors tools/ci/verify-contracts.sh style.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/data/sqlite/migrations"
DST="$ROOT/apps/go-core/internal/repository/migrations"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

for f in "$SRC"/*.sql; do
  [ -e "$f" ] || continue
  cp "$f" "$TMPDIR/$(basename "$f")"
done

echo "Checking migration drift..."
if ! diff -rq "$TMPDIR" "$DST" >/dev/null 2>&1; then
  echo "Migration copies drift — run ./tools/scripts/gen-migrations.sh and commit" >&2
  diff -rq "$TMPDIR" "$DST" || true
  exit 1
fi

echo "Migrations OK"
