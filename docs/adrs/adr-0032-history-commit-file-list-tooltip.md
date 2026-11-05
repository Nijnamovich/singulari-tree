---
id: adr-0032-history-commit-file-list-tooltip
category: adrs
tags: [adr, renderer, graph, status, diff]
aliases: [ADR-032, History commit file-list tooltip]
related: [adr-index, adr-0030-history-screen-is-compare-free, adr-0031-repository-relocation-and-missing-folder-recovery, adr-0029-file-status-screen, adr-0022-graph-context-menu-shell, feature-gap-analysis, renderer-slice]
version: 1.0
status: superseded
supersedes: adr-0030-history-screen-is-compare-free
---

# ADR-032: History aside shows the selected commit's changed files (narrow repeal of ADR-0030's compare-free lock)

> **Superseded in part by [[adr-0033-commit-details-files-expandable-panel]] (2026-10-16):** the changed-file list's *surface* is now an inline expandable panel inside the commit-details panel body, not the `st-popover` tooltip this ADR chose (its solution item 2). The data source (`StatusStore` + `getDiff`), the read-only contract and the compare-free boundaries recorded here are unchanged; ADR-0032 remains the record of the file-list decision and of the narrow repeal of ADR-0030. Its decision text below is left verbatim (ADRs are append-only).

## Problem

[[adr-0030-history-screen-is-compare-free]] made the History screen a read-only commit overview and, with it, forbade one concrete thing: *"Not to re-add any diff, file list or change stats to the History aside — it is a commit overview by contract."* (`adr-0030-history-screen-is-compare-free.md:60`). [[adr-0031-repository-relocation-and-missing-folder-recovery]] restated the lock as its refusal item 7b: the operator had asked for a tooltip listing a commit's changed files next to the aside's "Review changes" button, and it was refused (`adr-0031-repository-relocation-and-missing-folder-recovery.md:36`).

The operator has re-decided. The **compare-free contract stays**: nothing below the graph, no inline compare modal, compare still routes to `/repo/file-status`, no diff rendered in History. The single "no file list" lock is lifted **narrowly**, for one surface only — a changed-file list tooltip beside the "Review changes" CTA. This is not a return to a second comparison surface; it is one read-only summary of *which files* the selected commit touches, with no hunks.

## Solution

Decision, itemized. This ADR **supersedes [[adr-0030-history-screen-is-compare-free]]** and the supersession is **narrow**: it lifts only the "no file list" lock on the History aside, for the tooltip, and repeals only the item 7b refusal in [[adr-0031-repository-relocation-and-missing-folder-recovery]] (which is otherwise untouched and stays `active`). Every other clause of ADR-0030 stands as written.

1. **Narrow supersession, plainly stated.** ADR-0030 changes state from `active` to `superseded`; its decision text is not edited (ADRs are append-only). The compare-free contract it pinned is **unchanged**: no 260px status band below the graph, no selection-coupled diff in the graph route, no inline compare modal / `GraphStore.compare*` state, "Compare with selected" still a navigation shortcut to `/repo/file-status`, and no diff rendered in History. This ADR re-admits exactly one thing ADR-0030 forbade: a changed-file **list** in the aside, surfaced as a tooltip. ADR-0031 is **not** superseded — only its Refusals bullet 2 (item 7b) is repealed.

2. **The aside is still the read-only `commit-details-panel`.** `apps/angular/src/app/features/repo/graph/ui/commit-details-panel.ts` keeps its contract — oid, ref chips, message, author, committer, date, parents/refs. The changed-file list is **not** inlined into the panel body; it is hidden behind a small disclosure affordance next to the primary "Review changes" CTA (the `showCta` primary button shipped in P3). That affordance opens a `st-popover` (the ui-kit popover primitive that `graph-context-menu` already moved onto in P3) listing the selected commit's changed file paths. The panel is still read-only: the tooltip is a summary, not an action surface. The consumer projects the list as its own named `role="dialog"` region inside the popover's panel (the primitive exposes no naming hook and stays unchanged — a deliberate tradeoff, not an oversight); a `menu`/`menuitem` role is deliberately NOT used, because the rows are not actions.

