# Design decisions — ADRs

> ADR format: Context → Decision → Consequences → Alternatives. All justify why it was chosen and what was sacrificed.

## ADR-001 — Hexagonal (Ports & Adapters) with headless Go

- **Context:** The frontend must never run Git directly; Electron must be replaceable; Go must run without a UI.
- **Decision:** pure `domain` with no external imports; `service` orchestrates ports; `adapter` implements; `cmd/go-core/main.go` is the composition root. Angular/Electron only know `window.gitClientApi`.
- **Consequences:** + testability (port mocks), + substitutability (Tauri/React), + headless proof `--headless`; − interface boilerplate, − hexagonal learning curve for new contributors.
- **Alternatives:** monolithic Electron MVC (rejected: couples Git to the UI, not headless).
- **Status:** Accepted.

## ADR-002 — npm workspaces monorepo + go.work

- **Context:** Need for atomic Angular↔Go contracts and a single toolchain.
- **Decision:** `package.json` workspaces (`angular`, `electron`, `contracts`, `ui-kit`) + `go.work` (`use ./apps/go-core`).
- **Consequences:** + `buf generate` atomizes `gen/go+gen/ts`; + single CI; − `go.work` requires Go 1.18+ (ok 1.25+).
- **Alternatives:** Polyrepo (rejected: contract drift).
- **Status:** Accepted.

## ADR-003 — Single proto contracts with buf (singularitree.v1 alias gitclient.v1)

- **Context:** Typing between Go and TS, controlled breaking changes.
- **Decision:** `libs/contracts/proto/*.proto` single source; `buf.yaml` v2 (`STANDARD`, `breaking: FILE`) + `buf.gen.yaml` (`go`, `grpc/go`, `ts-proto`) → `gen/go` + `gen/ts`; `buf lint` + `buf breaking` in `tools/ci/verify-contracts.sh`; package `singularitree.v1`, alias `gitclient.v1` in comments.
- **Consequences:** + breaking check; + `gen` not editable; − `buf` CLI dependency.
- **Alternatives:** OpenAPI/JSON Schema (rejected: weak streaming).
- **Status:** Accepted.

## ADR-004 — gRPC IPC primary (unix socket/named pipe) + HTTP fallback

- **Context:** Streaming (`Watch`, `Fetch` progress, `StreamCommits`) and typing; debug compatibility.
- **Decision:** gRPC on unix socket (Linux/macOS) / named pipe `\\.\pipe\singularitree-go-core` (Windows) primary; HTTP fallback always on `127.0.0.1:0` with JSON; token `authorization: Bearer`. Scaffold maps unix→TCP for buildability.
- **Consequences:** + native streaming + interceptors; + `curl` fallback; − gRPC complexity vs REST; − unix socket perms on Windows.
- **Alternatives:** HTTP REST/SSE only (rejected: fragile streaming, manual typing).
- **Status:** Accepted.

## ADR-005 — Single preload + contextIsolation + CSP

- **Context:** Electron security, one IPC surface.
- **Decision:** single `preload.ts` `contextBridge.exposeInMainWorld('gitClientApi', api)`; `BrowserWindow` `contextIsolation:true, nodeIntegration:false, sandbox:true`; CSP in `window/csp.ts`; `channels.ts:validate` validation before forward.
- **Consequences:** + minimizes attack surface; + typing; − do not expose `ipcRenderer` directly.
- **Alternatives:** `nodeIntegration:true` (rejected: insecure).
- **Status:** Accepted.

## ADR-006 — Per-user SQLite WAL for metadata cache (never Git objects)

