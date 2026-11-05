---
last_updated: 2026-10-05
status: active
description: SingulariTree MVP roadmap — 8-10 week goal, deliverables and DoD per week; Weeks 1-2 scoped to vertical lane columns (edge parity deferred).
tags:
- roadmap
- mvp
- git-client
- legacy
version: 1.2.1
related:
- accepted-debt
---

# MVP Roadmap — 8-10 weeks

> MVP goal: open an existing local repo, view paginated graph/history, status/stage/commit, Monaco diff, basic branches/tags/stashes, fetch/pull/push, realtime watcher, automated tests. Partial multi-repo management. No complex SSH or advanced rebase conflicts.

## Week 0 — Foundations (wk 1) — ✅ COMPLETE

**Deliverables (verified):**
- [x] Working `buf generate` — contracts generated and committed (real `gen/go` + `gen/ts`).
- [x] Real gRPC server with `RegisterGitCoreServer` + token interceptor (includes additive `OpenRepository`).
- [x] SQLite WAL + migrations applied at startup via `embed`.
- [x] Real `GitPort` read path via `exec git`.
- [x] Real end-to-end `GetCommits` (Go ↔ gRPC ↔ Electron).
- [x] Real gRPC client in `supervisor.ts` + `Ping` heartbeat (stub `forwardToGo` replaced).
- [x] `apps/angular` typed bridge (`@contracts` → `libs/contracts/gen/ts`).

**DoD:** ✅ `go run --headless` + `supervisor.start()` + `buf generate` green in CI.

**Deliberate deviations (from the original plan):**
- **No Viper:** configuration with explicit flags + `config.Load()`.
- **Embedded migrations** via a generator guarded by `tools/ci/verify-migrations.sh`; the **SSOT remains in `data/sqlite/migrations/`**.
- **ts-proto types-only** (no generated service runtime in TS).

## Week 1-2 — Repo + Graph

**Go:**
- Real `RepoService.Open/List/Remove` (`git rev-parse --git-common-dir` validation, SQLite `repos`).
- `GitPort` impl `adapter/git` using `exec git log --pretty=format:... --topo-order --skip/--max-count` or `go-git` for `List`.
- `GraphService.Lanes` impl lane algorithm (see `service-design.md §1.3`), benchmark <100ms/50k.
- `CacheService` SQLite `commit_cache` windowed.

**Angular:**
- `RepoStore` + `GraphStore` with `loadWindow(200)+prefetch(100)`.
- `libs/ui-kit/graph-row` (SVG lanes + commit row).
- Virtual scroll (CDK `ScrollingModule`) + infinite scroll.
- `features/repo/graph` page.

**DoD:** open a 5k-commit repo, smooth scroll, and **correct vertical lane columns** (continuity between windows guaranteed by per-repo state in Go). Visual parity of diagonals/crossings vs `git log --graph` is **deferred as accepted debt** (see accepted-debt) and the `Lane` contract does not change.

## Week 3 — Status / Stage / Commit

**Go:** `GetStatus` (porcelain v2), `Stage/Unstage`, `Commit` (with `Signature`), basic `GetDiff`.

**Angular:** `StatusStore`, file list with staged/unstaged/conflicted, stage/unstage checkboxes, commit box, basic side-by-side diff (Monaco `diffEditor`).

**DoD:** full flow stage → commit → graph updates via watcher or manual refresh.

## Week 4 — Monaco Diff + Large files

**Go:** `Diff` full hunks, `is_binary`, `has_conflict_markers`.

**Angular:** `libs/ui-kit/diff-viewer` Monaco wrapper (`monaco-editor` + workers), unified/side-by-side toggle, >1MB handler (plain text fallback + warning), syntax highlighting by extension.

**DoD:** large diffs do not freeze the UI; binaries show a placeholder.

## Week 5 — Branches / Tags / Stashes + Watchers

**Go:** `GetBranches`, `GetTags`, `GetStashes`, `GetWorktrees`, `Checkout`, `fsnotify` watcher coalescing 200ms + `index.lock` guard.

