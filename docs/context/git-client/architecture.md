# Architecture — C4 + Hexagonal + Headless Proof

> Stack: Angular latest stable + Signals + TypeScript + SCSS, Electron, Go 1.25+, SQLite WAL, IPC Electron↔Angular (contextIsolation + preload) + Electron↔Go (gRPC unix socket/named pipe primary + HTTP fallback). Principles: performance, scalability, clean architecture, maintainability, automated testing.

## 1. C4 Vision

### 1.1 Level 1 — System Context

```
User ──▶ SingulariTree Desktop App (Angular + Electron + Go + SQLite)
                │
                ├──▶ Filesystem / .git  (go-git / exec git)
                ├──▶ Git remotes (fetch/pull/push)
                └──▶ SQLite per-user (config, recents, favorites, prefs, UI-state, metadata cache — NO Git objects)
```

- **Actor:** developer on Linux/Windows/macOS.
- **SingulariTree:** a single system; Electron is the shell, Angular is the renderer, Go is the business core.
- **External:** Git repos on disk, HTTPS/SSH remotes.

### 1.2 Level 2 — Containers

| Container | Runtime | Responsibility | Communication | Replaceable |
|-----------|---------|-----------------|--------------|--------------|
| **Angular renderer** | Chromium (Electron renderer) | UI: graph, Monaco diff, status/stage, history, stash, branches | `window.gitClientApi` → IPC (invoke/handle + events) | Yes — any SPA that speaks `gitClientApi` |
| **Electron main + preload** | Node + Electron main | Shell, windows, menus, Go `supervisor`, IPC bridge | `contextBridge` + `ipcMain.handle` + gRPC/HTTP client to Go | Yes (Tauri/Wails) — keeps the contract |
| **Go core headless** | Go 1.25+ binary | All Git, graph lanes, cache, watchers, diff, progress streaming | gRPC (`singularitree.v1`) primary + HTTP fallback | Yes — runs without UI (`--headless`) |
| **SQLite** | file WAL | Only config/recents/favorites/prefs/UI-state/metadata cache | `database/sql` + `modernc.org/sqlite` or `mattn/go-sqlite3` | Yes — never Git objects |
| **Contracts** | buf + proto | Single source of truth | `libs/contracts/proto/*.proto` → `gen/go + gen/ts` | — |

Diagram:

```
┌──────────────────┐   contextBridge    ┌─────────────────┐  gRPC (unix socket) / HTTP  ┌──────────────┐
│ Angular (Signals)│ ─────────────────▶ │ Electron main   │ ───────────────────────────▶ │ Go core      │
│  Signals Stores  │ ◀───────────────── │ + supervisor    │ ◀─────────────────────────── │  services    │
│  + Monaco+Graph  │   events (fs:changed, repo:changed, progress)                 │  + adapters  │
└──────────────────┘                    └─────────────────┘                              └──────┬───────┘
                                                                                              │ SQLite WAL
                                                                                       ┌──────▼───────┐
                                                                                       │ SQLite cache │
                                                                                       └──────────────┘
                                                                                              │ git CLI / go-git
                                                                                       ┌──────▼───────┐
                                                                                       │ .git / refs  │
                                                                                       └──────────────┘
```

### 1.3 Level 3 — Components (per container)

**Angular (`apps/angular/src`):**
- `app/core/services/ipc-bridge.service.ts` — typed wrapper over `window.gitClientApi`.
- `app/core/services/repo-state.service.ts` — Signals global (current repo, status, polling).
- `features/repo/{page,ui,repo.service.ts}` — pages per feature (history, graph, status, diff, branches).
- `shared/ui + libs/ui-kit` — dumb components (`graph-row`, `diff-viewer`, `button`).

**Electron (`apps/electron/src`):**
- `main/main.ts` — `app.whenReady`, `BrowserWindow` (contextIsolation, CSP `window/csp.ts`), `supervisor.start()`.
- `main/supervisor.ts` — spawns Go, awaits `GO_CORE_READY`, Ping 5s, backoff, queue, token rotation.
- `preload/preload.ts` — **only** `contextBridge.exposeInMainWorld('gitClientApi', api)`.
- `ipc/{channels.ts,handlers.ts,events.ts}` — validation + `ipcMain.handle` mapping; forward to Go.
- `window/*` — window creation, CSP.

