# Folder structure — SingulariTree Monorepo

> Source of truth for the tree: the repo's `README.md`. This document adds **rationale** per folder.

## 1. Canonical tree

```
SingulariTree/                         <- monorepo root (physical folder SingulariTree, logical alias git-client)
├── docs/
│   └── context/
│       └── git-client/                <- THIS FOLDER: 12 design docs (greenfield topic folder)
│           ├── INDEX.md               <- index + deliverables map (canonical)
│           ├── README.md              <- alias of INDEX.md
│           ├── architecture.md        <- C4 L1-3 + hexagonal + headless proof §5
│           ├── folder-structure.md    <- this file
│           ├── module-diagram.md      <- mermaid C4 + IPC sequence + hexagonal proof
│           ├── domain-model.md        <- entities, VOs, aggregates, SQLite schema, errors
│           ├── ipc-strategy.md        <- preload bridge + gRPC/HTTP + proto sketch + supervisor §2.6 + security
│           ├── service-design.md      <- Go services, Angular stores, cache, watchers, pagination
│           ├── testing-strategy.md    <- pyramid, vitest/go test/playwright
│           ├── roadmap-mvp.md         <- MVP 8-10 weeks
│           ├── roadmap-v1.md          <- V1 16-20 weeks post-MVP
│           ├── risks.md               <- technical risks
│           └── decisions.md           <- 13 justified ADRs
├── apps/
│   ├── angular/                       <- Angular 21 renderer (zoneless, standalone, signals)
│   │   ├── angular.json
│   │   ├── package.json               <- @singularitree/angular
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main.ts                <- bootstrapApplication
│   │       ├── styles.scss
│   │       ├── environments/
│   │       │   ├── environment.ts
│   │       │   └── environment.development.ts
│   │       └── app/
│   │           ├── app.ts / app.config.ts / app.routes.ts
│   │           ├── core/
│   │           │   ├── services/
│   │           │   │   ├── ipc-bridge.service.ts   <- window.gitClientApi wrapper (typed)
│   │           │   │   └── repo-state.service.ts    <- Signals global state
│   │           │   ├── guards/
│   │           │   └── layout/
│   │           ├── features/
│   │           │   └── repo/                        <- vertical feature (see service-design.md)
│   │           │       ├── repo.routes.ts
│   │           │       ├── repo.service.ts
│   │           │       ├── repo-models.ts
│   │           │       ├── page/repo-page.ts
│   │           │       └── ui/repo-list.ts
│   │           ├── shared/
│   │           │   ├── ui/
│   │           │   ├── data/
│   │           │   └── utils/
│   │           └── environments/
│   ├── electron/                      <- Electron shell (main + preload + ipc + window)
│   │   ├── package.json               <- @singularitree/electron
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main/
│   │       │   ├── main.ts            <- app.whenReady, BrowserWindow, supervisor.start
│   │       │   ├── supervisor.ts      <- spawn go-core, GO_CORE_READY, Ping 5s, queue
│   │       │   └── app-menu.ts
│   │       ├── preload/
│   │       │   └── preload.ts         <- single contextBridge.exposeInMainWorld
│   │       ├── ipc/
│   │       │   ├── channels.ts        <- CHANNELS const + validate
│   │       │   ├── handlers.ts        <- ipcMain.handle → forwardToGo
│   │       │   └── events.ts          <- push events (fs:changed, progress)
│   │       └── window/
│   │           ├── window.ts
│   │           └── csp.ts             <- Content-Security-Policy
│   └── go-core/                       <- Go headless core (domain + services + adapters)
│       ├── go.mod                     <- module github.com/SingulariTree/go-core (Go 1.25+)
│       ├── cmd/
│       │   └── go-core/
│       │       └── main.go            <- Viper + DI + gRPC/HTTP, --headless flag
│       └── internal/
│           ├── domain/                <- pure entities + ports (hexagonal center)
│           │   ├── repository.go
│           │   ├── commit.go
│           │   ├── branch.go
│           │   ├── remote.go
│           │   ├── tag.go
│           │   ├── stash.go
│           │   ├── worktree.go
│           │   ├── diff.go
│           │   └── errors.go
│           ├── service/               <- use cases (orchestrate ports)
│           │   ├── repo_service.go
│           │   ├── git_service.go
│           │   ├── graph_service.go
│           │   ├── cache_service.go
│           │   └── watcher_service.go
│           ├── repository/            <- SQLite persistence adapters
│           │   ├── repo_store.go
│           │   └── commit_cache.go
│           ├── adapter/
│           │   ├── git/               <- exec git / go-git (GitPort impl)
│           │   │   └── stub.go
│           │   ├── grpc/
│           │   │   └── server.go
│           │   ├── http/
│           │   │   └── handler.go
│           │   └── watcher/
│           │       └── watcher.go     <- fsnotify + debounce
│           └── config/
│               └── config.go          <- Viper + flags
├── libs/
│   ├── contracts/                     <- Single source of truth (proto → gen)
│   │   ├── package.json               <- @singularitree/contracts
│   │   ├── buf.yaml                   <- v2, lint STANDARD, breaking FILE
│   │   ├── buf.gen.yaml               <- go + grpc/go + ts-proto
│   │   ├── proto/
│   │   │   ├── domain.proto           <- Oid, Signature, Commit, Branch, Remote, Tag, Stash, Diff...
│   │   │   ├── errors.proto           <- AppError + ErrorCode
│   │   │   └── gitcore.proto          <- service GitCore (Ping, GetCommits, StreamCommits, Watch...)
│   │   └── gen/
│   │       ├── go/                    <- buf generate (gitignored keep)
│   │       └── ts/                    <- buf generate
│   └── ui-kit/                        <- shared Angular UI kit (dumb components)
│       ├── package.json
│       ├── ng-package.json
│       └── src/
│           ├── index.ts
│           ├── button/
│           ├── graph-row/             <- graph row with lanes
│           ├── diff-viewer/           <- Monaco wrapper
│           └── styles/
├── data/
│   └── sqlite/                        <- docs + migrations (runtime DB outside the repo)
│       ├── README.md
│       └── migrations/
│           └── 001_initial.sql        <- repos, commit_cache, file_status, stash_cache
├── tools/
│   ├── scripts/
│   │   ├── gen-contracts.sh           <- buf generate --template buf.gen.yaml
│   │   └── build-go-core.sh           <- go build -o dist/go-core ./apps/go-core/cmd/go-core
│   └── ci/
│       └── verify-contracts.sh        <- buf lint + buf breaking + buf generate --dry-run
├── website/                           <- static landing page for GitHub Pages (no build step)
├── go.work                            <- Go workspace (use ./apps/go-core)
├── package.json                       <- root workspaces (angular, electron, contracts, ui-kit)
└── README.md                          <- traceability + headless proof + quick start
```

