---
id: slices-index
category: slices
tags:
- hub
- index
- slices
aliases:
- Slices Index
related:
- contracts-slice
- core-slice
- desktop-shell-slice
- renderer-slice
- tooling-slice
- docs-slice
version: 1.0.2
status: active
---

# Slices — Index

**What belongs here.** A *slice* is a major area of the codebase delimited by a person — territory, not teams or file types. Each slice groups the pieces that evolve together and has a **generalities** doc (`category: slices`). That doc describes the slice top to bottom with a fixed seven-section structure: what it is, where it starts and ends, how it is entered, how it works, its conventions, its dependencies and its accepted debt.

## Contents

- [[contracts-slice]] — single source of proto contracts and generated stubs; the compatibility boundary between the Go core, the Electron shell and the Angular renderer.
- [[core-slice]] — headless Go core: domain, services, repository and adapters.
- [[desktop-shell-slice]] — Electron shell: main, preload, IPC, supervisor, window, menu and CSP.
- [[renderer-slice]] — Angular 22 SPA (zoneless, standalone, signals), features, stores and shared UI kit.
- [[tooling-slice]] — build/generation scripts and CI.
- [[docs-slice]] — documentation corpus: entry point, context, slices, protocols, ADRs and generated indexes.

## Elsewhere

- Legacy detailed design (greenfield topic folder): `docs/context/git-client/INDEX.md`.
- Architecture decisions (ADRs, append-only): `docs/adrs/adr-index.md`.
- Proposal: once validated, the legacy topic folder can be promoted to the Slices table of `docs/project.md`.
