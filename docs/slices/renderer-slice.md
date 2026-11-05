---
id: renderer-slice
category: slices
tags:
- slice
- generality
aliases:
- Renderer slice
related:
- slices-index
version: 1.8.3
status: active
---

# Renderer — Slice Generalities

## What this slice is

Angular 22 SPA (zoneless, standalone, signals) with vertical features and stores, plus the shared UI kit. It is the visible face of SingulariTree.

## Boundaries

- **IN:** `apps/angular/**`, `libs/ui-kit/**`.
- **OUT:** Electron, Go core and contracts (it only consumes them).

## Entry points

- `apps/angular/src/app/app.ts` — root component.
- `apps/angular/src/app/app.routes.ts` — top-level routes.
- `apps/angular/src/app/features/` — vertical features.
- `apps/angular/src/app/core/services/` — `ipc-bridge.service.ts`, `repo-state.service.ts`.
- `libs/ui-kit/src/` — shared components.

## How it works

- Each feature is vertical (UI + store + mappers).
- `IpcBridgeService` talks to the preload exposed by the shell.
- `RepoStateService` exposes state with signals.
- The mappers translate towards the `@contracts` types.

## Conventions of this slice

- Standalone + zoneless + signals.
- Tests with vitest.
- The UI kit contains "dumb" components.

## Dependencies

- **Upstream:** preload bridge and contracts.
- **Downstream:** none.

## Known gaps & accepted debt