3. **Data source is the existing commit-diff read — no new RPC, IPC or Go change.** The file list is the same first-parent / root-commit diff ADR-0022 and ADR-0029 already use: `StatusStore` (`apps/angular/src/app/features/repo/status/status.store.ts`) through the existing `getDiff` RPC (`GetDiffRequest{repo_id, from, to}`), the removed-`from` (empty tree) form the core already resolves for a root commit. There is **no new proto RPC, no new IPC channel and no Go-core change** — the same precedent as ADR-0029 and ADR-0030. The renderer reads only the resulting `FileDiff[]` paths; it never talks to Git (anti-goal #1).

4. **The synthetic WIP row shows no file list.** The WIP row has no commit to diff, so the tooltip's affordance is absent/disabled for it — the same exclusion ADR-0029 records ("Enabling the context-menu entry for the WIP row, which has no commit to diff", `adr-0029-file-status-screen.md:74`) and ADR-0030 restates (item 6, `adr-0030-history-screen-is-compare-free.md:35`). Inherited verbatim.

5. **The root commit works.** A root commit (no parent) lists its files by diffing against the empty tree, exactly as the File status `commit` variant already does (`adr-0029-file-status-screen.md:22`, `adr-0030-history-screen-is-compare-free.md:29`). This is not a client-side special case: the core resolves the empty tree for an empty `from`.

6. **The tooltip is a read-only summary — not a second comparison surface.** It lists paths (name/status), no hunks, no side-by-side, no staging controls. The diff itself still lives **only** in `/repo/file-status`. This is *not* a re-admission of the deleted `st-status-workspace` band or of the inline compare modal; it is a file-name summary, and nothing below the graph returns.

7. **Renderer-only; the ui-kit stays dumb.** The change is confined to `apps/angular/**` (the History aside and the store read). The ui-kit `st-diff-viewer` is **not involved** — it is not moved, split or made state-aware, and it keeps reading one projected single-file `Diff` for File status. The `st-popover` primitive is consumed unchanged as a dumb building block. Necomat `frontend/` and `backend/` are untouched.

### Refusals

- **Not a status band.** ADR-0030's deleted 260px `.st-repo-page__status` band stays deleted; nothing re-renders below the graph.
- **Not an inline compare modal.** The `st-modal` + `st-diff-viewer` compare surface and `GraphStore.compare*` state stay removed; compare remains a navigation action to `/repo/file-status`.
- **Not a diff in History.** The tooltip lists paths only — no hunks, no side-by-side, no staging. The sole comparator is still `/repo/file-status`.
- **Not for WIP.** The synthetic WIP row still gets no file list (no commit to diff).
- **No new RPC, IPC channel or Go-core change** — the file list reuses `StatusStore` + `getDiff`, per the ADR-0029/ADR-0030 precedent.

### Consequences

- The History aside gains a file list — the one thing ADR-0030 forbade — bounded to the tooltip surface; the compare-free contract around it is otherwise intact.
- `StatusStore` gains a History-side consumer of the commit-diff read **again**. ADR-0030's consequence "`StatusWorkspace` and `StatusStore.loadCommitDiff` lose their graph-selection consumers" (`adr-0030-history-screen-is-compare-free.md:45`) is now **partially reverted**: the store keeps its capability, and the graph aside consumes the same `getDiff` read the File status screen uses. Stated honestly — this is a re-admission, not an accident.
- The renderer gains a `st-popover` consumer and no new Git surface; File status remains the single diff surface, so the earlier "two screens would overlap" concern is not revived (one shows a path list, the other shows the diff).
- [[feature-gap-analysis]] and [[renderer-redesign-plan]] get a truthfulness update recording the repeal of the 7b refusal (both docs previously recorded it as refused/pending).
- [[adr-0031-repository-relocation-and-missing-folder-recovery]] stays `active`; its recovery decision is unaffected — only its item 7b refusal is repealed.

### Exit criterion

- Done when: the History aside's "Review changes" CTA has an adjacent affordance opening a `st-popover` that lists the selected commit's changed files (paths, no hunks), sourced from `StatusStore` + the existing `getDiff` RPC; the root commit lists files (empty-tree diff); the synthetic WIP row shows no file list; no diff, side-by-side or staging renders in History; "Compare with selected" still selects then routes to `/repo/file-status`; the 260px status band and the inline compare modal remain absent; and no RPC, IPC channel or Go-core file changed.

## When to use

- When the History aside must show *which files* a selected commit touches without becoming a comparison surface.
- When reusing the existing commit-diff read (`StatusStore` + `getDiff`) for a read-only summary instead of adding an RPC.
- When a graph action needs to disclose detail: emit intent, read through the store, render a dumb primitive.

## When not to use

- Not to render hunks, a diff or staging controls in the History aside — the tooltip is a path list, nothing more.
- Not to bring back the bottom status band or the inline compare modal while adding the tooltip.
- Not to add an RPC, IPC channel or Go-core change for the file list — `getDiff` already covers it.
- Not to enable the file-list affordance for the synthetic WIP row.
- Not to make `st-diff-viewer` (or `st-popover`) state-aware; both stay dumb, reusable primitives.

## Examples

```text
/repo                  (History — read-only commit overview, still compare-free)
  graph + selected-commit aside (commit-details-panel)
    "Review changes" CTA  ->  adjacent affordance  ->  st-popover
        lists the selected commit's changed file paths
        (StatusStore + getDiff(from = parents[0] | "", to = oid) -> FileDiff[] paths)
    no hunks, no diff, no staging  ->  the diff stays in /repo/file-status

WIP row                ->  no file list (no commit to diff)
root commit            ->  getDiff(from = "", to = oid) -> files (empty-tree diff)
```

## Common mistakes

- **Rendering hunks or a diff in the tooltip** — that would re-create a second comparison surface, which this ADR explicitly does not do.
- **Adding a file-list RPC or IPC channel** instead of reusing `StatusStore` + `getDiff`.
- **Reinstating the status band or the compare modal** while adding the tooltip — the compare-free contract still stands.
- **Enabling the file-list affordance for the WIP row**, which has no commit to diff.
- **Inlining the file list into `commit-details-panel`'s body** instead of surfacing it as a tooltip next to the CTA.
- **Treating this as a full reversal of ADR-0030** — it is a narrow repeal of the "no file list" lock and of ADR-0031's item 7b refusal; every other clause stands.

## References

- History is compare-free (the ADR this narrowly supersedes): [[adr-0030-history-screen-is-compare-free]]
- Repository relocation and missing-folder recovery (its item 7b refusal is repealed): [[adr-0031-repository-relocation-and-missing-folder-recovery]]
- File Status screen (the sole diff surface, and the root-commit/empty-tree precedent): [[adr-0029-file-status-screen]]
- Graph context-menu shell (the Compare action this leaves as a navigation): [[adr-0022-graph-context-menu-shell]]
- Feature-gap analysis (truthfulness update for the 7b repeal): [[feature-gap-analysis]]
- Renderer redesign plan (truthfulness update for the 7b repeal): [[renderer-redesign-plan]]
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- ADR hub: [[adr-index]]
