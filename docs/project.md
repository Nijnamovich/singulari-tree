---
last_updated: 2026-10-25
status: active
description: Agent-facing entry point of SingulariTree — Angular + Electron + Go core monorepo; stack, slices, commands and corpus navigation.
tags:
- project
- entry-point
- singularitree
version: 1.10.0
doc_language: en
---

# SingulariTree — Project Entry Point

## Overview

SingulariTree is a **monorepo** for a cross-platform desktop Git client. System shape:

> **the graph/files are the truth; SQLite only stores a metadata cache, NEVER Git objects.**

- **Headless Go core** (`apps/go-core`): can run without Electron or Angular (`--headless`, emits `GO_CORE_READY`).
- **Hexagonal architecture** (ports & adapters): contact with Git exists **only** inside the Go core.
- The renderer never talks to Git; everything crosses IPC → shell → core.

**Anti-goals** (non-negotiable):

- The renderer **never** talks to Git directly.
- **No** Git objects are stored in SQLite — only metadata cache, config and UI-state.
- Necomat `frontend/` and `backend/` are **not** modified.

## Technology Stack

| Area | Technology |
|---|---|
| JS runtime | Node >=22.22.3 (npm workspaces; CI pins 24 LTS) |
| Renderer | Angular 22 (zoneless, standalone, signals) + TypeScript ~5.9 |
| Shell | Electron ^42 (pinned 42.11.9) with TypeScript |
| Core | Go 1.25 (module `github.com/SingulariTree/go-core`) in a Go 1.26 workspace (`go.work`) |
| Transport | gRPC (`google.golang.org/grpc` 1.84) with HTTP fallback |
| Persistence | SQLite `modernc.org/sqlite` (WAL, `foreign_keys=ON`, per-user DB outside the repo) |
| Contracts | proto with `buf` (package `singularitree.v1`, alias `gitclient.v1`) |
| Tests | vitest (Angular and Electron), `go test` (core) |
| Pattern | Hexagonal + contract-first |

## Slices

| Slice | Description | Keywords | Entry points | Primary agents |
|---|---|---|---|---|
| contracts | Single source of proto contracts (buf) and generated Go/TS stubs; compatibility boundary between core, shell and renderer. | proto, buf, singularitree.v1, gitclient.v1, grpc, generated, gen/go, gen/ts, breaking | `libs/contracts/`, `libs/contracts/proto/`, `libs/contracts/gen/` | coder, tester, reviewer |
| core | Headless Go core: domain, services, SQLite repository and git/grpc/http/watcher adapters. | go, domain, service, repository, sqlite, wal, adapter, git, watcher, grpc, http, headless, hexagonal | `apps/go-core/`, `apps/go-core/internal/`, `data/sqlite/` | coder, tester, reviewer |
| desktop-shell | Electron shell: window lifecycle, preload/IPC, Go core supervisor, menu and CSP. | electron, preload, ipc, supervisor, window, menu, csp, main, GO_CORE_READY | `apps/electron/`, `apps/electron/src/main/`, `apps/electron/src/ipc/` | coder, tester |
| renderer | Angular 22 SPA (zoneless, signals, standalone), features and stores; shared UI kit. | angular, signals, zoneless, standalone, component, route, store, vitest, ui-kit | `apps/angular/`, `libs/ui-kit/` | coder, tester |
| tooling | Build/generation scripts, CI and validations (contracts, migrations, docs). | ci, script, build, verify, workspace, go.work, npm, buf, validate | `tools/`, `tools/ci/`, `tools/scripts/` | coder, reviewer |
| docs | Documentation corpus, slices, ADRs, protocols and generated indexes. | docs, frontmatter, hub, index, adr, tag, protocol, slice, onrails | `docs/`, `docs/context/`, `docs/protocols/`, `docs/adrs/` | documenter, explorer |

## Commands

| Command | Purpose |
|---|---|
| `npm start` (root) | full Angular + Electron dev |
| `npm run start:electron-only` | Electron shell only |
| `npm run build --workspace=@singularitree/angular` | renderer build |
| `npm test --workspace=@singularitree/angular` | renderer vitest |
| `npm test --workspace=@singularitree/electron` | shell vitest |
| `npm run typecheck --workspace=@singularitree/electron` | tsc --noEmit |
| `cd apps/go-core && go vet ./...` | core vet (**NEVER** from the root) |
| `cd apps/go-core && go test ./...` | core tests |
| `go run ./apps/go-core/cmd/go-core --headless --help` | headless flags (via `go.work`) |
| `./tools/scripts/gen-contracts.sh` | generates proto stubs (`buf generate`) |
| `./tools/ci/verify-contracts.sh` | contracts breaking check |
| `./tools/ci/verify-migrations.sh` | validates SQLite migrations |
| `./tools/scripts/build-go-core.sh` | builds the core binary |
| `node tools/scripts/verify-go-core-fresh.js` | staleness guard: fails loudly when `dist/go-core` predates the Go core sources (runs automatically from root `prestart`, i.e. on every `npm start`) |
| `./tools/scripts/run-tests-local.sh` | reproduce the CI suites locally (build + go test + Electron vitest + Playwright smoke); `--go-only`/`--ts-only`/`--e2e-only`/`--build-only` narrow it, `--windows-paths` adds a best-effort Wine run |
| `node tools/docs/validate.js` | validates the corpus (exit 1 on errors) |
| `node tools/docs/validate.js --write` | regenerates `docs/index.md` + `docs/tag-index.md` |
| `./tools/ci/verify-docs.sh` | documentation CI hook |

## Repository Structure

