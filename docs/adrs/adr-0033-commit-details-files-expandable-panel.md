---
id: adr-0033-commit-details-files-expandable-panel
category: adrs
tags: [adr, renderer, graph, status, diff]
aliases: [ADR-033, Commit-details changed-files expandable panel]
related: [adr-index, adr-0032-history-commit-file-list-tooltip, adr-0030-history-screen-is-compare-free, adr-0031-repository-relocation-and-missing-folder-recovery, adr-0029-file-status-screen, feature-gap-analysis, renderer-slice]
version: 1.0
status: active
supersedes: adr-0032-history-commit-file-list-tooltip
---

# ADR-033: The commit-details changed-file list is an inline expandable panel (supersedes ADR-032's popover surface)

## Problem

[[adr-0032-history-commit-file-list-tooltip]] re-admitted one thing [[adr-0030-history-screen-is-compare-free]] had forbidden — a changed-file list in the History aside — and pinned its *surface*: a `st-popover` tooltip disclosed from a small affordance beside the "Review changes" CTA (`apps/angular/src/app/features/repo/graph/ui/commit-details-panel.ts`). That surface choice has proven wrong for this content, and only it is being replaced.

A popover is a **transient, dismissible** overlay. It suits a short menu, not a list the operator must read: a commit that touches dozens of files cannot be scanned while the surface vanishes on the first outside click or focus move, and the very gestures that make a popover feel light (click-away, `Escape`, focus-out) fight a long scrollable list. The list also sat *beside* the panel rather than *in* it, so it competed with the CTA for the same anchor and could not persist while the operator read the commit's subject and metadata above it.

An **inline expandable panel** — a collapsed/expanded disclosure rendered inside the commit-details panel body, scrolling within its own capped region — fixes exactly this. The list is persistent while expanded, keyboard-reachable through a real disclosure toggle with a stable expanded state, and scrollable in place, while the commitment to a read-only, compare-free History aside is unchanged.

## Solution

Decision, itemized. This ADR **supersedes [[adr-0032-history-commit-file-list-tooltip]] in part**: only the *surface* clause — its solution item 2, the `st-popover` tooltip — is replaced by an inline expandable panel. ADR-0032's data source, read-only contract and compare-free boundaries stay in force as written.

1. **Narrow supersession, plainly stated.** ADR-0032 changes state from `active` to `superseded`; its decision text is not edited (ADRs are append-only). This ADR does **not** touch ADR-0032's own narrow repeal of [[adr-0030-history-screen-is-compare-free]]: ADR-0032 still lifted ADR-0030's "no file list" lock and still repealed [[adr-0031-repository-relocation-and-missing-folder-recovery]] item 7b. ADR-0030 stays `superseded` by ADR-0032 and is **not** re-superseded; ADR-0031 stays `active`. Exactly one thing changes: the changed-file list is surfaced as an inline expandable panel instead of a popover tooltip.

2. **The surface is an inline expandable panel inside the commit-details panel body.** The affordance is a disclosure toggle carrying a persistent collapsed/expanded state. When expanded, the panel renders the selected commit's changed paths inline, in its own region of the panel body, and that region scrolls within a capped height (`max-height` + `overflow: auto`) so a large commit cannot push the panel's metadata out of reach. The list stays mounted while expanded and collapses on the same toggle — no transient overlay, no outside-click or focus-out dismissal.

3. **The aside is still the read-only `commit-details-panel`.** Its contract is unchanged — oid, ref chips, message, author, committer, date, parents/refs. The listing is a read-only summary and the disclosure adds no action surface: it is a disclosure, not a menu, so the rows are not given `menu`/`menuitem` roles.

