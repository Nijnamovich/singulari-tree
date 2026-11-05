---
id: adr-0021-reset-modes
category: adrs
tags: [adr, core, reset, m2, destructive]
aliases: [ADR-0021, Reset modes]
related: [adr-index, adr-0020-diff-per-file-and-hunk-staging, core-slice, feature-gap-analysis]
version: 1.0
status: active
---

# ADR-0021: Reset (soft / mixed / hard)

## Problem

M2 adds reset actions to the graph. `git reset` has three modes with very different blast radius — soft moves `HEAD` only, mixed also resets the index, hard additionally discards working-tree changes — and no RPC exposes them. Without a recorded contract, each mode risks being wired ad hoc and a destructive `--hard` could run without an explicit guard.

## Solution

Decision, itemized.

1. New RPC **`Reset(ResetRequest) returns (ResetResponse)`**:
   - `ResetRequest { string repo_id = 1; string to = 2; Mode mode = 3; }` — `to` is an oid hex or a ref (resolved to an oid in core).
   - `enum Mode { MODE_UNSPECIFIED = 0; SOFT = 1; MIXED = 2; HARD = 3; }`.
2. Maps directly to `git reset --<soft|mixed|hard> <to>`. `MODE_UNSPECIFIED` is rejected; callers must name a mode.
3. **Destructive guard:** `--hard` requires explicit renderer confirmation before the call. The core executes what it is told — no silent confirmation and no implicit downgrade in core.
4. New error code **`RESET_FAILED`**, appended to `errors.proto` (`enum ErrorCode`, next number `26`) and to `domain/errors.go`. This ADR records the intended contract; the implementation is M2 core.
5. Semantics are exactly git's: `SOFT` = move `HEAD` only; `MIXED` (git's default) = `HEAD` + index; `HARD` = `HEAD` + index + working tree.
6. No `--merge` / `--keep` modes in this decision. Adding a fourth mode requires a successor ADR.

### Consequences

- The destructive surface is explicit: one RPC, one named mode, and a renderer-side confirmation gate for `HARD`.
- Reset reuses the existing watcher invalidation path: a successful reset emits a change event, so the graph/status refresh through the normal flow.
- `RESET_FAILED` joins the uniform `AppError` envelope; the current last code is `STASH_FAILED = 25`, so `26` is the next free number.

### Exit criterion

- M2 done when: `Reset` maps to `git reset --<mode> <to>`; `MODE_UNSPECIFIED` is rejected; `RESET_FAILED` exists in `errors.proto` and `domain/errors.go`; the renderer confirms before `HARD`; a successful reset triggers cache invalidation.

## When to use

- When wiring a reset action between the graph and the core.
- When a user chooses soft/mixed/hard: pass the named mode, never a bare default.

## When not to use

- Not to add `--merge` / `--keep` without a successor ADR.
- Not to confirm `--hard` inside core: confirmation is a renderer concern; core stays headless.
- Not to route reset through the renderer or shell: Git stays in core.

## Examples

```proto
message ResetRequest {
  string repo_id = 1;
  string to = 2;            // oid hex or ref
  ResetMode mode = 3;
}
enum ResetMode {
  RESET_MODE_UNSPECIFIED = 0;
  SOFT = 1;
  MIXED = 2;
  HARD = 3;
}
message ResetResponse {}
```

```text
Reset{repo_id, to: "HEAD~1", mode: SOFT}  ->  git reset --soft HEAD~1
Reset{repo_id, to: "<oid>",  mode: HARD}  ->  renderer confirms -> git reset --hard <oid>
```

## Common mistakes

- **Defaulting an unspecified mode** to `MIXED`: the caller must name the mode.
- **Skipping the confirmation** for `HARD`: it silently discards the working tree.
- **Adding a mode without an ADR**: the mode set is a contracted decision.
- **Reusing an existing error code** instead of appending `RESET_FAILED = 26`.

## References

- Core slice: [core-slice](../slices/core-slice.md)
- Per-file diff and hunk staging (same M2 wave): [[adr-0020-diff-per-file-and-hunk-staging]]
- Continuation context: [[feature-gap-analysis]]
- ADR hub: [[adr-index]]
