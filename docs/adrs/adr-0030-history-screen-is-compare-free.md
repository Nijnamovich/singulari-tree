---
id: adr-0030-history-screen-is-compare-free
category: adrs
tags: [adr, renderer, graph, status, diff, compare]
aliases: [ADR-0030, History screen is compare-free]
related: [adr-index, renderer-slice, adr-0022-graph-context-menu-shell, adr-0029-file-status-screen, feature-gap-analysis]
version: 1.0
status: superseded
---

# ADR-0030: History screen is compare-free — comparison lives in File status

## Problem

The repo page stacks two surfaces on one route: `RepoPage` mounts `st-status-workspace` beneath the graph (`apps/angular/src/app/features/repo/page/repo-page.ts:30-32`), pinned to a fixed 260px band (`repo-page.ts:74-79`). That bottom panel is a full working-tree workspace (file list + diff + commit box), and it is coupled to the graph selection: selecting a commit makes it load a parent→commit diff (`apps/angular/src/app/features/repo/status/status-workspace.ts:132-143` → `apps/angular/src/app/features/repo/status/status.store.ts:291-298` `loadCommitDiff`, rendered by `<st-diff-viewer>` at `status-workspace.ts:51-56`). Separately, the graph's context menu opens an inline compare modal (`apps/angular/src/app/features/repo/graph/page/graph-page.ts:162-186`, `st-modal` + `st-diff-viewer`) driven by `GraphStore.compareCommits` / `clearCompare` (`apps/angular/src/app/features/repo/graph/graph.store.ts:283-314`) and reachable from the "Compare with selected" menu entry (`apps/angular/src/app/features/repo/graph/ui/graph-context-menu.ts:69-78` → `onCompare()` at `graph-page.ts:403-409`).

Since [[adr-0029-file-status-screen]] the renderer already has a dedicated File status screen (`/repo/file-status`) with local / commit / PR variants: it inspects the working tree and diffs a commit against its first parent (the `commit` variant renders `st-diff-viewer` at `apps/angular/src/app/features/repo/file-status/page/file-status-page.ts:108-115`, sourced from `openCommit()` → `loadOwnDiff(parents[0], oid)` at `apps/angular/src/app/features/repo/file-status/file-status.store.ts:139-143`). Two screens would therefore overlap. The History screen must decide what it is: a commit overview, or a second file-comparison surface. The human pinned the requirement: **History becomes a read-only commit-overview screen; file comparison belongs exclusively to the File status screen.**

## Solution

Decision, itemized.

1. **Nothing renders below the History section.** `RepoPage` stops mounting `st-status-workspace` beneath the graph (`repo-page.ts:30-32`) and drops the fixed 260px `.st-repo-page__status` band (`repo-page.ts:74-79`). The graph plus the selected-commit aside take the freed height. Working-tree, staging and file-status inspection live only in `/repo/file-status`.

2. **The selection-coupled first-parent diff goes away with the panel.** Today, selecting a commit drives the bottom workspace to load a parent→commit diff (`status-workspace.ts:132-143` → `status.store.ts:291-298`). That coupling is removed together with the panel; `StatusWorkspace` / `StatusStore` remain owned by `/repo/file-status` (the local variant, ADR-0029 item 3), not by the graph screen.

3. **The selected commit shows general characteristics only.** The History aside is the existing read-only commit details panel: oid, ref chips, message, author, committer, date, parents and refs (`apps/angular/src/app/features/repo/graph/ui/commit-details-panel.ts:13-61`). This is already its behavior; this ADR pins it as the History screen's contract — no file list, no diff, no change stats. The commit change-size gauge ([[adr-0023-commit-change-size-gauge]]) is graph metadata, not file content, and is unaffected.

4. **Comparison redirects to File status.** The inline compare modal in History (`graph-page.ts:162-186`, `st-modal` + `st-diff-viewer`), its store state (`GraphStore.compareCommits` / `clearCompare` / `compare` / `compareDiff`, `graph.store.ts:283-314`) and its triggering handler (`onCompare()` at `graph-page.ts:403-409`) are removed. The context-menu entry "Compare with selected" is **kept but repurposed as a navigation action**: it reuses the hand-off already used by the "File status" entry (`onFileStatus()` at `graph-page.ts:419-424`) — `GraphStore.select(oid)` then `router.navigate(['/repo', 'file-status'])` — and File status is the sole home of the comparator. Its `commit` variant already diffs the commit against its first parent, or against the empty tree for a root (`file-status.store.ts:139-143`); the PR variant gives ref-vs-base comparison. This **refines the presentation of [[adr-0022-graph-context-menu-shell]]**: that ADR decided Compare reuses `GetDiff` with `from`/`to` set to the two commits (`adr-0022-graph-context-menu-shell.md:24`, exit criterion at `:38`), and this ADR reuses the same action unchanged at the RPC level — only its destination changes, from an in-graph view to the File status screen.

   **Precision note.** No document ever claimed an "inline" view or a "modal" for Compare: neither word appears in the docs about this action. ADR-0022 recorded the action and its `GetDiff` reuse as the decision; this ADR does not overturn a documented claim, it narrows the *presentation* the action was given. `GetDiff` with `from`/`to` remains the decision; the surface that shows it changes.

