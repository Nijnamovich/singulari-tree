# Technical Risks

## Matrix (Probability × Impact)

| # | Risk | Prob | Impact | Severity | Mitigation | Owner |
|---|--------|------|---------|-----------|------------|-------|
| R1 | **Graph 50k+ slow / DOM thrash** | High | High | 🔴 | Virtual scroll CDK/canvas + lanes in Go + LRU window 200+100; bench 50k <100ms | Go GraphService + Angular graph |
| R2 | **Monaco diff freezes UI on large files** | High | High | 🔴 | Worker + chunking + 1MB limit → plain text fallback; hunks virtualization | ui-kit diff-viewer |
| R3 | **Fragile Go headless lifecycle (zap, socket perms)** | Medium | High | 🟡 | Unix socket fallback TCP, `GO_CORE_READY` timeout 15s, backoff, token rotation, testcontainers kill test | supervisor + main.go |
| R4 | **SQLite WAL concurrency (multiple windows)** | Medium | Medium | 🟡 | A single Go core (no multi-process DB writers); `busy_timeout=5000`, WAL, `synchronous=NORMAL`; stress test | repository |
| R5 | **File watchers burst + index.lock** | High | Medium | 🟡 | fsnotify debounce 150-300ms coalescing + `index.lock` filter; watcher does not block UI thread | watcher adapter |
| R6 | **Contract drift (gen/go vs gen/ts)** | Medium | High | 🟡 | `buf lint` + `buf breaking` + `verify-contracts.sh` in CI; gen is an artifact, no manual edit | libs/contracts |
| R7 | **go-git vs exec git incomplete parity** | Medium | High | 🟡 | `GitPort` abstraction; MVP uses exec `git` (100% parity), migrates to go-git incrementally with feature flags | adapter/git |
| R8 | **Local token auth spoof** | Low | Medium | 🟢 | Bind only 127.0.0.1/unix socket, 32B hex token, no 0.0.0.0, CSP, contextIsolation | ipc-strategy |
| R9 | **Cross-platform path / line endings** | Medium | Medium | 🟡 | `filepath.Abs` + `filepath.Join`, `core.autocrlf` awareness, tests on 3 OSes | domain + Go |
| R10| **Electron packaging / signing / auto-update** | Low (MVP) / High (V1) | Medium | 🟡 | `electron-builder` + notary; V1 only; MVP without signing | tools |
| R11| **Submodules / LFS / worktrees edge cases** | Medium | Medium | 🟡 | Detect and mark unsupported with a clear message; do not block repo open | GitService |
| R12| **Memory leak streaming (Watch/Fetch never close)** | Medium | High | 🟡 | Context cancel on gRPC stream, `signal.NotifyContext` cleanup, per-RPC deadline | grpc server |
| R13| **MCP adapter = second SQLite writer (`cache.db`)** | Low | High | 🟡 | MCP is the single core process with its own DB, or runs `--proxy-grpc` against an active go-core; two full writers to `cache.db` forbidden (ref R4) | adapter/mcp |
| R14| **MCP tool schema drift vs proto** | Medium | Medium | 🟡 | JSON Schema generated from proto (`protoreflect`/buf), never hand-duplicated; CI check (ref R6) | adapter/mcp |
| R15| **MCP streaming/cancellation (`Fetch/Push/Pull`, `Watch`)** | Medium | Medium | 🟡 | `notifications/cancelled` → context-cancel of the gRPC stream; `Watch` as cursor/poll `git_events(since_cursor)` (ref R12) | adapter/mcp |

## Detail per risk

### R1 — Graph virtualization
- **Symptom:** render 10k commits → 10k DOM nodes → jank.
- **Mitigation:** `cdk-virtual-scroll-viewport itemSize=28` + precomputed SVG/canvas lanes; lanes computed in Go O(n) incremental; `getCommits` paginated; LRU size 300.
- **Verification:** playwright scroll perf trace + `BenchmarkLanes(50000)` <100ms.

