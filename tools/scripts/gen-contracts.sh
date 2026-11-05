#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/libs/contracts"

if ! command -v buf >/dev/null 2>&1; then
  echo "buf not found — install from https://buf.build/docs/installation" >&2
  exit 1
fi

echo "Generating contracts from libs/contracts/proto -> libs/contracts/gen/{go,ts}"
buf generate --template buf.gen.yaml

echo "Done. Verify no drift: ./tools/ci/verify-contracts.sh"
