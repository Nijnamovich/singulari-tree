#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/libs/contracts"

if ! command -v buf >/dev/null 2>&1; then
  echo "buf not found — skipping breaking check (install buf to enforce)" >&2
  exit 0
fi

echo "Running buf lint..."
buf lint

if git -C "$ROOT" rev-parse --verify main >/dev/null 2>&1; then
  echo "Running buf breaking against main..."
  # The proto module lives in libs/contracts (buf.yaml `modules[].path: proto`),
  # so the git reference must point at that subdirectory. Without `subdir=` buf
  # would compile the ref *root* as a module and emit spurious "imported file
  # does not exist" errors instead of comparing the module.
  buf breaking --against "$ROOT/.git#branch=main,subdir=libs/contracts"
else
  echo "No main branch — skipping breaking check"
fi

echo "Checking generated drift..."
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
buf generate --template buf.gen.yaml -o "$TMPDIR"
if ! diff -rq --exclude=go.mod --exclude=go.sum gen "$TMPDIR/gen" >/dev/null 2>&1; then
  echo "Generated contracts drift — run ./tools/scripts/gen-contracts.sh and commit" >&2
  diff -rq --exclude=go.mod --exclude=go.sum gen "$TMPDIR/gen" || true
  exit 1
fi

echo "Contracts OK"