5. **Extends ADR-0029.** [[adr-0029-file-status-screen]] opened by describing the renderer inspecting the working tree "only through the bottom panel of the repo page" (`adr-0029-file-status-screen.md:15`). This ADR removes that bottom panel, so the File status screen is no longer an alternative to it — it is the single inspection surface. Everything ADR-0029 decided about the screen (renderer-only, `FileStatusStore` composes `StatusStore`, diff on the right, single-file projection into the dumb `DiffViewer`, navigation contract) stands unchanged; only its premise — inspection happened "only through the bottom panel" — becomes historical.

6. **Navigation contract and exclusions are inherited.** Routing to `/repo/file-status` requires selecting the commit in the shared `GraphStore` first, because the screen reads that selection to pick its variant — ADR-0029's exit criterion (`adr-0029-file-status-screen.md:41`) and its common mistake "Routing to `/repo/file-status` without selecting the commit" (`adr-0029-file-status-screen.md:73`). The synthetic WIP row must never route to a commit-variant compare: the entry stays disabled for WIP, as it already is (`graph-context-menu.ts:80-93`, matching ADR-0029's WIP common mistake at `adr-0029-file-status-screen.md:74`).

7. **Renderer-only.** This is a renderer-only change: **no new proto RPC, no new IPC channel and no Go-core change** — the same precedent as ADR-0029 and ADR-0022 (compare reuses the existing `GetDiff`). The ui-kit `st-diff-viewer` stays a dumb, reusable component that reads one projected single-file `Diff`; it is not moved, split or made state-aware. The renderer never talks to Git directly (anti-goal #1); Necomat `frontend/` and `backend/` are untouched.

### Consequences

- The History screen is a pure commit overview: graph + selected-commit characteristics, with no file content — its scope is unambiguous.
- Exactly one surface compares files (`/repo/file-status`), so file comparison cannot diverge between two screens.
- "Compare with selected" and "File status" become the same kind of action — select, then route; the menu's compare entry is a navigation shortcut, not a diff surface of its own.
- `StatusStore` gains a single owning route; the graph screen no longer instantiates the working-tree workspace.
- `StatusWorkspace` and `StatusStore.loadCommitDiff` lose their graph-selection consumers; removing the coupling is part of the work, not an accidental side effect.
- The graph gains the vertical space previously spent on a 260px status band.

### Exit criterion

- Done when: `RepoPage` no longer imports or mounts `st-status-workspace` (no `.st-repo-page__status` band, `repo-page.ts`); selecting a commit does not load a parent diff in the graph route; the History aside renders only the commit details panel (`commit-details-panel.ts` fields) with no file list, diff or stats; the inline compare modal and `GraphStore.compare*` state are gone from `graph-page.ts` / `graph.store.ts`; the "Compare with selected" entry selects the menu commit in `GraphStore` and navigates to `/repo/file-status` (no compare diff rendered in History), reusing the `onFileStatus()` hand-off; the entry is disabled for the WIP row; and no RPC, IPC channel or Go-core file changed.

## When to use

- When deciding whether a graph action should render a diff (no — it should route to File status).
- When wiring a graph action that leads to another screen: emit, select in the shared store, then route.
- When a reviewer asks where file comparison lives: only in `/repo/file-status`.

## When not to use

- Not to re-add any diff, file list or change stats to the History aside — it is a commit overview by contract.
- Not to keep the selection-coupled `loadCommitDiff` in the graph route's panel; the coupling goes with the panel.
- Not to add an RPC or IPC channel for compare — `GetDiff` already covers it.
- Not to enable the compare / File status entry for the synthetic WIP row.

## Examples

```text
/repo                  (History — read-only commit overview)
  graph + selected-commit aside (commit-details-panel: oid, refs, message, author, committer, date, parents)
  no working tree, no file list, no diff, no stats below the graph

graph row right-click -> "Compare with selected" -> GraphStore.select(oid) -> navigate /repo/file-status
graph row right-click -> "File status"          -> GraphStore.select(oid) -> navigate /repo/file-status
/repo/file-status      -> the sole comparator: local / commit / PR variants -> one projected Diff -> DiffViewer
```

## Common mistakes

- **Mounting `st-status-workspace` (or any diff) below the graph again**, re-creating a second comparison surface.
- **Keeping the compare modal in History** while also routing to File status — the inline surface is removed, not duplicated.
- **Routing to `/repo/file-status` without selecting the commit first**, so the screen silently falls back to the working tree (ADR-0029).
- **Enabling compare / File status for the WIP row**, which has no commit to diff.
- **Treating this as superseding ADR-0022's `GetDiff` decision** — it refines the presentation only; the RPC reuse stands (`adr-0022-graph-context-menu-shell.md:24`).
- **Adding a compare RPC or IPC channel**, or making `st-diff-viewer` state-aware, instead of reusing `GetDiff` and projecting one file.

## References

- Graph context-menu shell (the Compare action this refines): [[adr-0022-graph-context-menu-shell]]
- File Status screen (the destination and the single inspection surface): [[adr-0029-file-status-screen]]
- Per-file diff and hunk/line staging (the addressing model reused): [[adr-0020-diff-per-file-and-hunk-staging]]
- Commit change-size gauge (graph metadata, unaffected): [[adr-0023-commit-change-size-gauge]]
- Feature-gap analysis (this requirement is recorded there as pending): [[feature-gap-analysis]]
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- ADR hub: [[adr-index]]
