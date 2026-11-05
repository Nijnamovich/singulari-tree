---
id: adr-0042-cherry-pick-and-branch-lens
category: adrs
tags: [adr, contracts, core, renderer, cherry-pick, revert, graph, lens]
aliases: [ADR-0042, Cherry-pick and branch lens]
related: [adr-index, adr-0022-graph-context-menu-shell, adr-028-advanced-git-rpcs, adr-0016-lane-state-and-graph-dod, adr-0040-per-repo-session-graph-selection-lock, contracts-slice, core-slice, renderer-slice, feature-gap-analysis]
version: 1.0
status: active
---

# ADR-042: One commit is applied onto the current branch, and a branch click becomes a view-only lens instead of a checkout

## Problem

The graph's context menu had no **cherry-pick** and no **revert**. That was deliberate: [[adr-0022-graph-context-menu-shell]] item 3 excluded both, and [[adr-028-advanced-git-rpcs]] closed with "cherry-pick, revert and interactive rebase remain out of M3 scope". The exclusion was correct while the operations did not exist — the shell renders nothing that cannot execute — but it left two everyday Git moves unreachable from the UI.

The second gap is a read-path gap, not a write-path one: **inspecting another branch's history forced a checkout.** Looking at what `feature/x` contains meant moving HEAD, which mutates the working tree, the index and the branch pointer just to *look*. A graph that cannot show a branch without becoming that branch is a graph that charges a mutation for a read.

Both gaps are the same missing capability stated twice: **apply one commit from elsewhere onto the current branch**, and **view a branch's commits without switching to it**. They landed together because they share the trigger surface (the rail and the commit row) and the same menu.

## Solution

Decision, itemized. Everything below is shipped; nothing here is a stub.

1. **Two-step flow: lens, then pick.**
   - A nav-rail branch click is a **lens**: `GetCommits` is narrowed to `HEAD ∪ <ref>`, the graph highlights that ref's own history, and **nothing is checked out**.
   - A commit click **inside the lens** opens the cherry-pick dialog prefilled with that commit's oid.
   - Double-click on a branch row still checks out, and **every checkout path clears the lens**, so the terminal state is always "checked out, no lens" — the two modes never stack.

2. **Contract additions are append-only.** No existing message or field changes meaning.

   | message | fields |
   |---|---|
   | `CherryPickRequest` | `repo_id` (1), `source` (2), `record_origin` (3), `no_commit` (4) |
   | `CherryPickResponse` | `has_conflict` (1), `oid` (2) |
   | `RevertRequest` | `repo_id` (1), `source` (2) |
   | `RevertResponse` | `has_conflict` (1), `oid` (2) |
   | `ResolveRevisionRequest` | `repo_id` (1), `revision` (2) — returns `.singularitree.v1.Commit` |
   | `GetCommitsRequest.refs` | `repeated string refs = 4` |
   | `GetCommitsResponse.in_refs` | `repeated bool in_refs = 4`, parallel to `commits` |

   `source` is **one bare revision string** — a sha, a short sha, a local branch, a remote-tracking ref, a tag or a rev expression — with **no kind discriminator on the wire**. That is the house convention of [[adr-028-advanced-git-rpcs]] item 5 (`Merge.ref`, `Reset.to`, `CreateTag.target` are all bare strings); a `RefKind` enum would have to grow for every ref syntax Git already parses. The renderer sends one revision and never builds a command or sends a flag.

