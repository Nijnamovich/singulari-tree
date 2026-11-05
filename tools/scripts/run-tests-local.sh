#!/usr/bin/env bash
# run-tests-local.sh — reproduce the CI suites locally, on Linux or Windows.
#
# CI (.github/workflows/ci.yml) runs one job on ubuntu-latest and one on
# windows-latest, fail-fast: false. This script reproduces the *ubuntu* job end
# to end and, where the host allows it, additionally exercises the Windows-only
# Go paths by cross-compiling the test binaries (GOOS=windows) and running them
# under Wine when available. It is a convenience wrapper: it invokes the exact
# canonical commands from docs/project.md §Commands and never a substitute.
#
# Usage:
#   ./tools/scripts/run-tests-local.sh                # everything below
#   ./tools/scripts/run-tests-local.sh --help
#
# Options:
#   --build-only      build go-core + Angular renderer + Electron shell, stop
#   --go-only         go vet + go test ./... -count=1   (apps/go-core)
#   --ts-only         electron typecheck + vitest       (apps/electron)
#   --e2e-only        playwright smoke                  (apps/electron)
#   --skip-build      reuse the existing dist/ artifacts
#   --skip-e2e        do not launch the Electron smoke
#   --windows-paths   cross-compile + run the Go suite for GOOS=windows
#                     (needs wine on PATH; skipped loudly when absent)
#
# Notes
#   * Every Go/TS command runs from its own package directory — never from the
#     repo root (docs/project.md §Key Conventions).
#   * Electron is not headless: on a machine without a DISPLAY the smoke is
#     wrapped in `xvfb-run`, exactly like CI. `E2E_REQUIRE_PREREQS` is left UNSET
#     locally so a developer without a full build gets an honest skip instead of
#     a hard failure; CI sets it to '1' so a broken build can never look green.
#   * `--windows-paths` is a best-effort extra: the *real* proof for Windows stays
#     the windows-latest CI job (or `gh workflow run`). It is never a prerequisite
#     for the fixes it helps validate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GO_PKG="apps/go-core"
ELECTRON_PKG="apps/electron"

MODE="all"
SKIP_BUILD=0
SKIP_E2E=0
WINDOWS_PATHS=0

usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --build-only) MODE="build" ;;
    --go-only) MODE="go" ;;
    --ts-only) MODE="ts" ;;
    --e2e-only) MODE="e2e" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-e2e) SKIP_E2E=1 ;;
    --windows-paths) WINDOWS_PATHS=1 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# `--windows-paths` on its own means "just the Windows paths": running the whole
# local suite to reach the Windows step would be wasteful.
if [ "$WINDOWS_PATHS" = "1" ] && [ "$MODE" = "all" ]; then MODE="windows"; fi

step() { printf '\n=== %s ===\n' "$1"; }

build_all() {
  step "build go-core"
  ./tools/scripts/build-go-core.sh

  step "build Angular renderer"
  ( cd apps/angular && npm run build )

  step "build Electron shell"
  ( cd "$ELECTRON_PKG" && npm run build )
}

run_go() {
  step "go vet ($GO_PKG)"
  ( cd "$GO_PKG" && go vet ./... )

  step "go test ($GO_PKG, -count=1)"
  ( cd "$GO_PKG" && go test ./... -count=1 )
}

run_ts() {
  step "electron typecheck"
  ( cd "$ELECTRON_PKG" && npm run typecheck )

  step "electron unit tests (vitest)"
  ( cd "$ELECTRON_PKG" && npm test )
}

# Reproduces the CI step with its Linux wrapper: xvfb-run when there is no
# display (or when xvfb-run exists), a plain run otherwise. E2E_REQUIRE_PREREQS
# is intentionally NOT set locally (see header).
run_e2e() {
  # The smoke spawns the PREBUILT dist/go-core (main.ts -> Supervisor.spawn,
  # which prefers it and only falls back to `go run` when it is ABSENT). A
  # stale artifact serves an outdated RPC set while every unit suite stays
  # green — the relocate-panel defect — so assert its freshness before the
  # smoke instead of letting a stale binary look like a core bug.
  # --allow-missing keeps this honest-skip script's contract: a developer
  # without a build still gets the e2e suite's own prereq skip, not a hard
  # failure, because the shell then runs current source via `go run`.
  step "go-core freshness guard"
  node tools/scripts/verify-go-core-fresh.js --allow-missing

  step "playwright electron smoke ($ELECTRON_PKG)"
  (
    cd "$ELECTRON_PKG"
    if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
      xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" npx playwright test
    else
      npx playwright test
    fi
  )
}

