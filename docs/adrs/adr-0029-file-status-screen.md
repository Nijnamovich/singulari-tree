---
id: adr-0029-file-status-screen
category: adrs
tags: [adr, renderer, status, diff, graph, m3]
aliases: [ADR-029, File Status screen]
related: [adr-index, renderer-slice, adr-0022-graph-context-menu-shell, adr-0020-diff-per-file-and-hunk-staging, adr-0018-renderer-i18n-locale-switch, feature-gap-analysis]
version: 1.0
status: active
---

# ADR-029: File Status screen

## Problem

The renderer can inspect the working tree only through the bottom panel of the repo page: one file list plus one diff, always in the same place. That is enough for a quick glance but not for the three questions a Git client is asked all day — "what does this commit change?", "what would my pull request contain?", "what is dirty right now, side by side?" — and it keeps the diff pane glued to the working tree. GitKraken answers with a dedicated *File Status* screen (worktree, commit, pull-request variants); Azure DevOps answers with the PR *Files* tab. SingulariTree needs the same screen, and it needs a decision on where the data comes from and how the diff is rendered.

## Solution

Decision, itemized.

1. **Renderer-only screen.** The File Status screen lives entirely in the Angular renderer and adds **no new proto RPC, no new IPC channel and no Go-core change**. This follows the precedent of [[adr-0022-graph-context-menu-shell]], which chose "Compare reuses GetDiff; no new RPC". The verification:
   - `GetDiffRequest{repo_id, from, to, path, staged}` plus `Diff`/`FileDiff` already express all three variants — working tree (`from = ''`), commit vs. first parent (or the empty tree for a root commit), and base ref vs. target ref.
   - the core already resolves the root-commit empty tree for an empty `from` (`apps/go-core/internal/adapter/git/diff.go:77-84`) and validates `from`/`to` as oids (`diff.go:56-70`), so an unborn or root history is not a client-side special case.
   - `BranchList` already returns the tip oids the PR variant needs and filters symbolic `refs/remotes/origin/HEAD` (`apps/go-core/internal/adapter/git/adapter.go:415-428`).
2. **One screen, three variants, one layout.** LEFT = variant bar + file list; RIGHT = the selected file's diff. The diff is always on the right — the GitKraken convention of putting the diff on the left of the list is explicitly not adopted. Variants: **local** (working tree), **commit** (a graph commit), **pull request** (a local ref against a base).
3. **`FileStatusStore` composes `StatusStore` instead of extending it.** `StatusStore` stays the single owner of the ADR-0020 addressing model (per-file sections, hunk/line indices, worktree and staged substrates) and of `getStatus`/`commit`. The new store adds only what it owns — the variant, the commit/PR diffs, the branch list and the base/target refs — and delegates every staging mutation to `StatusStore`. The existing working-tree panel (`StatusWorkspace`, `ChangesPanel`) is reused untouched, so it cannot regress.
4. **The right pane is a pure projection.** `toSingleFileDiff(diff, path)` lifts the selected file into a synthetic single-file `Diff` and feeds it to the **unchanged** `DiffViewer`, which reads only the deprecated flat `hunks` field (plus `isBinary`/`hasConflictMarkers`). The whole diff is never passed to the viewer, and the ui-kit is not touched.
5. **The PR variant is a local ref-vs-base diff.** The base defaults to `main`, falling back to `master` and then to remote-tracking refs, then to the current branch, the first local branch and finally the first remote-tracking branch. The base is an **editable** control (any ref name can be typed), not a closed dropdown, so a base outside the loaded branch list is still reachable. Live GitHub / Azure DevOps pull-request integration and OAuth are **deferred**: [[feature-gap-analysis]] lists PR integration as P3 and ties it to multi-host accounts and OAuth, so this screen ships the files-overview of a PR, not its conversation.
6. **Navigation.** The screen is a child of the repo route (`/repo/file-status`), provided by its own `FileStatusStore` on the child route so the store can inject the route-scoped `StatusStore` from the parent injector and dies with the screen. The sidebar WORKSPACE entry and the graph context-menu "File status" entry both route there; the context-menu entry selects the menu commit in the shared `GraphStore` first, and the screen reads that selection to pick the commit variant. It is never enabled for the synthetic WIP row.

### Consequences

- No contract, core or IPC change: the whole screen is reviewable as renderer code and needs no `buf generate`.
- One `StatusStore` per repo route, shared by both screens, keeps the working-tree semantics identical wherever the user lands.
- The diff viewer stays a dumb, reusable component: a new consumer only has to project a single file into a `Diff`.
- The PR variant gives a real "what will this PR contain" answer with zero provider credentials; the provider round-trip stays a separate, later decision.
- 3-way conflict editing remains out of scope ([[adr-028-advanced-git-rpcs]]): conflicts are surfaced (`hasConflictMarkers`, `GetStatus.is_conflicted`), never resolved here.

### Exit criterion

- Done when: `/repo/file-status` renders the three variants; the local variant reuses the unchanged working-tree panel; the commit variant reuses the commit details panel plus the changed-file list; the PR variant diffs an editable base against a target; the right pane shows only the selected file's hunks; the graph context menu routes to the screen for a real commit only; and no RPC, IPC channel or Go-core file changed.

## When to use

- When a screen needs to show a commit, a pull request or the working tree as a list of files plus one diff.
- When wiring a graph action that leads to another screen: emit, select in the shared store, then route.
- When a new consumer needs `DiffViewer`: project a single file into a `Diff` first.

## When not to use

- Not to add an RPC for anything this screen shows — `GetDiff`, `GetBranches`, `GetStatus`, `Stage`/`Unstage` and the hunk mutations already cover it.
- Not to hand the whole diff to the viewer or to `DiffViewer`'s siblings; the projection is the boundary.
- Not to implement pull-request conversation, approvals or OAuth here — that is the P3 multi-host account work.
- Not to build a 3-way conflict editor on top of this screen.

## Examples

```text
/repo/file-status  (sidebar WORKSPACE -> "File status")
  local   -> StatusStore: getStatus + worktree/staged diffs, stage/unstage/discard by index
  commit  -> getDiff(from = parents[0] | "", to = oid)   -> FileDiff[] -> one projected Diff
  pr      -> getBranches -> base (default main) -> target -> getDiff(from, to)

graph row right-click -> "File status" -> GraphStore.select(oid) -> navigate /repo/file-status
right pane            -> toSingleFileDiff(wholeDiff, selectedPath) -> unchanged DiffViewer
```

## Common mistakes

- **Adding a pull-request RPC** for the PR variant instead of diffing base → target with the existing `GetDiff`.
- **Passing the whole diff** to the right pane, which renders every file's hunks concatenated instead of the selected file.
- **Extending `StatusStore`** for the new variant state instead of composing it, which forks the ADR-0020 addressing model in two places.
- **Routing to `/repo/file-status` without selecting the commit**, so the screen silently falls back to the working tree.
- **Enabling the context-menu entry for the WIP row**, which has no commit to diff.
- **Putting the diff on the left** of the file list — a deliberate regression for users of this screen.

## References

- Graph context-menu shell (the menu entry it extends): [[adr-0022-graph-context-menu-shell]]
- Per-file diff and hunk/line staging (the addressing model reused): [[adr-0020-diff-per-file-and-hunk-staging]]
- Renderer i18n (every string marked, Spanish parity): [[adr-0018-renderer-i18n-locale-switch]]
- Advanced Git RPCs (conflict surfacing, no 3-way editor): [[adr-028-advanced-git-rpcs]]
- Feature-gap analysis (PR integration is P3): [[feature-gap-analysis]]
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- ADR hub: [[adr-index]]
