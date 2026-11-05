# SingulariTree — Documentation Index

> **SingulariTree = git-client monorepo** — Cross-platform desktop Git client.
> Physical folder: `SingulariTree/` · Logical alias: `git-client` · Go module: `github.com/SingulariTree/go-core` · Proto: `singularitree.v1` (alias `gitclient.v1`).

## Purpose

This directory is the canonical **greenfield topic folder** for the complete design of SingulariTree. It does not modify Necomat's `frontend/` or `backend/`. It describes an **Angular + Electron + Go headless + SQLite + gRPC/HTTP + buf contracts** monorepo.

Non-negotiable principles (technical English preserved):
1. **Performance** — virtualized graph, LRU cache, pagination, coalesced watchers.
2. **Scalability** — large repos (50k+ commits), heavy binaries, multiple repos.
3. **Clean Architecture / Hexagonal** — frontend never talks to Git; `ports & adapters`.
4. **Maintainability** — single contracts `libs/contracts/proto -> gen/go + gen/ts`.
5. **Automated testing + modern UX** — vitest, go test, playwright.

---

## Deliverables map (10 + 2)

| # | Document | What it answers | Acceptance criterion |
|---|-----------|--------------|---------------------|
| 1 | [architecture.md](./architecture.md) | C4 L1-3, hexagonal, headless proof (`--headless`, `GO_CORE_READY`, supervisor) | C4 + hexagonal + headless proof |
| 2 | [folder-structure.md](./folder-structure.md) | Monorepo tree with per-folder rationale | Complete structure |
| 3 | [module-diagram.md](./module-diagram.md) | Mermaid C4 + hexagonal proof + IPC sequence | Module diagram |
| 4 | [domain-model.md](./domain-model.md) | Entities, VOs, aggregates, SQLite schema, errors | Domain model |
| 5 | [ipc-strategy.md](./ipc-strategy.md) | Preload bridge, gRPC vs HTTP, proto sketch, supervisor, security | Complete IPC |
| 6 | [service-design.md](./service-design.md) | Go services, Angular Signals stores, cache, watchers, pagination | Service design |
| 7 | [testing-strategy.md](./testing-strategy.md) | Testing pyramid, mocks, testcontainers, e2e | Testing |
| 8 | [roadmap-mvp.md](./roadmap-mvp.md) | MVP 8-10 weeks, epics, DoD | MVP |
| 9 | [roadmap-v1.md](./roadmap-v1.md) | V1 16-20 weeks post-MVP | V1 |
| 10 | [risks.md](./risks.md) | Technical risks, mitigations, RACI | Risks |
| 11 | [decisions.md](./decisions.md) | Justified ADRs (13 decisions) | Decisions |
| 12 | This index | Navigation | Index |

## MCP surface (optional) — ADR-013

- **What:** MCP (Model Context Protocol) as an **optional inbound adapter** over the Go core — lets AI clients drive/query the same core, headless.
- **Where:** `apps/go-core/internal/adapter/mcp/` + `apps/go-core/cmd/mcp-server/main.go` (stdio; HTTP on loopback in phase MCP-C).
- **Status:** **Proposed** (advisory — does not block the Phase 0 spine). See [decisions.md](./decisions.md) ADR-013, [architecture.md](./architecture.md) §2, [module-diagram.md](./module-diagram.md) §2/§5, [risks.md](./risks.md) R13-R15, [roadmap-v1.md](./roadmap-v1.md) workstream MCP-A/B/C.

## Conventions

- **Language:** English (technical terms preserved).
- **Contracts:** single source `libs/contracts/proto/*.proto` → `libs/contracts/gen/go + gen/ts` via `buf generate --template buf.gen.yaml`. Package `singularitree.v1`, alias `gitclient.v1` for compatibility (see proto headers).
- **SQLite:** WAL + `synchronous=NORMAL` + `foreign_keys=ON`, per-user DB outside the repo (`~/.local/share/singularitree/cache.db` or `~/Library/Application Support/...`), **never** stores Git objects.
- **Headless:** `go-core --headless` prints `GO_CORE_READY addr=... http=... token=...` and answers `Ping` every 5s; the supervisor supervises it (see `architecture.md §5` and `ipc-strategy.md §2.6`).

## Quick links (physical skeleton)

- Monorepo root: `SingulariTree/` (this repo)
- Angular: `apps/angular` · Electron: `apps/electron` · Go core: `apps/go-core`
- Contracts: `libs/contracts` · UI kit: `libs/ui-kit` · SQLite: `data/sqlite`
- Tools: `tools/scripts/{gen-contracts,build-go-core}.sh` + `tools/ci/verify-contracts.sh`
- Existing supervisor: `apps/electron/src/main/supervisor.ts`
- Existing preload: `apps/electron/src/preload/preload.ts`
- Headless entrypoint: `apps/go-core/cmd/go-core/main.go`

## Status

Green scaffold: proto contracts + supervisor stub + Go headless stub + migrations `001_initial.sql` exist; buf generation and real Git logic pending (MVP).

## Verification

```bash
ls docs/context/git-client/          # >=10 .md
buf lint                             # ok (buf.yaml v2, package singularitree.v1)
go vet ./...                         # go-core compiles
npm run gen:contracts --workspace=@singularitree/contracts  # buf generate
```

> Future promotion: once validated, this topic folder can be promoted to the Slices table in `docs/project.md`.
