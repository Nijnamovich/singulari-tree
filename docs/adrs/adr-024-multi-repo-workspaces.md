---
id: adr-024-multi-repo-workspaces
category: adrs
tags: [adr, renderer, workspaces, multi-repo, m3]
aliases: [ADR-024, Multi-repo workspaces]
related: [adr-index, feature-gap-analysis, renderer-slice, core-slice, desktop-shell-slice]
version: 1.1
status: superseded
---

# ADR-024: Multi-repo Workspaces — repo tabs + multi-repo fetch

> **Superseded in part by [[adr-0036-per-tab-fetch]] (2026-10-19):** solution item 3 — the renderer-orchestrated fan-out over every open tab — is replaced. The top-bar **Sync** now fetches only the active tab, and every other tab is fetched lazily when it becomes active. The repo-tabs decision (items 1, 2 and 4), the renderer-only boundary and the core's role as a per-repo executor stand unchanged. The decision text below is left verbatim (ADRs are append-only).

## Problem

Today the renderer is single-repo: `ReposPage` opens a repo and routes to that repo's view, and everything downstream (graph, status, branches) assumes one current repo. M3 must let several repos stay open at once — repo tabs — and fetch all open repos together — multi-repo fetch. No entity, RPC or persistence rule records what a "workspace" is, so the risk is either inventing a core-side aggregate (which would learn a UI-only concept and add an entity with no Git truth) or letting repo-tab state leak into the Git/metadata layer.

Slices: renderer primary; core and desktop-shell secondary.

## Solution

Decision, itemized.

1. **Repo tabs are a renderer-only UI concept.** A new `WorkspacesStore` (Angular signals) holds an ordered list of open tabs `{repoId, fsPath, name}`, an `activeTabId`, and per-tab view state. The opened-repo records themselves already live in the core `repos` table via `RepoService` Open / List / Remove — Workspaces adds **no new core entity**.
2. **Tab UI-state persists as renderer UI-state only.** Which repos are open, their order and the active tab persist through the existing UI-state mechanism — **never** as Git data and **never** as core domain state. SQLite remains a metadata/UI-state cache, never Git objects (anti-goal #2).
3. **Multi-repo fetch is renderer-orchestrated fan-out.** The renderer iterates the open tabs and issues N concurrent per-repo `Fetch` streaming calls over the existing IPC, each with its own progress stream. **No new core RPC is introduced for fetch-all** — the core stays a per-repo executor and never learns about "workspaces".
4. **Switching tabs routes to existing per-repo IPC calls**; no core round-trip is added for tab switching.

### Rejected alternative

A persisted core-side **Workspace** aggregate — adds an entity with no Git truth and couples the core to a UI-only concept. Rejected.

## Consequences

- The core keeps one mental model — a repo — however many tabs the renderer shows.
- Tab state is cheap to change: it is renderer UI-state, not a domain contract.
- Fetch-all is a loop, not a batch RPC; per-repo progress and per-repo failure stay independent.
- Anti-goal check: the renderer still never talks to Git; everything crosses IPC → shell → core.

## When to use

- When adding repo-tab / simultaneous multi-repo UI.
- When refreshing or fetching several open repos at once.

## When not to use

- Not to introduce a core "Workspace" entity or RPC: workspaces are renderer UI.
- Not to persist tab state as Git data or core domain state.
- Not to implement fetch-all as a new batched core RPC: fan out per repo.

## Examples

```ts
// WorkspacesStore (signals, renderer only)
type RepoTab = { repoId: string; fsPath: string; name: string };

// multi-repo fetch: N concurrent per-repo calls over the existing IPC
await Promise.all(tabs().map(t => ipc.invoke('fetch', { repo_id: t.repoId })));
```

## Common mistakes

- **Adding a core Workspace entity** for what is only renderer tab state.
- **A batched fetch-all RPC** that teaches the core about workspaces.
- **Persisting tab order as Git or domain data** instead of UI-state.
- **A core round-trip to switch tabs** when the repo's RPCs already exist.

## References

- Feature-gap analysis: [[feature-gap-analysis]]
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- Core slice: [core-slice](../slices/core-slice.md)
- Desktop shell slice: [desktop-shell-slice](../slices/desktop-shell-slice.md)
- ADR hub: [[adr-index]]
