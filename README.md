# SingulariTree

> **SingulariTree = git-client monorepo** — desktop Git client for Windows and Linux.
> Module alias: **Singularitree** (Go module `github.com/SingulariTree/go-core`, proto package `singularitree.v1` aka `gitclient.v1` for compatibility).
> Design corpus (legacy, under ratchet): [`docs/context/git-client/`](docs/context/git-client/INDEX.md).

> **Agent-facing documentation:** entry point [`docs/project.md`](docs/project.md) · generated index [`docs/index.md`](docs/index.md) · contract in [`docs/context/documentation-system.md`](docs/context/documentation-system.md).
>
> **Website:** [nijnamovich.github.io/singulari-tree](https://nijnamovich.github.io/singulari-tree/) — static landing page (Spanish), source in `website/`. See [Website](#website).

## Monorepo Tree

```
SingulariTree/                         <- monorepo root
├── apps/
│   ├── angular/                       <- Angular 22 renderer (zoneless signals, standalone)
│   │   └── src/app/{app,core,features/<feature>,shared,environments}
│   ├── electron/                      <- Electron shell (main + preload + ipc + window, supervisor)
│   │   └── src/{main,preload,ipc,window}
│   └── go-core/                       <- Go headless core (domain + services + adapters)
│       ├── cmd/go-core/main.go        <- DI + gRPC/HTTP, --headless flag
│       └── internal/{domain,service,repository,adapter/{git,grpc,http,watcher},config}
├── libs/
│   ├── contracts/                     <- Single contract source (proto -> gen/go + gen/ts)
│   │   ├── proto/{auth,domain,errors,gitcore}.proto
│   │   ├── buf.yaml  buf.gen.yaml     <- buf module + generation template
│   │   └── gen/{go,ts}/               <- generated stubs (buf generate)
│   └── ui-kit/                        <- shared Angular UI kit (dumb components)
├── data/
│   └── sqlite/                        <- WAL per-user DB docs + migrations (runtime DB outside repo)
│       └── migrations/00*.sql
├── docs/                              <- documentation corpus (entry point: docs/project.md)
│   ├── context/                       <- strategic context docs
│   ├── slices/  protocols/  adrs/     <- slice hub, protocols, decision records
│   └── project.md                     <- agent-facing entry point
├── tools/
│   ├── scripts/                       <- gen-contracts, build-go-core, gen-migrations, CI helpers
│   ├── ci/                            <- verify-contracts, verify-migrations, verify-docs
│   └── docs/validate.js               <- documentation corpus validator
├── website/                           <- static landing page for GitHub Pages (no build step)
├── .github/workflows/                 <- CI (ci.yml) + GitHub Pages (pages.yml)
├── Dockerfile  compose.yaml           <- containerized headless Go core
├── go.work                            <- Go workspace (use ./apps/go-core)
└── README.md
```

## Traceability

- Canonical entry point: `docs/project.md` — stack, slices, commands, corpus navigation
- Generated index: `docs/index.md` · tag index: `docs/tag-index.md`
- Renderer UI plan: `docs/context/renderer-redesign-plan.md` · design system: `docs/context/design-system.md`
- Legacy design corpus: `docs/context/git-client/INDEX.md`
  - Architecture (C4 + Hexagonal + headless proof): `docs/context/git-client/architecture.md`
  - Folder structure: `docs/context/git-client/folder-structure.md`
  - Module / hexagonal proof: `docs/context/git-client/module-diagram.md`
  - Domain model (entities, SQLite tables, errors): `docs/context/git-client/domain-model.md`
  - IPC strategy (preload bridge + gRPC/HTTP, proto sketch §2.3, supervisor §2.6): `docs/context/git-client/ipc-strategy.md`
  - Service design (Go services, Angular stores, cache, watchers): `docs/context/git-client/service-design.md`

## Headless Proof (`docs/context/git-client/architecture.md` §5)

Go core compiles and runs without Electron or Angular:

```bash
# from repo root SingulariTree/
go run ./apps/go-core/cmd/go-core --headless --grpc-addr unix:///tmp/singularitree-go.sock --db ~/.local/share/singularitree/cache.db

# compiled binary (ephemeral localhost ports):
./dist/go-core --headless --grpc-addr 127.0.0.1:0 --http-fallback-addr 127.0.0.1:0 --log-level info
# stdout when ready:
# GO_CORE_READY addr=unix:///tmp/singularitree-go.sock http=127.0.0.1:0 token=<32B hex>
```

Behavior in `--headless`:
- starts gRPC on a Unix socket (Linux) or a named pipe `\\.\pipe\singularitree-go-core` (Windows) and HTTP fallback on ephemeral localhost;
- prints `GO_CORE_READY addr=... http=... token=...` for supervisor discovery;
- health `Ping` every 5s; graceful shutdown on `SIGTERM`/`SIGINT`.

The same core also runs containerized (`Dockerfile` + `compose.yaml`):

```bash
docker compose up --build core    # headless core; gRPC socket bind-mounted at ./ipc
```

The container exposes **no** TCP port: the gRPC unix socket is shared with the
host through the `./ipc` bind mount, and the HTTP fallback stays on the
container's own loopback.

## Contracts

- Go module: `github.com/SingulariTree/go-core` (Go 1.25+)
- Proto package: `singularitree.v1` (alias `gitclient.v1` for compatibility — see `libs/contracts/proto/*.proto` header comments)
- Source of truth: `libs/contracts/proto/*.proto` (buf module `libs/contracts/buf.yaml`)
- Generation: `buf generate --template buf.gen.yaml` from `libs/contracts/` -> `libs/contracts/gen/go` + `libs/contracts/gen/ts` (or `./tools/scripts/gen-contracts.sh`)
- CI gate: `tools/ci/verify-contracts.sh` — `buf lint` + `buf breaking` against `main` + a generated-drift check

## Website

Static landing page (Spanish) — plain HTML/CSS, **no build step**.

- Source: `website/` (`index.html`, `styles.css`, `assets/`)
- Live: <https://nijnamovich.github.io/singulari-tree/>
- Deploy: `.github/workflows/pages.yml` uploads `website/` with `actions/upload-pages-artifact` and publishes with `actions/deploy-pages` on pushes to `main` that touch `website/**` or the workflow; manual runs via `workflow_dispatch`.
- One-time setup: **Settings → Pages → Source: GitHub Actions** (already enabled; `build_type: workflow`).
- Illustrative only: the page states that there is **no public release yet** and that all builds are unsigned/preliminary.

Local preview: open `website/index.html` in a browser (relative asset paths, no server needed).

## Quick Start

**Prerequisites:** Node >=22.22.3 (npm workspaces) · Go 1.25+ (the Go workspace targets 1.26) · `git` on `PATH`. Only for regenerating contracts: [`buf`](https://buf.build/docs/installation) — `./tools/scripts/gen-contracts.sh` fails fast if it is missing.

```bash
# 1. Install JS/TS dependencies (postinstall provisions the Electron binary)
npm ci

# 2. Build all three runtimes from the repo root
./tools/scripts/build-go-core.sh                    # -> dist/go-core (or dist/go-core.exe)
npm run build --workspace=@singularitree/angular    # -> apps/angular/dist/browser
npm run build --workspace=@singularitree/electron   # -> apps/electron/dist/main/main.js
# `npm run build` at the root builds every JS workspace that has a build script
# (angular, electron, ui-kit). The contracts workspace ships generated stubs, so
# it has no build step of its own.

# 3. Run the dev app (Angular `ng serve` + Electron, via concurrently + wait-on)
npm start
npm run start:electron-only                         # Electron shell only
npm run start:mock --workspace=@singularitree/electron   # mock core, opt-in via MOCK_GO_CORE=1
```

`MOCK_GO_CORE=1` is **strictly opt-in** — the real `go-core` is the default. The dev scripts build the shell, then launch Electron pointed at the Angular dev server (`http://localhost:4200`).

> **Stale-binary guard.** `npm start` rebuilds the renderer and the shell but
> never `dist/go-core`, so a core RPC added after step 2 would be missing from
> the running app while every unit suite stays green. The root `prestart` hook
> therefore runs `node tools/scripts/verify-go-core-fresh.js`, which compares
> the binary's mtime against the newest mtime of the Go core sources (plus the
> generated Go contract stubs and `go.work`) and **fails loudly** with the
> rebuild command instead of letting a stale binary be used. Rebuild with
> `./tools/scripts/build-go-core.sh` (and `./tools/scripts/gen-contracts.sh`
> first if a proto changed). `Supervisor.spawn`'s prefer-existing-binary policy
> is unchanged on purpose — the guard, not a policy change, closes the hole.

Tests (the npm workspace commands run from the repo root; the Go and Playwright
ones from their package directory):

```bash
npm test --workspace=@singularitree/angular     # Angular vitest (`ng test --no-watch`)
npm test --workspace=@singularitree/electron    # Electron vitest (`vitest run`)
cd apps/go-core && go test ./...                # Go core
cd apps/electron && npx playwright test         # e2e smoke — needs the three builds above
```

`./tools/scripts/run-tests-local.sh` reproduces the full CI suite locally
(build + Go tests + Electron vitest + Playwright smoke); `--go-only`,
`--ts-only`, `--e2e-only` and `--build-only` narrow it down.

Package (**UNSIGNED** — code signing is V1):

```bash
cd apps/electron
npm run pack   # unpacked dir -> apps/electron/release/
npm run dist   # installers   -> apps/electron/release/
```

Targets from `apps/electron/electron-builder.yml`: Windows `nsis` + `portable`, Linux `AppImage` + `deb`. Before packaging, `dist/go-core`, `apps/angular/dist/browser/` and `apps/electron/dist/main/` must exist — `extraResources` copies the renderer, core binary and `libs/contracts/proto` into the package. Build installers on the **target OS**: Windows `nsis` generally needs Windows or wine. The macOS targets were dropped by decision (ADR-0038); on a Linux host build the Windows targets explicitly with `electron-builder --win`. macOS is not a supported development host for the desktop shell — the Electron provisioner refuses a macOS binary, so a macOS host must set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` to install the JavaScript toolchain — while the Go core still builds and runs on macOS.

## Screenshots

> **Placeholder — no real screenshots committed yet.** The Electron GUI cannot be captured in this headless environment, so the image below is a labeled SVG placeholder, **not a product screenshot**.

![Placeholder for the SingulariTree UI screenshots](docs/assets/placeholder-screenshot.svg)

Screenshots to capture manually and drop into `docs/assets/` (filenames and exact state in `docs/assets/README.txt`):

| # | Screenshot | State to capture |
|---|---|---|
| 1 | Repo picker | first launch, empty state |
| 2 | Commit graph | repo opened, a commit selected |
| 3 | Diff view | the commit analyzer on a selected commit (diff of one file) |
| 4 | Packaging artifact | `apps/electron/release/` after `npm run dist` (e.g. the AppImage) |

Replace `docs/assets/placeholder-screenshot.svg` with the real captures and update the image links above.