4. **Data source is the existing commit-diff read — no new RPC, IPC or Go change.** The list is the same first-parent / root-commit diff ADR-0032 already used: `StatusStore` (`apps/angular/src/app/features/repo/status/status.store.ts`) through the existing `getDiff` RPC (`GetDiffRequest{repo_id, from, to}`), the removed-`from` (empty tree) form the core already resolves for a root commit. There is **no new proto RPC, no new IPC channel and no Go-core change**, and the renderer reads only the resulting `FileDiff[]` paths; it never talks to Git (anti-goal #1).

5. **The synthetic WIP row shows no file list.** The WIP row has no commit to diff, so the affordance is absent for it — the same exclusion ADR-0032 inherited from ADR-0029 and ADR-0030.

6. **The root commit works.** A root commit (no parent) lists its files by diffing against the empty tree, exactly as the File status `commit` variant already does; this is not a client-side special case, because the core resolves the empty tree for an empty `from`.

7. **The listing is paths only — not a second comparison surface.** It lists paths, no hunks, no side-by-side, no staging controls. The diff itself still lives **only** in `/repo/file-status`.

8. **Renderer-only; the ui-kit stays dumb.** The change is confined to `apps/angular/**`. The `st-popover` primitive is simply no longer consumed in the History aside; it stays an unchanged, dumb building block with its other consumers (`graph-context-menu`, the repo drawer). `st-diff-viewer` is not involved, moved, split or made state-aware, and Necomat `frontend/` and `backend/` are untouched.

9. **The compare-free boundaries are untouched.** No 260px status band below the graph, no inline compare modal / `GraphStore.compare*` state, no diff rendered in History; "Compare with selected" is still a navigation shortcut to `/repo/file-status`, disabled for the synthetic WIP row.

### Refusals

- **Not a reopening of the compare-free lock.** No status band below the graph, no inline compare modal, no diff rendered in History — ADR-0030's contract outside the narrow file-list clause stands.
- **Not an RPC/IPC/Go-core change.** The listing reuses `StatusStore` + `getDiff`, per the ADR-0029/ADR-0030/ADR-0032 precedent.
- **Not a list for WIP.** The synthetic WIP row keeps no affordance: it has no commit to diff.
- **Not a stateful ui-kit.** `st-popover` and `st-diff-viewer` stay dumb, reusable primitives; neither becomes aware of the History aside.

### Consequences

- The changed-file list is persistent, keyboard-reachable and scrollable — the operator can read a multi-file commit without the surface dismissing underneath them.
- ADR-0032 stays `superseded` **in effect**: its `supersedes: adr-0030-history-screen-is-compare-free` chain is unaffected, so ADR-0030's narrow repeal by ADR-0032 still holds and ADR-0030 is not re-superseded. This is a surface swap, stated honestly, not a reversal of the file-list decision.
- The renderer drops its `st-popover` consumer in the History aside; the primitive keeps its other consumers and is unchanged. The History aside is no longer the place where `st-popover` is exercised.
- The History aside's body gains an inline disclosure region; the aside stays read-only and the compare-free contract around it is intact.
- [[feature-gap-analysis]] and [[renderer-redesign-plan]] get a truthfulness update recording the surface change.

### Exit criterion

- Done when: the affordance opens an **inline expandable** region listing the selected commit's changed paths (no hunks) inside the commit-details panel body, scrolling within its own capped region; the disclosure state is toggleable and persists while expanded; the synthetic WIP row and the empty branch render no affordance; the File-status embed (the panel reused as a header, without the History CTA) renders no affordance; no RPC, IPC channel or Go-core file changed; and the compare-free contract holds (no status band, no inline compare modal, no diff in History, "Compare with selected" still routes to `/repo/file-status`).

## When to use

- When the History aside must show *which files* a selected commit touches without becoming a comparison surface.
- When the content is a list the operator must read, so a transient popover would be the wrong surface.
- When reusing the existing commit-diff read (`StatusStore` + `getDiff`) instead of adding an RPC.

## When not to use

- Not to render hunks, a diff or staging controls in the History aside — the listing is a path list, nothing more.
- Not to bring back the bottom status band or the inline compare modal.
- Not to add an RPC, IPC channel or Go-core change for the listing — `getDiff` already covers it.
- Not to enable the affordance for the synthetic WIP row or the File-status embed.
- Not to make `st-diff-viewer` (or `st-popover`) state-aware; both stay dumb, reusable primitives.

## Examples

```text
/repo                  (History — read-only commit overview, still compare-free)
  graph + selected-commit aside (commit-details-panel)
    "Review changes" CTA + disclosure affordance
      collapsed  -> expanded: inline region lists the changed paths
        (StatusStore + getDiff(from = parents[0] | "", to = oid) -> FileDiff[] paths)
        scrolls inside its own capped region; stays open until collapsed
    no hunks, no diff, no staging  ->  the diff stays in /repo/file-status

WIP row            ->  no affordance (no commit to diff)
root commit        ->  getDiff(from = "", to = oid) -> files (empty-tree diff)
File-status embed  ->  no affordance (the panel is the header there)
```

## Common mistakes

- **Keeping the `st-popover` tooltip** beside the CTA while claiming the new decision — the surface is now an inline expandable panel.
- **Rendering hunks or a diff in the panel** — that would re-create a second comparison surface, which this ADR explicitly does not do.
- **Adding a file-list RPC or IPC channel** instead of reusing `StatusStore` + `getDiff`.
- **Reinstating the status band or the compare modal** while changing the surface — the compare-free contract still stands.
- **Enabling the affordance for the WIP row or the File-status embed**, neither of which may grow a History-only control.
- **Treating this as a full reversal of ADR-0032** — only its popover surface is superseded; its data source and boundaries stand.

## References

- The tooltip ADR this supersedes in part: [[adr-0032-history-commit-file-list-tooltip]]
- History is compare-free (the outer contract, unchanged): [[adr-0030-history-screen-is-compare-free]]
- Repository relocation and missing-folder recovery (its item 7b repeal stands): [[adr-0031-repository-relocation-and-missing-folder-recovery]]
- File Status screen (the sole diff surface, and the root-commit/empty-tree precedent): [[adr-0029-file-status-screen]]
- Feature-gap analysis (truthfulness update for the surface change): [[feature-gap-analysis]]
- Renderer redesign plan (truthfulness update for the surface change): [[renderer-redesign-plan]]
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- ADR hub: [[adr-index]]