- M1 landed: repos list, virtualized graph + filter + commit details + WIP row, sidebar branches/tags/remotes, `StatusStore` + changes/commit panel, a lazy-loaded Monaco `DiffViewer`, and settings (theme, en/es).
- M2 landed: graph right-click context-menu shell (Checkout / Compare / Copy SHA, plus Reset) — [[adr-0022-graph-context-menu-shell]] — hunk/line staging & discard UI (Commit Composer), and the commit change-size gauge from `GetCommitStats`.
- M3 landed: branch/merge/tag/stash UI plus the graph context-menu "Create branch here" / "Tag this commit" and a merge-conflict banner; multi-repo Workspaces / repo tabs (renderer-only UI-state) — the M3 fetch fan-out of [[adr-024-multi-repo-workspaces]] item 3 is superseded by the per-tab model landed on 2026-10-19 (see below): the top-bar **Sync** fetches only the active tab and every other tab is fetched lazily when it becomes active, single-flight per repository and guarded by a per-repository generation token — [[adr-0036-per-tab-fetch]]; the cross-repo search view (sidebar WORKSPACE `search`; **retired by [[adr-0034-retire-cross-repo-commit-search]]**); a git-flow panel; and deep-link routing plus clipboard clone / copy-repo-URL (clone prefill only, V1.4) — [[adr-024-multi-repo-workspaces]], [[adr-025-deep-links-and-clipboard-clone]], [[adr-026-cross-repo-commit-search]], [[adr-027-git-flow-presets]], [[adr-028-advanced-git-rpcs]].
- File status screen landed (renderer-only, [[adr-0029-file-status-screen]]): `/repo/file-status` with local / commit / PR variants, a `FileStatusStore` composing `StatusStore`, the diff always on the right, and the graph context-menu "File status" entry selecting the commit then routing there. This post-M3 work is not part of the M-numbering above and is recorded here on landing.
- History screen is compare-free, landed (renderer-only, [[adr-0030-history-screen-is-compare-free]]): the History screen is now a read-only commit overview — `RepoPage` no longer mounts `st-status-workspace` below the graph (the fixed 260px `.st-repo-page__status` band and `status-workspace.ts` are gone), the selection-coupled first-parent diff went with the panel, and the selected-commit aside renders only `commit-details-panel` (general characteristics, no file list / diff / stats). The inline compare modal is removed: `GraphStore`'s `compare` / `compareDiff` / `compareLoading` / `compareError` state plus `compareCommits` / `clearCompare` are deleted, and "Compare with selected" is a navigation shortcut that reuses the "File status" hand-off (`GraphStore.select(oid)` then route to `/repo/file-status`), staying disabled for the synthetic WIP row. Three mechanisms that lived only in the deleted band were re-homed: the `git:watch` kickoff into `GraphStore.openRepository` (`startWatch`, `graph.store.ts`), the graph half of `RepoState.statusRefreshRequested` into `RepoPage` and its working-tree half into `FileStatusPage` (`refreshForExternalChange()`), and `fs:changed → graph.reload()` into `RepoPage`; `StatusStore.loadCommitDiff` is kept as a store capability with no graph-selection consumer — **narrowly updated by [[adr-0032-history-commit-file-list-tooltip]]:** the History aside now shows a changed-file list tooltip next to "Review changes" (`st-popover`, sourced from `StatusStore` + the existing `getDiff`), so the store's commit-diff read once again has a graph-selection consumer while the diff itself stays in File status. No new RPC, IPC channel or Go-core change. This post-M3 work is not part of the M-numbering above and is recorded here on landing.
- Commit-details surface + shared view mode + per-tab fetch landed (renderer/ui-kit, 2026-10-19): `st-commit-details-panel` is now three regions — a header (identity | centred CTA | the exclusive `description | files` switch | the action group), the **only** scrolling content region (the subject `h1` always, plus the body in `description` mode or the changed-file block with its filter and both empty states in `files` mode) and a metadata footer that starts collapsed and is a **sibling** of the content region (so the file list can no longer paint over it; `commit-details-footer-toggle` + `aria-expanded`, metadata absent from the DOM while collapsed). The mode is the new route-scoped `CommitViewModeService` (`repo.routes.ts`, next to `GraphStore`/`StatusStore`), shared by History and the Commit analyzer and reset to `description` on a repository change; the panel keeps no mode state (`[mode]` in, `(modeChange)` out). The analyzer's panel now owns **both** regions (the description region and the paths-only files block) as the whole commit view of its left column — the column no longer scrolls, the panel's content region is the only scroller and the metadata footer closes the column — with selectable file rows so the right pane's single-file diff stays reachable; the page no longer keeps the summary + `st-file-diff-list` in that variant, and a message-less commit is forced to `files` by the panel's `effectiveMode` alone (the page-level `effectiveAnalyzerMode` is gone). The padlock gained a delayed `role="tooltip"` explanation (`position: fixed`, wrapping, `aria-describedby`), which needed one additive ui-kit input: `ariaDescribedby` on `st-button` — the same input now also backs the two contextual nav controls' delayed tooltips ("collapse panel" on History's **Close**, "follow commit" on the analyzer's **History**). The top bar's **Sync** now fetches only the active tab and other tabs fetch lazily on activation, with single-flight, session freshness and a per-repository generation token plus `invalidateFetch` on close/remove — [[adr-0035-commit-details-redesign-and-inline-hunk-actions]] (2026-10-19 and 2026-10-20 refinements) and [[adr-0036-per-tab-fetch]]. Renderer-only: no new RPC, IPC channel, proto or Go-core change.
- Performance with large repos remains under watch.
- Dev-server constraint — Monaco vs. npm-workspace hoisting (2026-10-20): `@angular/build:dev-server` hard-codes Vite's `server.fs.allow` to the Vite cache dir, `<angular-workspace>/node_modules` and the build asset roots, and this repo's Angular workspace root is `apps/angular` while npm workspaces hoist `monaco-editor` to the repo-root `node_modules`, so Vite's dependency optimizer emits absolute CSS imports (`…/node_modules/monaco-editor/esm/…/anchorSelect.css`) that the dev server rejects with HTTP 403 (`The request id … is outside of Vite serving allow list`). The builder exposes no `fs.allow` option and ignores `vite.config.ts` (`configFile: false`), so the `serve` target in `apps/angular/angular.json` sets `prebundle: { "exclude": ["monaco-editor"] }`: esbuild bundles Monaco into the application code exactly as the production build already does and Vite never serves the hoisted files. The entry is **`serve`-only** — the `build` target and `npm run build --workspace=@singularitree/angular` are untouched (the production build is unaffected; build time and budgets unchanged) — and it removes the HTTP 403 / console error only: it did **not** by itself deliver Monaco's *static* CSS — that gap was closed separately by the lazy `monaco.css` link appended before `createDiffEditor` (see [[accepted-debt]]; this dev-server entry only stops the 403). Dev-only cost: a cold `ng serve` now traverses Monaco's ESM graph inside the application build (the cold dev build completes in ~5 s) instead of reading Vite's cached dependency prebundle. Removing that entry (unless `monaco-editor` is installed inside `apps/angular/node_modules`) brings the error back; `apps/angular/src/dev-server-config.spec.ts` guards the invariant. Dev-server configuration workaround, not an architectural decision — no ADR.
