#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/apps/go-core"

LDFLAGS="-s -w"

# Target OS: GOOS wins when set; otherwise detect the host (Git Bash on Windows
# reports an MSYS/MINGW/CYGWIN uname).
TARGET_OS="${GOOS:-}"
if [[ -z "$TARGET_OS" ]]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) TARGET_OS="windows" ;;
    *) TARGET_OS="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
  esac
fi

if [[ "$TARGET_OS" == "windows" ]]; then
  OUTPUT="$ROOT/dist/go-core.exe"
else
  OUTPUT="$ROOT/dist/go-core"
fi

echo "Building go-core (GOOS=$TARGET_OS)..."
go build -ldflags "$LDFLAGS" -o "$OUTPUT" ./cmd/go-core
echo "Built $OUTPUT"