## 2. Rationale per folder

| Folder | Why it exists | What does NOT go there |
|---------|---------------|---------------|
| `apps/angular` | Isolated renderer; can build without Electron (ng serve against a mock `window.gitClientApi`). Zoneless + signals for graph performance. | Git logic, FS access, spawns. |
| `apps/electron` | Minimal shell; only window + IPC + supervisor. Keeps Angular and Go decoupled. | Git business logic, UI state. |
| `apps/go-core` | Headless core; runs `go run --headless` without UI. Pure hexagonal: `domain` with no external deps. | Electron/Angular code, SCSS, HTML. |
| `apps/go-core/cmd/go-core` | Composition root (DI) — the only place that knows all adapters. | Domain logic. |
| `apps/go-core/internal/domain` | Hexagonal center; VOs/entities testable without IO. | `database/sql`, `grpc`, `fsnotify`. |
| `apps/go-core/internal/service` | Orchestrates ports; transactions; validation. | gRPC/HTTP details. |
| `apps/go-core/internal/adapter/*` | Concrete interchangeable adapters (git exec vs go-git, grpc vs http, fsnotify mock). | Business rules. |
| `apps/go-core/internal/repository` | SQLite adapters; WAL; migrations. | Git logic. |
| `libs/contracts` | Single source of truth; `buf breaking` prevents API regressions. | Implementations. |
| `libs/contracts/gen` | Generated; never edited by hand. `.gitkeep` in scaffold. | Manual code. |
| `libs/ui-kit` | Reusable dumb components (graph-row, diff-viewer). | State, services. |
| `data/sqlite` | Schema docs + migrations; runtime DB at `~/.local/share/...` (outside repo). | User data, Git blobs. |
| `tools/scripts` | Automates `buf generate` and `go build`; CI uses `tools/ci`. | App logic. |
| `website` | Static landing page deployed to GitHub Pages by `.github/workflows/pages.yml`; plain HTML/CSS, no build step. | App code, build output. |
| `docs/context/git-client` | Greenfield topic folder; does not touch Necomat; future promotion to Slices optional. | Code. |

## 3. Import rules

```
Angular  → may import: libs/ui-kit, libs/contracts/gen/ts
          × may NOT import: apps/go-core, apps/electron, data/sqlite

Electron → may import: libs/contracts/gen/ts (to type IPC), apps/go-core (only to resolve bin path)
          × does NOT implement Git logic

Go core  → may import: libs/contracts/gen/go, data/sqlite/migrations (embed)
          × does NOT import Angular/Electron
```

## 4. Why this structure (vs alternatives)

- **npm workspaces monorepo + go.work** vs polyrepo: a single `buf generate` updates both sides atomically; single CI.
- **Separate `libs/contracts`** vs proto inside `apps/go-core`: lets Angular generate types without depending on Go.
- **`data/sqlite/migrations` outside `apps/go-core`**: documents the schema for both worlds; Go uses `embed` at build time.
- **`docs/context/git-client` topic folder** vs immediate `docs/project.md` slice: avoids premature promotion; Necomat untouched.

## 5. Naming convention

- Go module: `github.com/SingulariTree/go-core` (capital S, repo `SingulariTree`).
- Proto package: `singularitree.v1` (lowercase), alias `gitclient.v1` in comments for legacy searches.
- npm scopes: `@singularitree/*` (`@singularitree/angular`, `@singularitree/electron`, `@singularitree/contracts`, `@singularitree/ui-kit`).
- IPC channels: `git:<verb>` (`git:getCommits`, `git:stage`), events `repo:changed`, `fs:changed`, `git:progress`.

## 6. What verifies the structure is valid

```bash
npm run gen:contracts --workspace=@singularitree/contracts  # generates gen/go + gen/ts
go vet ./...                                                 # go-core compiles
ls libs/contracts/proto/*.proto                              # domain, errors, gitcore exist
ls data/sqlite/migrations/001_initial.sql
ls apps/electron/src/main/supervisor.ts apps/electron/src/preload/preload.ts
```