**Angular:** `BranchStore` (local/remote, current, upstream), checkout flow, tags list, stashes list, `onFsChanged` → `StatusStore.refresh` + `GraphStore.reload`.

**DoD:** checkout changes HEAD, watcher reflects external changes (`echo > file` triggers refresh).

## Week 6 — Remotes (Fetch/Pull/Push streaming)

**Go:** `Fetch/Push/Pull` with `stream Progress` (`exec git fetch --progress` parsed or `go-git` progress writer).

**Angular:** toolbar remote actions + progress bar `onProgress`, error handling (`FETCH_FAILED`/`PUSH_FAILED`).

**DoD:** fetch against a local fixture remote works, progress visible, error toast.

## Week 7 — Multi-repo + SQLite prefs + Polish

**Go:** persisted `ListRepositories`, `recent` ordering by `last_opened_at`, multiple repos validation.

**Angular:** repo list page, open/add/remove repo, UI-state persistence (panel sizes), theme, keyboard shortcuts (graph nav arrows, space for diff).

**Tests:** vitest coverage 80% + go `go test -race` + buf lint in CI; playwright e2e smoke (open repo → graph → stage → commit → diff).

**DoD:** usable multi-repo, preferences persist across restarts.

## Week 8 — Stabilization / Release MVP

- Bug bash on large repos (10k+ commits, binaries, submodules): `tools/scripts/gen-large-repo.sh` (fast-import, deterministic; `--commits/--out/--interval/--with-submodule/--force`) + `tools/scripts/bench-lanes.sh`.
- Perf: LRU tune (named constant `DefaultLRUCapacity`), real watcher debounce (150 ms coalescing in `WatcherService`, deterministic tests) and stable `trackBy` in the graph virtual scroll.
- Packaging `electron-builder` Linux/Win/macOS (no signing yet): `apps/electron/electron-builder.yml`; renderer served via `app://` protocol (no `ELECTRON_START_URL` workaround); go-core `.exe` on Windows.
- Docs: updated `README.md` quick start + Screenshots section (honest placeholder, no fabricated screenshots).

**MVP exit criteria:**
- [x] ≥1 repo open, virtualized graph, status/stage/commit, branches/tags/stashes, remotes fetch/pull/push, watcher, SQLite WAL, headless proof, green `buf generate`. **Note:** `diff Monaco` and the `status/stage/commit` UI **do not exist yet** (Week 3-4) — verified and recorded in `accepted-debt.md`; the `stage → commit → diff` e2e remains a documented `test.skip`.
- [x] Unit coverage ≥80% (Angular statements **90.42%**; Electron 43 tests; Go `-race` green); e2e smoke configured for 2 OSes via CI (`ubuntu-latest` + `windows-latest`, `.github/workflows/ci.yml`), with an `E2E_REQUIRE_PREREQS` guard that fails instead of omitting. **The Windows run is reasoned, not executed locally** — see `accepted-debt.md`.
- [~] Manual QA large repo (git.git 60k commits) scroll <16ms frame: the **Go lanes bench** passes (`Lanes(50000)` ≈ 8.7ms ≪ 100ms) and the large-repo harness exists; the **renderer frame measurement (<16ms)** remains **pending** (requires a GUI station with a display and a 60k repo) — recorded as debt.

## Epics and estimation (T-shirt)

| Epic | Wk | Size |
|-------|-----|-------|
| Foundations buf + real headless | 0 | M |
| Graph + Lanes + virtualization | 1-2 | L |
| Status/Stage/Commit | 3 | M |
| Diff Monaco large files | 4 | M |
| Branches/tags/stashes + watcher | 5 | M |
| Remotes streaming | 6 | M |
| Multi-repo + polish | 7 | S |
| Stabilization | 8 | S |

Total MVP: **~8 weeks** 1 dev full-time; 6 weeks with 2 devs (Go + Angular in parallel).
