---
id: tooling-slice
category: slices
tags:
- slice
- generality
aliases:
- Tooling slice
related:
- slices-index
version: 1.0.4
status: active
---

# Tooling — Slice Generalities

## What this slice is

Build and generation scripts, plus CI automation. It is the reproducible entry point to compile and verify the monorepo.

## Boundaries

- **IN:** `tools/**`, `go.work` and the root build-relevant configs.
- **OUT:** apps and libs (tooling orchestrates them, it does not implement them).

## Entry points

- `tools/scripts/` — contract generation and build.
- `tools/ci/` — CI checks.
- `go.work` — Go workspace.
- `package.json` — root npm scripts.

## How it works

- The bash scripts use `set -euo pipefail` and resolve `ROOT` with `dirname`.
- `verify-contracts.sh` runs lint, breaking and drift for protobuf.
- `verify-migrations.sh` validates the SQLite migrations.
- `tools/ci/verify-docs.sh` (new) validates the corpus with `node tools/docs/validate.js`.
- `./tools/scripts/run-tests-local.sh` reproduces the CI suites locally, in the same order and from the same package directories as the workflow: build go-core + Angular renderer + Electron shell, `go vet` and `go test` from `apps/go-core`, Electron typecheck + vitest, then the Playwright Electron smoke. Every Go/TS command runs from its own package directory, never the root; without a `DISPLAY` the smoke is wrapped in `xvfb-run` exactly like CI. `E2E_REQUIRE_PREREQS` is deliberately left **unset** locally so a developer without a full build gets an honest skip — CI sets it to `'1'` so a broken build can never look green.
- Its `--windows-paths` mode cross-compiles and runs the Go suite for `GOOS=windows` under Wine as a **best-effort** extra: the authoritative Windows proof stays the `windows-latest` CI job (or `gh workflow run`), and Wine is not Windows (it reproduced some, not all, of the Windows-only failures).
- `tools/scripts/verify-go-core-fresh.js` — **staleness guard for the prebuilt core binary**. It compares `dist/go-core`'s mtime against the newest mtime of every input that feeds it — `apps/go-core` (`*.go`, `go.mod`, `go.sum`), `libs/contracts/gen` (the generated Go contract stubs, linked in through the `replace` in `apps/go-core/go.mod`, plus that module's own `go.mod`/`go.sum`), `libs/contracts/proto` (`*.proto`, indirect: a proto edit whose stubs were never regenerated is the same drift), the `.sql` migrations (compiled in with `//go:embed migrations/*.sql`, and their SSOT in `data/sqlite/migrations`), plus `go.work`/`go.work.sum` — and exits 1 with an actionable message (`./tools/scripts/build-go-core.sh`) when the binary is stale. It is plain Node with no bash/`uname`, so it behaves identically under cmd.exe; it resolves the target exactly like `build-go-core.sh` (explicit `GOOS` wins, otherwise the host; `.exe` on Windows) and absorbs a 1-second grace for coarse-granularity mounts. Reported paths are always forward-slash, so one message reads the same on both hosts. `Supervisor.spawn`'s prefer-existing-binary policy is deliberately untouched — the operator chose the guard, not the policy change. `--allow-missing` (exit 0 when the binary is absent) is used only by `run-tests-local.sh`, to keep that script's documented honest-skip behaviour.
- Wiring (the smallest place that fails *before* a stale binary is used): the root `prestart` hook — `npm start` rebuilds the renderer and the shell but never `dist/go-core`, which is what made the relocate-panel defect invisible — plus `run-tests-local.sh` right before the Playwright smoke. Covered by `apps/electron/test/go-core-freshness.test.ts` (hermetic fixture trees with pinned mtimes, exercised through the CLI).

## Conventions of this slice

- Commands are run from the package directory, never from the root (except Go via `go.work`).
- `--headless` mode must be reproducible.

## Dependencies

- **Upstream:** `buf`, `go`, `node` toolchains.
- **Downstream:** all slices.

## Known gaps & accepted debt

- **Correction (adjudicated):** the earlier claim that "there is no remote CI pipeline" was **false**. CI exists at `.github/workflows/ci.yml`: workflow `CI`, triggered on `push` to `main`, `pull_request` and `workflow_dispatch`, with `concurrency` group `ci-${{ github.workflow }}-${{ github.ref }}` (`cancel-in-progress: true`) and `permissions: contents: read`.
- The single job `build-and-test` runs a two-OS matrix (`[ubuntu-latest, windows-latest]`) with `fail-fast: false` — deliberately, so neither OS can hide the other's failure — and `timeout-minutes: 45`. Steps: checkout; Node 24 + npm cache; Go from `go.work` (1.26.0); `npm ci`; build go-core, Angular renderer and Electron shell; Electron and Angular vitest; `go vet ./...` then `go test ./... -count=1`; the Playwright Electron smoke with `E2E_REQUIRE_PREREQS: '1'`, wrapped in `xvfb-run` on Linux; and an `apps/electron/e2e-results/` upload on failure (7-day retention).
- This matches the frozen `docs/context/git-client/roadmap-mvp.md:104` (the 2-OS e2e smoke); the frozen roadmap is **not** edited (ratchet), and it agrees with the corrected claim.
- `.github/workflows/pages.yml` is a second, separate workflow: it deploys the static `website/` folder to GitHub Pages (no build step; its own `pages` concurrency group).
- `verify-docs.sh` is new.
- The staleness guard does not cover `npm run start:electron-only`: that script never reaches the root `prestart` hook (different script name), so it still runs whatever `dist/go-core` happens to be there — the local Playwright smoke and the explicit build step are its only safety net. A `prestart` in `apps/electron/package.json` would close the gap; it was deliberately left out to keep the tooling-slice wiring minimal, and accepting it here is the recorded tradeoff of choosing "smallest wiring".
- CI does not run the guard: `.github/workflows/ci.yml` builds `dist/go-core` earlier in the same job than the Electron smoke (nothing between the two touches the binary or its inputs), so a CI guard would be a tautology — the recurrence this guard closes was in the local dev loop, not in CI. A `verify-*` CI step can be added in one line if CI ordering ever changes.