**Go core (`apps/go-core/internal`):**
- `domain/` — pure entities (`repository.go`, `commit.go`, `branch.go`, `remote.go`, `tag.go`, `stash.go`, `worktree.go`, `diff.go`, `errors.go`) + ports (interfaces).
- `service/` — use cases (`repo_service.go`, `git_service.go`, `graph_service.go`, `cache_service.go`, `watcher_service.go`) — orchestrate ports.
- `repository/` — SQLite repos (`repo_store.go`, `commit_cache.go`).
- `adapter/{git,grpc,http,watcher}` — adapters: `git` (exec/`go-git`), `grpc/server.go`, `http/handler.go`, `watcher/watcher.go` (fsnotify).
- `config/config.go` — Viper + flags.
- `cmd/go-core/main.go` — DI + gRPC/HTTP bind + `--headless` + `GO_CORE_READY` + `signal.NotifyContext`.

**Contracts (`libs/contracts`):**
- `proto/domain.proto`, `errors.proto`, `gitcore.proto` — `package singularitree.v1`.
- `buf.yaml` v2 + `buf.gen.yaml` → `gen/go`, `gen/ts`.

## 2. Hexagonal (Ports & Adapters)

Rules:
- `domain/` does not import `service/`, `adapter/`, or `repository/`.
- `service/` depends on interfaces (ports) defined in `domain/`, not on concrete types.
- `adapter/` implements ports.
- Angular never imports Go; Electron never implements Git logic.
- **Optional inbound adapters:** MCP (Model Context Protocol) is an additional inbound/driving adapter over the same Go core — isolated in `adapter/mcp` + `cmd/mcp-server`, consumes the `service` layer in-process and never couples to `domain/`/`service/` (details and MCP-A/B/C phases in ADR-013).

```
             ┌─────────────────────┐
             │   Angular / Electron│  Driving adapters (primary)
             │   (ipc handlers)    │
             └──────────┬──────────┘
                        │ calls
             ┌──────────▼──────────┐
             │   Service layer     │  Use cases (GraphService, GitService…)
             │   (ports defined)   │
             └──────────┬──────────┘
         ┌──────────────┼──────────────┐
         │              │              │
  ┌──────▼─────┐ ┌─────▼──────┐ ┌───▼────────┐
  │ GitPort    │ │ CachePort  │ │ WatcherPort│  Ports (domain/)
  └──────┬─────┘ └─────┬──────┘ └───┬────────┘
         │             │            │
  ┌──────▼─────┐ ┌─────▼──────┐ ┌───▼────────┐
  │ git/exec   │ │ sqlite     │ │ fsnotify   │  Driven adapters (secondary)
  │ go-git     │ │ WAL        │ │ coalescing │
  └────────────┘ └────────────┘ └────────────┘
```

**Proven substitutability:**
- Angular → Svelte/React: just reimplement the `window.gitClientApi` consumer.
- Electron → Tauri: keep the `supervisor` contract (spawn Go, `GO_CORE_READY`).
- `go-git` → exec git: change `adapter/git` without touching services.
- Go core → optional MCP surface (stdio): `adapter/mcp` reuses the service layer in-process; the gRPC spine and `--headless` do not change (see ADR-013).

Key interfaces already sketched:
```go
type GitPort interface {
  List(ctx, repoID, offset, limit) ([]Commit, int, error)
  GetStatus(ctx, repoID) ([]FileStatus, error)
  GetDiff(ctx, repoID, from, to) (Diff, error)
  Stage(ctx, repoID, paths) error
  // …
}
type CachePort interface { GetCommits / SetCommits / Invalidate }
type WatcherPort interface { Watch(repoID) (<-chan FsChangedEvent, error) }
```

## 3. Dependencies and data flow