```
SingulariTree/
├── apps/
│   ├── angular/        # Angular 22 renderer SPA (zoneless, signals, standalone)
│   ├── electron/       # Electron shell: main, preload, ipc, supervisor
│   └── go-core/        # headless Go core (domain, service, repository, adapter)
├── libs/
│   ├── contracts/      # single proto source (buf) + gen/go and gen/ts stubs
│   └── ui-kit/         # shared Angular UI kit (dumb components)
├── data/
│   └── sqlite/         # migrations; per-user runtime DB outside the repo
├── tools/
│   ├── scripts/        # gen-contracts.sh, build-go-core.sh, gen-migrations.sh
│   └── ci/             # verify-contracts.sh, verify-migrations.sh, verify-docs.sh
├── docs/
│   ├── context/        # strategic docs (git-client/ legacy under ratchet)
│   ├── slices/         # slices + slices-index.md (hub)
│   ├── protocols/      # corpus protocols
│   ├── adrs/           # decision records (append-only)
│   ├── project.md      # entry point (this file)
│   ├── index.md        # generated index
│   └── tag-index.md    # generated tag index
├── go.work             # Go workspace (use ./apps/go-core)
└── README.md           # human README (outside the corpus)
```

## Key Conventions

- Contracts with a single source `libs/contracts/proto/*.proto` → `gen/{go,ts}` via `buf generate`; never edit generated files by hand.
- Proto package `singularitree.v1` with alias `gitclient.v1` for compatibility.
- `doc_language: en`: English; onrails contract headings stay verbatim.
- Naming `lowercase-kebab-case`; the `id` matches the file stem.
- The frontend never talks to Git; the Go core is headless and hexagonal.
- SQLite per user (WAL, `foreign_keys=ON`) and **NEVER** stores Git objects.
- Necomat `frontend/`/`backend/` remain intact.
- Tests/builds from the package directory (never the root, except Go via `go.work`).
- ADRs are append-only; numbering continues at ADR-043 (last used: ADR-0042; new files use the padded form, e.g. `adr-0040-…`).

## Domain Entities

**App:** `Repository` (root aggregate), `Commit` (immutable DAG), `Branch`, `Tag`, `Stash`, `Worktree`, `Remote`, `Diff`, `Author`/`Identity`.

**Corpus:** `Slice`, `Hub`, `Note`, `Context-doc`, `ADR`, `Protocol`, `Generated region`, `Tag index`, `Resolver`, `Accepted debt`.

## Context Index

- [`docs/context/documentation-system.md`](context/documentation-system.md) — corpus contract, layers, naming and generated indexes.
- [`docs/context/accepted-debt.md`](context/accepted-debt.md) — explicit accepted debt and the ratchet criterion.
- [`docs/context/feature-gap-analysis.md`](context/feature-gap-analysis.md) — feature-gap analysis vs SourceTree/GitKraken plus a prioritized, anti-goal-checked continuation recommendation.
- [`docs/context/git-client/INDEX.md`](context/git-client/INDEX.md) — legacy design corpus, under ratchet.
- [`docs/slices/slices-index.md`](slices/slices-index.md) — slices hub; routes each change to its primary slice.
- [`docs/protocols/bootstrap-protocol.md`](protocols/bootstrap-protocol.md) — corpus start-up and initialization.
- [`docs/protocols/new-note-protocol.md`](protocols/new-note-protocol.md) — create a new note per the contract.
- [`docs/protocols/docs-review-protocol.md`](protocols/docs-review-protocol.md) — corpus review and validator errors.
- [`docs/adrs/adr-index.md`](adrs/adr-index.md) — ADR hub (structural decisions, append-only).
- [`docs/context/renderer-redesign-plan.md`](context/renderer-redesign-plan.md) — total-facelift design plan for the renderer's visible UI (shell, navigation, workspace panes, commit/diff/graph, settings), derived from the operator's git-client sketch with 16 justified divergences; P0–P6 shipped (P4.2 adds the Dark Neon / Developer Studio palette remap; P5 lands the secondary surfaces, the expanded Settings and the shared-modal focus trap; P6 — responsive, a11y & motion polish — is the final phase of the facelift: the ≤1600 / ≤1100 / ≤800 breakpoint utilities and stacked shell, the nav-rail `aria-expanded` heads, runtime `st:motion` enforcement, and the regenerated en/es message catalogues).
- [`docs/context/design-system.md`](context/design-system.md) — shipped Dark Neon / Developer Studio design system: two-tier token vocabulary (dark + light), typography, spacing and geometry, the ui-kit component inventory, and copy-paste usage.
- [`docs/context/repository-configuration.md`](context/repository-configuration.md) — repository-level GitHub configuration: the verified permissions audit of the three workflows (including the release pipeline's two read-only build jobs and its single write-scoped publish job), the UI-only settings checklist, the initial hardening recommendations, and the unsigned-installer consequences on Windows and Linux.

## Common Lookups

| Symptom / question | Where to look |
|---|---|
| I don't know where my task falls | [docs/slices/slices-index.md#contents](slices/slices-index.md#contents) |
| I'm about to create a new note | [docs/protocols/new-note-protocol.md#solution](protocols/new-note-protocol.md#solution) |
| The docs validator fails with `metadata-outside-contract` | [docs/protocols/docs-review-protocol.md#solution](protocols/docs-review-protocol.md#solution) |
| I want to regenerate the documentation index | [docs/context/documentation-system.md#solution](context/documentation-system.md#solution) |
| `go-core` does not start headless (missing `GO_CORE_READY`) | [docs/context/git-client/architecture.md#5-headless-proof-readmemd-5--executable-contract](context/git-client/architecture.md#5-headless-proof-readmemd-5--executable-contract) |