- **Context:** Persist recents/favorites/prefs/UI-state + commit window cache without a server; Git data stays in `.git`.
- **Decision:** SQLite WAL (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`) in `~/.local/share/singularitree/cache.db` (Linux), `Application Support` (macOS), `%APPDATA%` (Win); `data/sqlite/migrations/001_initial.sql` migrates `repos`, `commit_cache`, `file_status`, `stash_cache`; `modernc.org/sqlite` (pure Go) or `mattn/go-sqlite3`; single writer (Go).
- **Consequences:** + no server, + WAL concurrency for reads; + versioned migrations; − no multi-writer; − per-OS path.
- **Alternatives:** LevelDB/IndexedDB (rejected: SQL queries useful for commits), Postgres (rejected: server).
- **Status:** Accepted.

## ADR-007 — Headless Go core with GO_CORE_READY + 5s Ping supervisor + token rotation

- **Context:** Go must live without Electron and be supervised.
- **Decision:** `cmd/go-core/main.go` flag `--headless` → binds gRPC+HTTP, prints `GO_CORE_READY addr=... http=... token=...` (parseable), `signal.NotifyContext` graceful 5s; `supervisor.ts` awaitReady 15s, heartbeat Ping 5s, backoff `[200,500,1000,2000,5000]`, queue 100, token 32B hex rotated per restart.
- **Consequences:** + testable headless proof (`go run --headless | grep GO_CORE_READY`); + auto-recover; − fragile stdout parsing (mitigated with strict regex).
- **Alternatives:** stdio JSON-RPC (rejected: less standard than gRPC).
- **Status:** Accepted (scaffold already implements a TCP stub; production will move to a real unix socket).

## ADR-008 — Lanes graph in Go + Angular virtualization (CDK/canvas) + LRU windowed 200+100

- **Context:** 50k commits with merges, fluid render, <100ms.
- **Decision:** `GraphService.Lanes` computes lanes O(n) in Go (equivalent to `git log --graph`); Angular virtualizes with `cdk-virtual-scroll-viewport itemSize=28` + `graph-row` SVG/canvas; pagination `200` initial + `100` prefetch + `IntersectionObserver`; LRU memory 300.
- **Consequences:** + lanes <50ms in Go; + DOM only ~30 nodes; − `cdk-virtual-scroll` not canvas (canvas fallback if not enough).
- **Alternatives:** Lanes in TS (rejected: blocks main), non-virtualized pagination (rejected: DOM thrash).
- **Status:** Accepted.

## ADR-009 — Monaco diff with workers + chunking + 1MB fallback

- **Context:** Modern diff UX, binaries, large files.
- **Decision:** `libs/ui-kit/diff-viewer` wrapper `monaco-editor` + `monaco-workers` (web workers); `side-by-side`/`unified` toggle; 1MB/`5000` line limit → plain text fallback; syntax by extension; lazy hunks.
- **Consequences:** + modern UX; + no freeze; − heavy Monaco bundle (lazy load).
- **Alternatives:** CodeMirror (rejected: Monaco superior for diff), plain `<pre>` (rejected: poor).
- **Status:** Accepted.

## ADR-010 — fsnotify file watchers with 150-300ms coalescing + index.lock guard

- **Context:** Realtime changes to `.git/HEAD`, `refs/*`, `index` without thrash; `index.lock` burst.
- **Decision:** `adapter/watcher` `fsnotify` watch `.git/HEAD`, `refs/**`, `index`, `logs/HEAD`; debounce 200ms (150-300 configurable) coalescing bursts → one `FsChangedEvent{paths[]}`; `index.lock` ignore filter; invalidates `CacheService`; push via `Watch` streaming → `fs:changed`.
- **Consequences:** + realtime without polling; + coalesced bursts; − `fsnotify` unstable on macOS FSEvents (fallback poll).
- **Alternatives:** 1s polling (rejected: latency, CPU).
- **Status:** Accepted.

## ADR-011 — Testing: vitest (Angular) + go test/ testify + playwright e2e + buf CI

- **Context:** Confidence, maintainability, modern UX.
- **Decision:** Angular `vitest` (`@testing-library/angular`, `jsdom`, mock `window.gitClientApi`); Go `go test -race` + `testify` + `bufconn` gRPC + real temp repo; SQLite `:memory:`; optional `testcontainers`; Playwright Electron `launch`; `tools/ci/verify-contracts.sh` `buf lint/breaking`; coverage 80%; CI matrix 3 OS.
- **Consequences:** + balanced pyramid; + `buf breaking` prevents drift; − Playwright Electron setup.
- **Alternatives:** Karma/Jest (rejected: vitest faster with Vite), Cypress (rejected: Playwright better for Electron).
- **Status:** Accepted.

## ADR-012 — Style: Angular latest stable Signals zoneless + SCSS + strict TypeScript

- **Context:** Modern UX, performance, maintainability.
- **Decision:** Angular `^21` `standalone` `zoneless` `signals` + `signalStore` per feature; SCSS; `strict: true`; `libs/ui-kit` dumb components.
- **Consequences:** + reactivity without Zone; + fine-grained signals; − zoneless requires `provideZonelessChangeDetection` awareness.
- **Status:** Accepted.

## ADR-013 — MCP surface as an optional inbound adapter over the Go core

**Status:** Proposed (advisory — does not gate Phase 0 spine).
**Refs:** `architecture.md §2/§5/§6`, `module-diagram.md §2/§5`, `ipc-strategy.md §2.1/§2.4/§2.6`, `service-design.md §1`, `domain-model.md §5`, `risks.md R3/R4/R8/R12`, `libs/contracts/proto/gitcore.proto`, `README.md`.
**Gap noted:** `MCP` / `Model Context Protocol` had zero occurrences in the repo — this ADR closes an undocumented gap.

### Context
SingulariTree exposes its Git core as a contract-first gRPC service (`singularitree.v1.GitCore`, `libs/contracts/proto/gitcore.proto`) with an HTTP fallback and a headless `--headless` mode emitting `GO_CORE_READY`. Goal: let an AI client drive/query that same core via MCP, spun off as a decoupled, optional surface. Additive: must not block/alter the Phase 0 spine nor touch Necomat `frontend/`/`backend/`.

**Non-negotiable constraints:** (1) hexagonal — MCP is a new inbound/driving adapter, never coupled into domain/service; (2) gRPC stays primary, MCP optional/decoupled; (3) MCP usable against the Go core independently of Electron/Angular; (4) Necomat untouched.

### Decision
**1. Placement.** New inbound adapter `apps/go-core/internal/adapter/mcp/` + composition root `apps/go-core/cmd/mcp-server/main.go`, mirroring `adapter/grpc` + `cmd/go-core`. Calls the existing service layer (`RepoService`, `GitService`, `GraphService`, `CacheService`, `WatcherService`) in-process. `domain` gains no MCP types. Extract the DI in `cmd/go-core/main.go` into a reusable `apps/go-core/internal/bootstrap` package so both `cmd` roots share wiring. Ship as a standalone binary; embedded `go-core --mcp-stdio` is a possible later convenience.

**2. Transport.** Primary MCP over stdio (client spawns the binary; headless, no socket/token). Secondary (later) MCP Streamable HTTP on loopback. Reconciles ADR-007: that ADR discarded stdio for the supervisor↔core hop, not for a client-facing adapter hop. Mapping: unary RPCs → 1:1 tools (`GetCommits`→`git_get_commits`); `StreamCommits` not exposed (use paginated `git_get_commits`); `Fetch/Push/Pull` → one tool call bridging `Progress` to MCP `notifications/progress` with cancellation (`notifications/cancelled` → gRPC stream context-cancel, closing R12); `Watch` → cursor/poll tool `git_events(since_cursor)`. Calls are in-process, not a gRPC loopback.

**3. Tool surface.** snake_case `git_<verb>`; input JSON Schema generated from proto messages (`protoreflect`/buf), never hand-duplicated; outputs are protojson-marshalled contract types. Failures return `isError:true` with canonical `AppError{code,message,details}`. Read set: `git_ping`, `git_list_repositories`, `git_get_repository`, `git_get_commits`, `git_get_branches`, `git_get_tags`, `git_get_stashes`, `git_get_worktrees`, `git_get_remotes`, `git_get_status`, `git_get_diff`, `git_events`. Mutation set behind `--allow-write`: `git_stage`, `git_unstage`, `git_commit`, `git_checkout`, `git_fetch`, `git_push`, `git_pull`. Annotations: read `readOnlyHint:true`; destructive mutations `destructiveHint:true`.

**4. Security/auth.** Two trust boundaries. (a) AI client → MCP adapter (stdio): OS process model, no token; HTTP mode = loopback bind + per-session Bearer + Origin check, never `0.0.0.0`. (b) MCP adapter → core: in-process, no core token — does NOT reuse/rotate the `GO_CORE_READY` supervisor token; rotation must never invalidate a live MCP session. Default read-only; `--allow-write` opt-in; optional repo-root allowlist. Never surface GitHub OAuth secrets.

**5. Sequencing.** ADR now (no code); excluded from Phase 0 spine; MCP-A read-only after MVP read path stable; MCP-B writes/progress/cancel; MCP-C Streamable HTTP + resources/prompts. Placed **before** V1.3 hosting integrations.

**6. Risks & alternatives.** Risks: streaming mismatch (cursor tool + progress/cancel); SQLite single-writer (R4) — MCP is sole core process with own DB, OR runs `--proxy-grpc` against a running go-core; two simultaneous full writers to cache.db disallowed; schema drift vs proto (R6) — schemas generated + CI check; composition-root drift — shared `internal/bootstrap`; MCP spec churn — isolate behind `adapter/mcp`, pin SDK. Alternatives rejected: (A) expose HTTP fallback directly (no discovery/schema/progress; HTTP stays a debug/curl fallback per ADR-004); (B) wrap the Electron bridge `window.gitClientApi` (requires Electron, violates headless constraint, adds Node hop, couples MCP to GUI lifecycle); (C) do nothing (does not satisfy intent); (D) add AI-specific gRPC RPCs (unnecessary).

**Consequences.** + AI clients get typed, discoverable access to the same core; reuses service layer + contract types; fully headless/optional; hexagonal substitutability preserved. − new adapter + binary + shared-wiring refactor; a second surface to keep schema-consistent; an explicit DB-ownership rule now required; MCP spec needs a versioning/pinning policy.

---

> All ADRs have traceability to `architecture.md`, `ipc-strategy.md`, `service-design.md`, `domain-model.md`, and the physical skeleton (`supervisor.ts`, `main.go`, `preload.ts`, `*.proto`, `001_initial.sql`).
