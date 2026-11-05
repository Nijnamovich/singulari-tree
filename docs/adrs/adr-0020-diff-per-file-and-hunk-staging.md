---
id: adr-0020-diff-per-file-and-hunk-staging
category: adrs
tags: [adr, contracts, diff, staging, m2]
aliases: [ADR-0020, Per-file diff and hunk staging]
related: [adr-index, accepted-debt, core-slice, feature-gap-analysis, adr-0016-lane-state-and-graph-dod, adr-0021-reset-modes, adr-0023-commit-change-size-gauge]
version: 1.0
status: active
---

# ADR-0020: Per-file diff contract + hunk/line staging and discard

## Problem

M2's gate is working-tree safety: stage/unstage/discard at hunk and line granularity. Today the `Diff` contract carries a single flat `repeated Hunk hunks` with no file model — a multi-file diff is flattened into one hunk list in git order — and `GetDiffRequest` has only `{repo_id, from, to}`, with no per-file selector. Nothing can address one file, one hunk or one line, so hunk/line staging, per-file reset and the commit change-size gauge (ADR-023) have no addressing substrate. Hand-editing `libs/contracts/gen/**` is forbidden, and a breaking change to `Diff` would fail the buf breaking check and break the current Monaco viewer and e2e.

## Solution

Decision, itemized.

### (a) Additive `Diff` contract evolution (non-breaking)

1. Add a **`FileDiff`** message to `domain.proto`:
   - `string path = 1;`
   - `string old_path = 2;` — optional; set only for renames/copies, empty otherwise.
   - `string status = 3;` — porcelain v2 code (`M`, `A`, `D`, `R`, `C`, `T`, `U`, …).
   - `repeated Hunk hunks = 4;`
   - `int32 additions = 5;`
   - `int32 deletions = 6;`
   - `bool is_binary = 7;`
   - `bool has_conflict_markers = 8;`
2. Add **`repeated FileDiff files = 8;`** to `message Diff`.
3. **Keep** the existing `repeated Hunk hunks = 3;` on `Diff`, populated flattened (every file's hunks concatenated in git order) and marked in a comment as **deprecated in favor of `files`** for back-compat with the current Monaco viewer and the e2e suite. Neither field is removed.
4. Add **`string path = 4;`** (per-file selector) and **`bool staged = 5;`** (diff HEAD→index instead of HEAD→worktree) to `GetDiffRequest`.
5. Add **`bool truncated = 9;`** to `Diff` (bounded payload, see (c)).
6. Never hand-edit `libs/contracts/gen/**`: regenerate via `./tools/scripts/gen-contracts.sh`. Because every change appends a new field number, `buf breaking` stays green.

### (b) Addressing model — core re-derives; the renderer never builds patches

7. Hunk/line RPCs carry `{repo_id, path, hunk_index, repeated uint32 line_indices?}`. The **core re-derives the diff and selects the hunk/lines (SSOT in core)**; the renderer sends indices only.
8. **Rejected alternative:** the renderer sends patch bytes to apply. Fragile (path quoting, context drift), duplicates diff logic in the renderer, and violates core-SSOT.
9. New RPCs:
   - `StageHunk` (worktree→index),
   - `UnstageHunk` (index→HEAD),
   - `DiscardHunk` (worktree),
   - a file-level `Discard`.
   Implemented in core with `git diff` + `git apply --cached` / `git apply -R` against a core-constructed patch, always with `--literal-pathspecs` for pathspec safety.
10. **Untracked-file behaviour:** `git diff` shows no untracked files, so untracked files can only be staged/discarded **wholesale (file-level)** — never by hunk. The file-level `Discard` accepts untracked paths and removes them.

### (c) Bounded `GetDiff` payload

11. The core caps the returned hunks/lines with a **named constant** (provisional: `MaxDiffHunks` / `MaxDiffLines`) and sets `Diff.truncated = true` when capped, instead of returning an unbounded payload. The numeric cap can be refined in code; the intent and the field are the decision.

### Consequences

- The current Monaco viewer and e2e keep working unchanged: the flat `hunks` field is still populated.
- `files` is the substrate for hunk/line staging, file/hunk discard, reset and the change-size gauge (ADR-023).
- Core owns diff addressing; the renderer only sends indices — no patch is ever constructed outside core.
- The accepted-debt row `Diff has no per-file model (M1 baseline)` is removed (settled by this ADR).
- Cost: a `Diff` payload can grow with file count; the `truncated` cap bounds it.

### Exit criterion

- `buf breaking` is green after regeneration; `GetDiff` serves `files` (plus the deprecated `hunks`); `StageHunk` / `UnstageHunk` / `DiscardHunk` / `Discard` operate against a core-derived patch with `--literal-pathspecs`; a capped diff returns `truncated=true`; the `Diff has no per-file model` accepted-debt row is gone.

## When to use

- When adding any per-file, per-hunk or per-line operation: address it by indices and let the core re-derive.
- When evolving `Diff` or `GetDiffRequest`: append field numbers only.
- When rendering a diff: group by `files`; read the flat `hunks` only for the legacy viewer during the transition.

## When not to use

- Not to send patch text from the renderer: the renderer addresses, the core patches.
- Not to remove the flat `hunks` field or the `files`/`truncated` fields by renumbering — append-only.
- Not to hand-edit `libs/contracts/gen/**`.
- Not to expect hunk-level operations on untracked files: those are file-level only.

## Examples

Additive proto shape:

```proto
message FileDiff {
  string path = 1;
  string old_path = 2;               // optional (renames/copies)
  string status = 3;                 // porcelain v2 code
  repeated Hunk hunks = 4;
  int32 additions = 5;
  int32 deletions = 6;
  bool is_binary = 7;
  bool has_conflict_markers = 8;
}

message Diff {
  Oid from = 1;
  Oid to = 2;
  repeated Hunk hunks = 3;           // DEPRECATED in favor of `files`; flattened, back-compat
  int32 additions = 4;
  int32 deletions = 5;
  bool is_binary = 6;
  bool has_conflict_markers = 7;
  repeated FileDiff files = 8;
  bool truncated = 9;                // true when the payload was capped
}

message GetDiffRequest {
  string repo_id = 1;
  string from = 2;
  string to = 3;
  string path = 4;                   // per-file selector
  bool staged = 5;                   // HEAD->index instead of HEAD->worktree
}
```

Addressing a hunk (core re-derives and applies):

```text
StageHunk{repo_id, path: "src/a.ts", hunk_index: 2}
  core: git diff -U3 -- <path>  ->  select hunk 2  ->  git apply --cached --literal-pathspecs
```

## Common mistakes

- **Renumbering or removing** the existing `hunks = 3` field: breaks the wire contract and the buf breaking check.
- **Building patch text in the renderer**: reintroduces fragile patch construction and violates core-SSOT.
- **Addressing an untracked file by hunk**: `git diff` never shows it; use the file-level operations.
- **Returning an unbounded diff**: must cap and set `truncated=true`.
- **Forgetting the regen**: editing the proto by hand instead of running `./tools/scripts/gen-contracts.sh`.

## References

- Accepted-debt cleanup: [[accepted-debt]]
- Core slice (git adapter): [core-slice](../slices/core-slice.md)
- Reset modes (same M2 mutation wave): [[adr-0021-reset-modes]]
- Change-size gauge (consumes per-file counts): [[adr-0023-commit-change-size-gauge]]
- Continuation context: [[feature-gap-analysis]]
- ADR hub: [[adr-index]]
