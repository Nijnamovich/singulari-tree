---
id: adr-028-advanced-git-rpcs
category: adrs
tags: [adr, contracts, core, branch, merge, tag, stash, m3]
aliases: [ADR-028, Advanced Git RPCs]
related: [adr-index, feature-gap-analysis, contracts-slice, core-slice, adr-0022-graph-context-menu-shell, adr-027-git-flow-presets]
version: 1.0
status: active
---

# ADR-028: V1.1 advanced-git RPCs — branch CRUD, merge, tag CRUD, stash apply/pop/drop

## Problem

Branch CRUD, merge, tag CRUD and stash apply/pop/drop are unimplemented. `GetStashes` / `GetWorktrees` are stubs and only `Checkout` and `StashPush` exist; branch CRUD, merge and tag CRUD have no RPC at all. git-flow ([[adr-027-git-flow-presets]]) consumes these operations, so they must exist first. Slice order: contracts → core → renderer.

## Solution

Decision, itemized. All additions are **append-only field numbers**.

1. **Branch:** `CreateBranch{repo_id, name, start_point, checkout}`, `RenameBranch{repo_id, old_name, new_name}`, `DeleteBranch{repo_id, name, force}`. Errors: `BRANCH_EXISTS`, `BRANCH_NOT_FOUND`.
2. **Merge:** `Merge{repo_id, ref, MergeStrategy strategy, no_commit, message}` where `MergeStrategy = {MERGE_STRATEGY_UNSPECIFIED, MERGE, NO_FF, FF_ONLY, SQUASH}` (`MERGE_STRATEGY_UNSPECIFIED` is rejected). The result reports `has_conflict`; conflict state is also visible via `GetStatus` (`is_conflicted`) and `Diff.has_conflict_markers`. Errors: `MERGE_CONFLICT`, `MERGE_FAILED`. **Full 3-way conflict editor is out of M3 scope** — M3 surfaces conflicts and leaves the tree in a resolvable conflict state (no terminal is required to *see* them).
3. **Tag:** `CreateTag{repo_id, name, target, annotated, message, force}`, `DeleteTag{repo_id, name}`. Error: `TAG_EXISTS`.
4. **Stash:** implement `GetStashes` (un-stub) and add `StashApply{repo_id, index, restore_index}`, `StashPop{repo_id, index}`, `StashDrop{repo_id, index}`.
5. **Addressing:** the renderer sends names/indices only; the core constructs and runs the git commands (`--literal-pathspecs` where pathspecs are involved). All Git contact stays in `apps/go-core/internal/adapter/git/`.
6. **Error codes are append-only.** `BRANCH_EXISTS = 6` and `BRANCH_NOT_FOUND = 5` already exist in `errors.proto`. The new codes (`MERGE_CONFLICT`, `MERGE_FAILED`, `TAG_EXISTS`, and optionally `TAG_NOT_FOUND`) are appended after the current last code (`DISCARD_FAILED = 27`), taking the next free numbers (28+).

## Consequences

- The M2 graph context-menu shell ([[adr-0022-graph-context-menu-shell]]) can now light up its create-branch-here / tag entries; cherry-pick, revert and interactive rebase remain out of M3 scope.
- git-flow ([[adr-027-git-flow-presets]]) has the operations it builds on.
- Conflicts are surfaced, not resolved in a 3-way editor, in M3.

## When to use

- When adding any branch, merge, tag or stash mutation.
- When appending to `ErrorCode`.

## When not to use

- Not to renumber or remove existing field numbers — append-only.
- Not to build Git command sequences in the renderer: address by name/index.
- Not to expect a full 3-way conflict editor in M3.

## Examples

```proto
enum MergeStrategy {
  MERGE_STRATEGY_UNSPECIFIED = 0;
  MERGE = 1;
  NO_FF = 2;
  FF_ONLY = 3;
  SQUASH = 4;
}
message CreateBranchRequest { string repo_id = 1; string name = 2; string start_point = 3; bool checkout = 4; }
message MergeRequest { string repo_id = 1; string ref = 2; MergeStrategy strategy = 3; bool no_commit = 4; string message = 5; }
```

```text
CreateBranch{name: "feature/login", start_point: "develop", checkout: true}
Merge{ref: "feature/login", strategy: MERGE} -> result.has_conflict
CreateTag{name: "v1.0", annotated: true} / DeleteTag{name: "v1.0"}
GetStashes / StashApply{index} / StashPop{index} / StashDrop{index}
```

## Common mistakes

- **Renumbering proto fields** instead of appending.
- **Running the merge in the renderer** instead of addressing it by ref.
- **Expecting a 3-way conflict editor** in M3 — only conflict surfacing is in scope.
- **Reusing an error code** instead of appending a new one.

## References

- git-flow presets (consumer): [[adr-027-git-flow-presets]]
- Graph context-menu shell (M2): [[adr-0022-graph-context-menu-shell]]
- Contracts slice: [contracts-slice](../slices/contracts-slice.md)
- Core slice: [core-slice](../slices/core-slice.md)
- Feature-gap analysis: [[feature-gap-analysis]]
- ADR hub: [[adr-index]]