3. **Resolve-then-mutate, with an ordered validation.** The order is load-bearing and identical for cherry-pick and revert (`resolveSequencerTarget`):
   1. trim the source; reject empty, a leading `-`, and any control character → `reason=invalid-source`;
   2. `git rev-parse --verify --quiet <source>^{commit}` → `COMMIT_NOT_FOUND` when it fails;
   3. **only the resolved 40-hex oid ever reaches the mutating command** — never the raw user string, so a revision cannot smuggle an option or a range;
   4. reject merge commits (`rev-list --parents -n 1` reports more than one parent) → `reason=merge-commit` (there is no `-m` in v1);
   5. refuse a detached HEAD → `DETACHED_HEAD` (there is no branch to advance);
   6. refuse a busy sequencer — `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `MERGE_HEAD` or an on-disk `rebase-merge` / `rebase-apply` → `reason=in-progress`. Starting a pick on top of a half-finished one corrupts the state.

4. **Conflicts are data, not an editor.** `{has_conflict, oid}` on the response plus the `CHERRY_PICK_CONFLICT` / `REVERT_CONFLICT` trailer, tree left conflicted — byte-for-byte the `Merge` precedent. **An empty pick/revert runs `--skip` first** and only then reports `reason=empty`: git leaves the sequencer armed after "the previous cherry-pick is now empty", so reporting without clearing it makes the *next* operation fail with a confusing message. A dirty tree that would be overwritten maps to `reason=overwrite-local-changes` with the bounded raw text in `Details["raw"]`.

5. **Error codes are append-only.** Last used was `REPO_PATH_IN_USE = 34`.

   | code | number | gRPC status (`grpcCodeFor`) |
   |---|---|---|
   | `CHERRY_PICK_CONFLICT` | 35 | `FailedPrecondition` |
   | `CHERRY_PICK_FAILED` | 36 | `Aborted` |
   | `REVERT_CONFLICT` | 37 | `FailedPrecondition` |
   | `REVERT_FAILED` | 38 | `Aborted` |

   CONFLICT → `FailedPrecondition` and FAILED → `Aborted` keeps the merge mapping: a conflict is a precondition the user can satisfy, a failure is a refused operation.

6. **Preview RPC, so the dialog shows what it will apply.** `ResolveRevision` is read-only and resolves a revision to a full `Commit`, which lets the dialog render sha / subject / author / date **before** anything mutates. The primary action stays disabled while the revision is unresolved, so "apply" is never a leap of faith. An unusable string is `INVALID_OID`; a plausible revision that does not resolve is `COMMIT_NOT_FOUND`.

7. **Lens mechanics.**
   - `GetCommits` with empty `refs` is **bit-identical** to the previous HEAD-only behaviour: same window, same total, same cache reads and writes.
   - Non-empty refs walks the union `HEAD ∪ refs`, keeps `--topo-order` / `--skip` / `--max-count`, and counts via `rev-list --count HEAD <refs...>` (HEAD is named again so the union is explicit).
   - A lensed window **bypasses the commit-window cache on both sides**: the L1 key is `(repo, offset)` with no ref dimension, and the L2 reader is commit-date-ordered rather than topological — serving or storing a lensed window would poison both.
   - Lane fold state is keyed by `(repoId, canonical refSetKey)`, not by repository alone; `Invalidate` sweeps **every key** for the repository. Keying by repository would let a lensed fold overwrite the HEAD fold and make columns shift when the lens is toggled.
   - Toggling always reloads from offset 0.

8. **Dialog ownership: one dumb component, one mount point.** A single `st-cherry-pick-dialog` is mounted once in `layout.html` beside `st-merge-dialog`. The open-state and the mutation live on the root `RepoState`, because the trigger exists in **two component trees** — the rail lives in the layout, commit rows live in the routed page — and `GraphStore` is only provided under the repo route. The dialog reuses `st-modal`, so focus trap, Escape and backdrop are already handled.

9. **Dialog contents.**
   - One **source** field (mono text input accepting a revision) plus a `Pick…` affordance backed by a grouped select of **local branches / remote branches / tags**, excluding the current branch (which is the *target*).
   - A resolved-commit **preview card**, debounced ~250 ms with last-request-wins, so a slow earlier resolution can never overwrite a newer revision.
   - A read-only `Current branch: <name>` line.
   - Two checkboxes, both off by default: `Append source commit reference (-x)` and `Do not commit (leave staged)` — the latter mirrors `MergeRequest.no_commit`.
   - **No confirmation step.** A pick *adds* a commit; it does not rewrite history. The preview *is* the confirmation, and a second modal on top of a dialog would be ceremony.
   - Inline error rows for not-found / detached / conflict / empty, switched on the `reason` token.

10. **Conflict UX.** On conflict the dialog stays open with a warn row, then the global banner takes over: `st-merge-conflict-banner` gained an `operation: 'merge' | 'cherry-pick' | 'revert'` input instead of a second near-identical banner, and `RepoState`'s merge-only conflict signal became a small conflict state carrying the kind (with a merge-only computed kept for the merge dialog, which predates it).

11. **Lens visual: never colour alone, never confusable with the current branch.** The current-branch row keeps `.st-selection-bar`; a lens is a different state and reads as one:
    - rows outside the lens dim (~0.55 opacity);
    - rows inside get a wash plus a 1px ref-coloured inset marker;
    - a **lens bar** states the scope in text with a `Clear` action, as `role="status"`;
    - `aria-pressed` on the rail row.

12. **Menu tiers.** While a lens is active the row menu is **exactly three** entries: `Cherry-pick onto <current>`, `Copy SHA`, `File status`. None of the ref mutations may run against a ref that was never checked out. The current-branch tier keeps its working entries (Checkout, Compare, File status, Copy SHA, Create branch here, Tag, Reset S/M/H) **and gains Revert**.

13. **Single vs double click.** Single click sets/clears the lens; double click checks out; the checkout path clears the lens; **no click timer** — a timer to disambiguate single from double click buys nothing here, because the two gestures have different, non-conflicting outcomes. Clicking the current branch row clears the lens. Keyboard Enter/Space on a rail row now **toggles the lens** (checkout remains on the row menu and on double click) — an intentional behaviour change, recorded as such.

14. **Supersession by reference, append-only.** The older ADRs are **not edited**.
    - [[adr-0022-graph-context-menu-shell]] **item 3** (which excluded cherry-pick and revert) is superseded.
    - [[adr-028-advanced-git-rpcs]] **Consequences** ("cherry-pick, revert and interactive rebase remain out of M3 scope") is superseded for cherry-pick and revert; interactive rebase stays out.
    - [[adr-0016-lane-state-and-graph-dod]] **item 3** ("a commit's column depends only on the history from HEAD") is superseded **inside a lens only**: the lens folds and keys its own layout, and the un-lensed HEAD layout is unchanged.

15. **`Rebase children` is deferred as a separate future project.** It is not rendered and not stubbed — ADR-0022's no-dead-actions rule still governs the menu. Re-entry condition: an interactive-rebase / `Rebase` RPC exists that reports **typed conflict data**, *and* the graph can enumerate a commit's children. Until both hold, it is out.

16. **Scope shipped now**, one branch, one PR: (1) `CherryPick` RPC + dialog, (2) branch lens + highlight + tiered menu, (3) `Revert` RPC + entry. Nothing else rode along.

### Consequences

- **The renderer still never touches Git.** It sends one revision, two booleans and a ref list; the core resolves, validates and constructs every command. No `git` string appears in the renderer, and no flag crosses the wire.
- **The lens costs one extra walk per activation.** Membership is one `rev-list` per lens ref set, cached per `(repoId, canonical refSetKey)` so scrolling does not re-walk it — but a lensed window **gives up the commit-window cache while it is active**, which is the accepted trade for topological correctness.
- **Conflicts are surfaced, not resolved.** There is no in-app resolver and none is implied: the tree is left conflicted and the banner says so. That is the ADR-028 position, extended to two more operations.
- **The menu is narrower while lensing.** A lensed commit cannot be checked out, reset or tagged from the menu; checkout stays on the rail and on double-click, and the mutations that need a checked-out branch simply are not offered. This is the point of the tiering: *nothing rendered that cannot execute.*
- **Cherry-pick and revert refuse merge commits in v1** (no `-m` parent selection), and refuse to run on a detached HEAD or over a busy sequencer. Each refusal is a typed `reason` token with a sentence in the dialog, not a silent no-op.
- **Verification evidence, measured on this branch:** `go vet ./...` is clean in `apps/go-core` and the core suite is green (adapter/git 164 test-level passes, service 89 and grpc 77; 6 pre-existing Windows symlink skips; `-race` is unavailable on this host because no C compiler is installed). Electron `tsc --noEmit` is clean with 149 tests passing on a 46-channel IPC surface. Angular runs 87 test files / 1413 tests passing plus a successful production build. EN and ES catalogues are at 256 / 256 ids with no diff on re-extraction. `node tools/docs/validate.js` is green, and `dist/go-core.exe` was rebuilt so the `prestart` freshness guard passes.

### Exit criterion

- Done when: the three RPCs (`CherryPick`, `Revert`, `ResolveRevision`) and the `refs` / `in_refs` fields exist in `gitcore.proto` with regenerated Go/TS stubs; the ordered validation, conflict-as-data, the empty-pick `--skip` and the cache bypass are unit-tested; the shell exposes the three channels; the renderer ships the lens (store, highlight, bar, rail clicks) and the tiered menu (three entries while lensing), the cherry-pick dialog with preview / `-x` / `--no-commit`, and the Revert entry; the EN and ES catalogues stay at parity; and the docs validator is green.

## When to use

- When applying a single commit from another branch, tag or sha onto the current branch without merging: `CherryPick` with one bare revision.
- When undoing a single commit on the current branch: `Revert`, same source contract, no dialog.
- When inspecting another branch's history: lens it (`GetCommits.refs`), never check it out just to look.
- When adding a graph action: ask which tier it belongs to — lensed (read-only) or current-branch (mutating) — and whether the RPC exists yet.
- When adding an operation that can conflict: copy this shape — `has_conflict` + typed CONFLICT error, tree left conflicted, one shared banner with an `operation` discriminator.

## When not to use

- Not to render `Rebase children` or any other deferred action: no dead entries.
- Not to add `-m` / merge-commit support "for completeness" without its own decision — v1 refuses merge commits on purpose.
- Not to send a command, a flag or a ref *kind* from the renderer; one revision string is the whole wire contract.
- Not to serve a lensed window from the commit cache, and not to key lane state by repository alone.
- Not to add a second conflict banner: extend `operation`.
- Not to check out on a single click, and not to hide the lens state behind colour alone.
- Not to edit ADR-0022, ADR-028 or ADR-0016 — supersede by reference.

## Examples

```text
click(branch row)        -> lens (no checkout)          GetCommits{refs: ["feature/x"]}
click(commit in lens)    -> cherry-pick dialog          prefilled with that commit's oid
type / Pick…             -> ResolveRevision{revision}   -> preview card (sha, subject, author, date)
submit                   -> CherryPick{source: <oid>, record_origin, no_commit}
                         -> ok            : dialog closes, graph reloads
                         -> has_conflict  : dialog stays open + banner ("cherry-pick")
