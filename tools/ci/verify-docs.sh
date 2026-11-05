#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found — skipping docs validation" >&2
  exit 0
fi

echo "Validating documentation corpus..."
node tools/docs/validate.js
