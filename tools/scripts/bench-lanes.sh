#!/usr/bin/env bash
#
# bench-lanes.sh — run the GraphService.Lanes large-history performance gate.
#
# Runs the existing synthetic-50k guard TestLanes50kUnder100ms (asserts the
# lane computation finishes in <100ms) plus BenchmarkLanes for throughput and
# allocation numbers, from the go-core module. Prints a human-readable PASS.
#
# The synthetic repo from gen-large-repo.sh is NOT required here: the lane
# algorithm is exercised on an in-memory synthCommits(50000) DAG. Use
# gen-large-repo.sh for the end-to-end/manual-QA large repo (git.git-scale),
# e.g.:
#   tools/scripts/gen-large-repo.sh --commits 50000
#
# Usage: tools/scripts/bench-lanes.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/apps/go-core"

if ! command -v go >/dev/null 2>&1; then
  echo "error: go not found on PATH" >&2
  exit 1
fi

echo "Running lane perf gate (TestLanes50kUnder100ms + BenchmarkLanes)..."
echo "Module: apps/go-core/internal/service/"
echo

go test -v -count=1 -run '^TestLanes50kUnder100ms$' -bench '^BenchmarkLanes$' -benchmem ./internal/service/

echo
echo "PASS: Lanes completed a 50k-commit history under the 100ms gate."
