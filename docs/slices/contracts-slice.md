---
id: contracts-slice
category: slices
tags:
- slice
- generality
aliases:
- Contracts slice
related:
- slices-index
version: 1.1.1
status: active
---

# Contracts — Slice Generalities

## What this slice is

Single source of proto contracts and generated stubs. It is the compatibility boundary between the Go core, the Electron shell and the Angular renderer: all three consume the same types and services generated from `libs/contracts/proto`.

## Boundaries

- **IN:** `libs/contracts/**` — proto, `buf` configuration and generated artifacts.
- **OUT:** business logic (Go core) and IPC runtime (desktop-shell).

## Entry points

- `libs/contracts/proto/` — `.proto` definitions.
- `libs/contracts/buf.yaml` — module and lint configuration.
- `libs/contracts/buf.gen.yaml` — generation template.
- `libs/contracts/gen/go` — Go stubs.
- `libs/contracts/gen/ts` — TypeScript stubs.

## How it works

1. The `proto/*.proto` files are edited.
2. `buf generate --template buf.gen.yaml` produces `gen/go` + `gen/ts`.
3. `go.work` includes `libs/contracts/gen` so the Go core consumes the stubs.
4. `tools/ci/verify-contracts.sh` runs lint + breaking against `main` (subdir `libs/contracts`) + drift.

## Conventions of this slice

- Proto package `singularitree.v1` (alias `gitclient.v1`).
- `gen/` is never edited by hand: it is a generated artifact.
- Every breaking change requires `buf breaking`.

## Dependencies

- **Upstream:** `buf` toolchain.
- **Downstream:** Go core, desktop-shell, renderer.

## Known gaps & accepted debt

- M1–M3 landed: the proto surface carries the full core contract — status/stage/commit/diff, hunk/line staging & discard, reset, commit stats, branch CRUD, merge, tag CRUD, stash apply/pop/drop, cross-repo search (RPC and messages removed — **retired by [[adr-0034-retire-cross-repo-commit-search]]**) and git-flow (plus the shell-only deep-link IPC, which is not a proto change) — [[adr-0020-diff-per-file-and-hunk-staging]], [[adr-0021-reset-modes]], [[adr-0023-commit-change-size-gauge]], [[adr-026-cross-repo-commit-search]], [[adr-027-git-flow-presets]], [[adr-028-advanced-git-rpcs]].
- Remaining gaps: `GetWorktrees` is still a stub and `StreamCommits` IPC streaming is not wired; the 3-way conflict editor is not contracted (M3 surfaces conflicts only).
- The `gitclient.v1` alias is transient.
