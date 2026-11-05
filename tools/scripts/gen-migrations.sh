#!/usr/bin/env bash
# Copies the SQLite migration SSOT (data/sqlite/migrations/) into the go-core
# module so it can be embedded with //go:embed (which cannot reach outside the
# module root). Run from anywhere; it resolves the repo root itself.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/data/sqlite/migrations"
DST="$ROOT/apps/go-core/internal/repository/migrations"

mkdir -p "$DST"

# Remove previously generated copies so deletions in the SSOT are reflected.
find "$DST" -maxdepth 1 -type f -name '*.sql' -delete

copied=0
for f in "$SRC"/*.sql; do
  [ -e "$f" ] || continue
  cp "$f" "$DST/$(basename "$f")"
  copied=$((copied + 1))
done

echo "Copied $copied migration(s) from $SRC to $DST"
