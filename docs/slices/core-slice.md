---
id: core-slice
category: slices
tags:
- slice
- generality
aliases:
- Core slice
related:
- slices-index
version: 1.4.0
status: active
---

# Core — Slice Generalities

## What this slice is

Headless Go core that concentrates the domain, the services, the repository and the adapters. It does not depend on Electron or Angular: it can be compiled and run on its own.

## Boundaries

- **IN:** `apps/go-core/**`, `data/sqlite/**`.
- **OUT:** contracts, Electron shell and Angular renderer.

## Entry points

- `apps/go-core/cmd/go-core/main.go` — startup and wiring (Viper + DI).
- `apps/go-core/internal/domain/` — entities and ports.
- `apps/go-core/internal/service/` — use cases.
- `apps/go-core/internal/repository/` — SQLite persistence.
- `apps/go-core/internal/adapter/` — adapters (git, grpc, http, watcher).

## How it works

- Hexagonal *ports & adapters* architecture.
- Starts with `--headless` and prints the `GO_CORE_READY` line with the fields `addr`, `http` and the rotated session `token`.
- gRPC is the primary transport (unix socket on Linux and on macOS — the core keeps its darwin build paths even though the product no longer ships a macOS app; named pipe on Windows); HTTP acts as fallback.
- SQLite in WAL mode is a metadata cache; it **never** stores Git objects.
- Coalesced watcher over the filesystem.

## Conventions of this slice

- The domain does not depend on infrastructure.
- One service per use case.
- `go vet` and `go test` run from `apps/go-core`.

## Dependencies

- **Upstream:** contracts, `git` binary, SQLite.
- **Downstream:** desktop-shell (gRPC); renderer (through the shell).

## Known gaps & accepted debt

- The `git` adapter and the real `fsnotify` watcher are implemented (M1: status / stage / commit / diff; M1.5: `.git`-as-gitfile aware, `Watch` → `git:watch` stream).
- M2 landed: per-file `Diff` (`FileDiff` + `truncated`) with hunk/line staging & discard, Reset soft/mixed/hard, and `GetCommitStats` numstat counts cached in SQLite `commit_stats` — [[adr-0020-diff-per-file-and-hunk-staging]], [[adr-0021-reset-modes]], [[adr-0023-commit-change-size-gauge]].
- M3 landed: branch CRUD, `Merge` (MERGE/NO_FF/FF_ONLY/SQUASH; conflicts surfaced, not resolved), tag CRUD, `GetStashes` un-stubbed with `StashApply`/`StashPop`/`StashDrop`, cross-repo commit search over the SQLite `commit_cache` metadata only (**retired by [[adr-0034-retire-cross-repo-commit-search]]**), and git-flow presets (`GetGitFlowConfig`/`SetGitFlowConfig`/`StartGitFlow`/`FinishGitFlow`, migration `003_git_flow_config.sql`) — [[adr-026-cross-repo-commit-search]], [[adr-027-git-flow-presets]], [[adr-028-advanced-git-rpcs]].
- Remaining gaps: `GetWorktrees` (stub), `StreamCommits` IPC streaming, worktrees, GitHub OAuth, and the 3-way conflict editor (M3 surfaces conflicts only).
- The MCP surface is ADR-013 **Proposed** and is not implemented.