### R2 — Monaco large files
- **Symptom:** 5MB diff → Monaco OOM or 3s freeze.
- **Mitigation:** `if (size>1MB || lines>5000) fallbackPlainText`; otherwise `monaco.editor.create(diffEditor)` with web workers (`monaco-workers`); hunks chunked lazy; diff per file, not repo-wide.
- **Verification:** fixture large file 2MB diff, frame budget test.

### R3 — Headless lifecycle
- **Symptom:** Go does not emit `GO_CORE_READY`, socket permission denied, port in use.
- **Mitigation:** TCP fallback `127.0.0.1:0` if unix socket fails; 15s timeout + retry backoff; health `Ping` 5s; `tools/scripts/build-go-core.sh` tests `--headless` in CI; logs to stderr.
- **Verification:** `timeout 3 go run --headless | grep GO_CORE_READY` in CI.

### R4 — SQLite WAL
- **Symptom:** `database is locked` with multiple writers.
- **Mitigation:** only Go writes (single writer); WAL + `PRAGMA busy_timeout=5000`; `database/sql` pool `maxOpenConns=1`; migrations `IF NOT EXISTS`.
- **Verification:** stress test 10 goroutines concurrent `SetCommits`.

### R5 — Watchers burst
- **Symptom:** `git checkout` generates 500 events → invalidates cache 500 times → thrash.
- **Mitigation:** 200ms debounce + coalescing array `paths[]` per window; `index.lock` filter; `Watch` single push per burst.
- **Verification:** `touch 1000 files` script → a single `FsChangedEvent`.

### R7 — go-git parity
- **Symptom:** `go-git` does not support `rebase --interactive`, `lfs`, `signing`.
- **Mitigation:** MVP uses `exec git` for full parity; abstracts behind `GitPort`; go-git only for fast reads if it improves performance (optional feature flag).
- **Verification:** feature parity table in `adapter/git/README.md`.

### R13 — MCP + SQLite single-writer
- **Symptom:** `--mcp-stdio` starts a second full core → two writers to `cache.db` → `database is locked` / corruption.
- **Mitigation:** explicit ownership rule: MCP is the **single** core process with its DB, **or** runs `--proxy-grpc` against an already-active go-core; never two full writers (ref R4). Read-only by default.
- **Verification:** test that rejects a second writer; `--proxy-grpc` smoke with a go-core running.

### R14 — MCP schema drift
- **Symptom:** MCP tools declare schemas out of sync with `gitcore.proto` after a contract change.
- **Mitigation:** input JSON Schema **generated** from proto (`protoreflect`/buf), never hand-duplicated; protojson outputs; verification in CI alongside `verify-contracts.sh` (ref R6).
- **Verification:** `buf generate` + schema comparison → CI fails if they diverge.

### R15 — MCP streaming/cancel
- **Symptom:** `Fetch/Push/Pull` without progress or cancellation; `Watch` does not fit MCP streaming.
- **Mitigation:** `Progress` → `notifications/progress`; `notifications/cancelled` → context-cancel of the gRPC stream; `Watch` as cursor/poll `git_events(since_cursor)` (ref R12).
- **Verification:** cancellation test for `git_fetch`; incremental cursor test `git_events`.

## Prioritized mitigation plan (MVP)

1. R1, R2, R5 (wk 1-5) — perf + watchers.
2. R3, R6 (wk 0) — headless + buf.
3. R4, R7 (wk 0-1) — SQLite + GitPort.
4. R12 (wk 6) — streaming cleanup.
5. R10 (V1) — packaging.
6. R13, R14, R15 (post-MVP, optional MCP workstream) — DB ownership + schema + cancel.

## Fallbacks

- If virtual scroll insufficient → migrate lanes to `<canvas>` (a11y tradeoff).
- If fsnotify unstable on macOS → poll fallback 1s (`--watcher-mode=poll`).
- If gRPC unstable → degrade to HTTP JSON (already set up on `127.0.0.1:0`).

## Tracking metrics

- `BenchmarkLanes` p50/p99.
- `vitest` coverage ≥80%.
- `playwright trace` graph frame rate.
- `go vet` + `buf breaking` must pass.