double-click(branch)     -> checkout flow               -> lens cleared
```

```proto
message CherryPickRequest {
  string repo_id = 1;
  string source = 2;          // ONE bare revision: sha, branch, ref, tag, rev expression
  bool record_origin = 3;     // -x
  bool no_commit = 4;         // --no-commit
}
message CherryPickResponse {
  bool has_conflict = 1;
  string oid = 2;
}
message RevertRequest {
  string repo_id = 1;
  string source = 2;
}
message RevertResponse {
  bool has_conflict = 1;
  string oid = 2;
}

message GetCommitsRequest {
  string repo_id = 1;
  uint32 offset = 2;
  uint32 limit = 3;
  repeated string refs = 4;      // empty = HEAD walk, bit-identical to before
}
message GetCommitsResponse {
  repeated Commit commits = 1;
  uint32 total = 2;
  repeated Lane lanes = 3;       // parallel to `commits`
  repeated bool in_refs = 4;     // parallel to `commits`; empty when refs is empty
}
```

## Common mistakes

- **Rendering `Rebase children` as a dead entry.** It is deferred as its own project, with a written re-entry condition — not a disabled button.
- **Sending a command or a flag from the renderer** instead of one revision. The wire contract is a revision string; the core owns the argv.
- **Passing the raw user string to `cherry-pick`** instead of the resolved oid. That is how `--continue` or a range smuggles itself into a mutation.
- **Adding `-m` support "for merge commits"** without a decision: choosing a parent changes the pick's meaning and needs its own record.
- **Leaving the sequencer armed after an empty pick.** Run `--skip` *first*, then report `reason=empty`; otherwise the next operation fails confusingly.
- **Serving a lensed window from the commit cache.** The key has no ref dimension and the reader is date-ordered.
- **Keying lane state by repository alone.** Columns shift the moment a lens is toggled; key by `(repoId, canonical refSetKey)` and sweep every key on `Invalidate`.
- **Checking out on a single click.** Single click is a read; double click is the mutation; every checkout clears the lens.
- **Adding a second conflict banner** for cherry-pick and revert instead of extending `operation` on the one banner.
- **Hiding the lens state behind colour alone.** Dim the outside, mark the inside, and say the scope in the lens bar's text.

## References

- Graph context-menu shell; its item 3 is superseded here: [[adr-0022-graph-context-menu-shell]]
- Advanced-git RPCs and the bare-string convention (item 5); its cherry-pick/revert exclusion is superseded here: [[adr-028-advanced-git-rpcs]]
- Lane state from HEAD (item 3 superseded inside a lens only): [[adr-0016-lane-state-and-graph-dod]]
- Per-repo session graph state, the neighbour decision for renderer-held graph state: [[adr-0040-per-repo-session-graph-selection-lock]]
- Contracts slice (the append-only proto surface): [[contracts-slice]]
- Core slice (sequencer, service, lane fold): [[core-slice]]
- Renderer slice (lens store, dialog, tiered menu): [[renderer-slice]]
- Where these two gaps were recorded: [[feature-gap-analysis]]
- ADR hub: [[adr-index]]
- Proto surface: [gitcore.proto](../../libs/contracts/proto/gitcore.proto)
- Ordered validation and conflict classification: [sequencer.go](../../apps/go-core/internal/adapter/git/sequencer.go)
- Lens ref sets, cache bypass and lane keys: [graph_service.go](../../apps/go-core/internal/service/graph_service.go)
- Lens state (renderer-only, never crosses IPC): [branch-lens.store.ts](../../apps/angular/src/app/core/services/branch-lens.store.ts)
- Dialog (dumb form; `RepoState` owns preview and mutation): [cherry-pick-dialog.ts](../../apps/angular/src/app/shared/ui/ref-dialogs/cherry-pick-dialog.ts)