# Windows-only paths: cross-compile the whole test binary set and, when Wine is
# available, actually execute them. Without wine this only proves the Windows
# build, never the Windows behaviour — the windows-latest CI job owns that.
run_windows_paths() {
  step "go test for GOOS=windows (cross-compiled)"
  if ! command -v go >/dev/null 2>&1; then
    echo "go not on PATH — skipping" >&2; return 0
  fi
  if ! ( cd "$GO_PKG" && GOOS=windows GOARCH=amd64 go vet ./... ); then
    echo "GOOS=windows vet failed" >&2; return 1
  fi
  if ! command -v wine >/dev/null 2>&1; then
    echo "wine not on PATH — build-only proof; run the windows-latest CI job for behaviour."
    return 0
  fi

  # The Go git adapter shells out to `git`, so a Windows test run needs a
  # *Windows* git on the Wine PATH (a Linux git is not reachable from a Windows
  # process). Discover one inside the Wine prefix; without it the git-dependent
  # packages fail with `exec: "git": executable file not found`, which is a
  # harness gap, not a test failure.
  local gitdir=""
  local candidate
  for candidate in \
    "${WINEPREFIX:-$HOME/.wine}"/drive_c/users/*/AppData/Local/Atlassian/SourceTree/git_local/cmd \
    "${WINEPREFIX:-$HOME/.wine}"/drive_c/"Program Files"/Git/cmd \
    "${WINEPREFIX:-$HOME/.wine}"/drive_c/"Program Files (x86)"/Git/cmd; do
    [ -x "$candidate/git.exe" ] && { gitdir="$candidate"; break; }
  done
  if [ -n "$gitdir" ]; then
    export WINEPATH="Z:${gitdir}${WINEPATH:+;$WINEPATH}"
    echo "windows git on the Wine PATH: $gitdir"
  else
    echo "WARNING: no Windows git.exe found in the Wine prefix — the git-dependent" >&2
    echo "packages will fail with 'executable file not found'. Install Git for" >&2
    echo "Windows under Wine, or use the windows-latest CI job for full coverage." >&2
  fi

  # `wine go test` does not work (go.exe is not on the Windows PATH inside the
  # prefix): build each package's test binary and run it directly under wine.
  echo "wine found — building and running the Windows test binaries"
  local tmp; tmp="$(mktemp -d)"
  # RETURN traps are not stack-scoped: clear it explicitly so a later function
  # return cannot re-fire the removal of an already-deleted directory.
  trap 'rm -rf "$tmp"' RETURN
  local pkg failed=0
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    local bin log
    bin="$tmp/$(echo "$pkg" | tr '/' '_').test.exe"
    log="$tmp/$(echo "$pkg" | tr '/' '_').test.log"
    if ! ( cd "$GO_PKG" && GOOS=windows GOARCH=amd64 go test -c -o "$bin" "$pkg" ); then
      echo "GOOS=windows test build failed for $pkg" >&2; failed=1; continue
    fi
    echo "--- $pkg ---"
    if ! WINEDEBUG=-all wine "$bin" -test.count=1 >"$log" 2>&1; then
      echo "$pkg FAILED under wine -- output:" >&2
      grep -v -E 'MESA-EGL|pci id|ShellExecuteEx|Application could not' "$log" >&2 || true
      failed=1
    fi
  done < <(cd "$GO_PKG" && go list -f '{{if .TestGoFiles}}{{.ImportPath}}{{end}}' ./...)
  trap - RETURN
  rm -rf "$tmp"
  [ "$failed" = "0" ] || { echo "Windows runs under wine reported failures" >&2; return 1; }
  echo "Windows runs under wine: OK"
}

case "$MODE" in
  windows)
    run_windows_paths
    ;;
  build)
    [ "$SKIP_BUILD" = "1" ] || build_all
    ;;
  go)
    [ "$SKIP_BUILD" = "1" ] || ./tools/scripts/build-go-core.sh
    run_go
    ;;
  ts)
    run_ts
    ;;
  e2e)
    [ "$SKIP_BUILD" = "1" ] || build_all
    run_e2e
    ;;
  all)
    [ "$SKIP_BUILD" = "1" ] || build_all
    run_go
    run_ts
    if [ "$SKIP_E2E" = "1" ]; then
      step "playwright electron smoke"; echo "skipped (--skip-e2e)"
    else
      run_e2e
    fi
    if [ "$WINDOWS_PATHS" = "1" ]; then
      run_windows_paths
    else
      step "windows-only go paths"
      echo "skipped (pass --windows-paths to cross-compile the Go suite for GOOS=windows)"
    fi
    ;;
esac

step "done"