- **Input:** repo path on disk → `RepoService.Open` validates `.git`/commonDir → persists in the `repos` table.
- **Output:** paginated commits → `GraphService` → `GrpcServer` → `supervisor.forwardToGo` → `ipcRenderer` → `IpcBridge` → Signals store → virtualized graph.
- **State:** SQLite is the source of truth for metadata cache/UI-state; `.git` is the source of truth for Git data.
- **Side effects:** the file watcher invalidates cache; push/pull stream `Progress`.

## 4. Architectural decisions (summary, details in decisions.md)

- gRPC primary + HTTP fallback (named pipe/unix socket) — streaming performance + compatibility.
- SQLite WAL per-user — concurrency without a server, versioned migrations.
- `buf` contracts — breaking check in CI.
- Monaco + canvas/CDK virtual scroll — 50k commits.
- Viper + flags for Go config — 12-factor.

## 5. Headless Proof (README.md §5 — executable contract)

The Go core **must** compile and run without Electron/Angular.

**CLI contract:**
```bash
# from the SingulariTree/ monorepo root
go run ./apps/go-core/cmd/go-core --headless --grpc-addr unix:///tmp/singularitree-go.sock --db ~/.local/share/singularitree/cache.db
# or ephemeral:
./dist/go-core --headless --grpc-addr 127.0.0.1:0 --http-fallback-addr 127.0.0.1:0 --log-level info
# stdout when ready (one line, parseable by supervisor):
GO_CORE_READY addr=unix:///tmp/singularitree-go.sock http=127.0.0.1:0 token=<64 hex>
```

**`--headless` behavior:**
- Binds gRPC on a unix socket (Linux/macOS) or named pipe `\\.\pipe\singularitree-go-core` (Windows), HTTP fallback on `127.0.0.1:0` (ephemeral).
- Prints `GO_CORE_READY` and waits for `SIGTERM`/`SIGINT`.
- Health: supervisor does a gRPC `Ping` every 5s; if it fails twice, kill + restart with backoff `[200,500,1000,2000,5000]ms`, rotating the token.
- Queue: up to 100 requests queued while Go restarts; then `QUEUE_FULL`.
- Graceful shutdown 5s.

**Current implementation (scaffold):**
- `apps/go-core/cmd/go-core/main.go` already implements the `--headless` flag, TCP listeners (stub for unix socket), `GO_CORE_READY`, and `signal.NotifyContext`.
- `apps/electron/src/main/supervisor.ts` already implements `awaitReady()` (regex `GO_CORE_READY`), heartbeat, queue drain, token rotation.
- Production will replace the TCP stub with a real unix socket and real gRPC (after `buf generate`).

**Validation:**
```bash
go vet ./...
go run ./apps/go-core/cmd/go-core --headless --help           # flags
timeout 3 go run ./apps/go-core/cmd/go-core --headless --grpc-addr 127.0.0.1:0 --http-fallback-addr 127.0.0.1:0 | grep GO_CORE_READY
```

## 6. Security and guardrails

- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP (`window/csp.ts`), preload is the only bridge.
- Go: 32B hex token rotated per restart; `authorization: Bearer <token>` gRPC metadata + `X-Auth-Token` HTTP; binds only to `127.0.0.1` / unix socket (never `0.0.0.0`).
- SQLite: WAL + `PRAGMA foreign_keys=ON`, per-user path, idempotent migrations.

## 7. Scalability for large repos

- Graph: `git log --graph` lanes O(n) incremental, LRU window `200+100`, virtualization (CDK or canvas) — see `service-design.md §1.2`.
- Diff: Monaco workers + chunking + 1MB limit with plain text fallback.
- Watchers: fsnotify + debounce 150-300ms + `.git/index.lock` guard.
- Cache: `commit_cache` index `(repo_id, committed_at DESC)`, invalidation via `fs:changed`.

## 8. Discarded alternatives (see decisions.md)

- Frontend talking directly to `go-git` via WASM — violates hexagonal, blocks headless.
- HTTP REST only — loses streaming and typing; gRPC is superior for `Watch`/`StreamCommits`/`Fetch` progress.
- SQLite storing Git blobs — anti-pattern, breaks git as source of truth.
