---
id: adr-0031-repository-relocation-and-missing-folder-recovery
category: adrs
tags: [adr, contracts, core, renderer, repositories, relocation, errors]
aliases: [ADR-031, Repository relocation and missing-folder recovery]
related: [adr-index, adr-0030-history-screen-is-compare-free, adr-0029-file-status-screen, adr-024-multi-repo-workspaces, renderer-slice, contracts-slice, core-slice, desktop-shell-slice]
version: 1.1
status: active
---

# ADR-031: Repository relocation and missing-folder recovery

> **Record clarification (2026-10-16):** solution item 2 lists the repointed columns as `fs_path` and `common_dir`. `RelocateRepository` also re-derives `repos.name` as the new path's basename, which is the exact derivation `RepoStore.Open` performs for a fresh registration (`domain.NewRepository`, `domain/repository.go:35`). No code path anywhere in the stack writes a user-supplied `repos.name` — the only two writers of the row are the `Open` INSERT and this UPDATE, and `gitcore.proto` exposes no repository-rename RPC — so the value is, and always was, a pure projection of `fs_path`. This completes the recorded same-row repoint contract rather than changing its decision; the text below is left verbatim (ADRs are append-only).

## Problem

A tracked repository is a row in the core `repos` table plus a folder on disk that the user is free to move, rename or delete at any time — outside the app. When that happens today the app fails in the least useful way possible:

1. The core collapses **every** open failure into one code. `RepoService.Open` only knows that `GitPort.Resolve` (`git rev-parse --show-toplevel`) failed, so a deleted folder, a renamed folder and a folder that was never a Git repository all return `NOT_A_GIT_REPO` (`apps/go-core/internal/adapter/git/adapter.go` maps the failure inside `Resolve`). The renderer cannot tell "your folder is gone" from "this is not a repository", so it cannot name the state or offer the right recovery.
2. The failure surfaces as a one-line error in the graph pane / repo picker — the operator's report was literally *"the program did not detect the error"*.
3. The only apparent repair is to remove the repository and add it again. `RepoStore.Open` upserts by `fs_path`, so re-adding a **different** path mints a **new repository id**: the cached commit/stats rows cascade away with the old row, the persisted workspace tab (ADR-024, keyed by `repoId`) is dropped by `WorkspacesStore.reconcile`, `created_at` is lost, and the user is left with a stale registration if they never complete the re-add. That is a silent deletion of the user's registration, which is exactly what the operator forbade.

The operator's requirement: detect that the folder is not found, **name the state**, offer to *edit the path* or *re-select the folder*, and never silently drop the registration — deletion only as an explicit, confirmed action.

## Solution

Decision, itemized.

1. **Two distinguishable error codes, not one.** `apps/go-core/internal/domain` gains `REPO_PATH_MISSING` ("the recorded fs path does not exist") and `REPO_PATH_IN_USE` ("that path is already tracked by another repository"). `RepoService.Open` stats the path **before** delegating to `GitPort.Resolve`, and maps only `fs.ErrNotExist` to `REPO_PATH_MISSING` — a permission error is an I/O failure, not a missing folder, and must not invite the user to relocate. A path that exists but is not a Git repository keeps returning `NOT_A_GIT_REPO`, unchanged. The codes are additive enum values in `errors.proto` (33/34) and map to `NotFound` / `FailedPrecondition` in `grpcCodeFor`; the wire already carries `AppError.code` as a string, so no existing consumer changes.
2. **A `RelocateRepository` RPC repoints the existing registration.** `RelocateRepository(repo_id, fs_path)` validates (unknown id → `REPO_NOT_FOUND`, missing target → `REPO_PATH_MISSING`, non-repo target → `NOT_A_GIT_REPO`, target already tracked by another id → `REPO_PATH_IN_USE`) and then updates the **same row**: the repository id and `created_at` are preserved, `fs_path` is normalized exactly like `Open` (`filepath.Abs(filepath.Clean(...))`) and `common_dir` is re-resolved through the Git port. The UNIQUE `fs_path` conflict is detected **before** the UPDATE so the caller receives the typed envelope rather than a raw sqlite constraint error. On success the gRPC handler invalidates the in-memory graph and cache state for that id, exactly like `RemoveRepository` — the path changed, so cached lane layouts and commit windows must not be served for it.
3. **The renderer never touches Git or the filesystem.** Detection is a pure read of state the renderer already has: `GraphStore.error()` (the failed `openRepository`) plus `RepoState.activeRepo()`. Re-selection reuses the shell's native folder picker over the existing `dialog:chooseDirectory` channel (the same flow `repos-page` uses); the renderer never stats, never reads and never writes a path. No new Git capability, no `fs` channel, no shell change beyond one IPC channel.
4. **The History pane owns the recovery surface.** `RepoPage` renders a new `st-repo-relocate-panel` **instead of** the repo picker while the active repository is unopenable — order matters, because a failed `openRepository` leaves `GraphStore.repoId()` null, which is precisely why the failure used to look like "nothing happened". The panel names the state (`REPO_PATH_MISSING` → "the folder could not be found"; `NOT_A_GIT_REPO` → "the folder is not a Git repository"), shows the recorded path in mono, and offers **Edit path** (inline input), **Choose folder…** (native picker → `RepoState.relocateRepository`), and **Remove repository** as a `danger` action gated by an explicit `confirm()`. Every failure — including `REPO_PATH_IN_USE` — is surfaced to the user; nothing is swallowed.
5. **The relocation re-points, so nothing downstream breaks.** Because the repository id survives, the persisted workspace tab, `RepoState.activeId`, the nav-rail selection and the drawer row all keep referring to the same repository; `RepoState.relocateRepository` upserts the record, re-activates it when it was the active one and refreshes the persisted list, and `RepoPage` then re-opens the repository through the normal `GraphStore.openRepository` path.

### Refusals

- **No silent deletion.** The repo row is only ever removed by the explicit, confirm-gated `Remove repository` action in the recovery panel. The relocation path never deletes.
- **Item 7b is refused.** The operator also asked for a tooltip listing the changed files next to the History aside's "Review changes" button. [[adr-0030-history-screen-is-compare-free]] pins that aside as a commit overview by contract — *"not to re-add any diff, file list or change stats to the History aside"*. This ADR does not override it; the allowed commit metadata (author, committer, date, refs) may still be improved, and the file list stays in File status.
- **No auto-relocation.** The core never guesses that a moved folder is "the same" repository by path similarity. Relocation is always explicit.

### Consequences

- One additive RPC touching the contracts, core, desktop-shell and renderer slices; no breaking change (`buf breaking` clean), no data migration, no schema change — the `repos` table already holds both columns.
- A moved folder is a recoverable state instead of a silent registration loss; the id (and therefore the cached rows and the workspace tab) survives the repair.
- `REPO_PATH_MISSING` vs `NOT_A_GIT_REPO` is now a contract distinction, so any future consumer (shell, search, deep link) can name the state without re-deriving it.
- The renderer gains one more read-only derived state (`relocateRepo`/`relocateReason`) and no new Git surface.
- Domain-concept errors live in their concept's file: `ErrRepoPathMissing` / `ErrRepoPathInUse` sit in `domain/repository.go` beside `ErrRepoNotFound` / `ErrNotAGitRepo`, while `domain/errors.go` keeps the code constants and its ADR-028 advanced-git error group.

### Exit criterion

- Done when: a deleted/renamed folder yields `REPO_PATH_MISSING` and an existing non-repo folder yields `NOT_A_GIT_REPO`; `RelocateRepository` repoints the same id (id + `created_at` preserved, `common_dir` refreshed, `REPO_PATH_IN_USE` on a duplicate target) and invalidates the graph/cache state; the History pane shows the named recovery panel with Edit path / Choose folder… / Remove (confirmed); no code path deletes a repository implicitly; and the renderer gains no Git or filesystem access.

## When to use

- When a tracked repository's on-disk folder can disappear (rename, move, delete, unmounted volume) and the app must offer recovery instead of failing silently.
- When a registration must follow a path change without minting a new identity.

## When not to use

- Not to infer that two different paths are the same repository — relocation is always explicit and user-driven.
- Not to bypass `GitPort.Resolve` when validating a new path (that is the single source of "is this a Git repository").
- Not to re-add a file list, diff or change stats to the History aside (ADR-0030).

## Examples

```text
openRepository(/old/path)      -> REPO_PATH_MISSING        (fs.ErrNotExist)
openRepository(/tmp/not-a-repo)-> NOT_A_GIT_REPO           (exists, Resolve failed)

RepoPage: GraphStore.error() = REPO_PATH_MISSING + activeRepo
  -> st-repo-relocate-panel  (state named, no silent delete)
       Edit path       -> relocateRepository(id, /typed/path)      -> same id
       Choose folder…  -> chooseDirectory -> relocateRepository     -> same id
       Remove          -> confirm() -> removeRepository            (explicit only)
```

## Common mistakes

- **Collapsing the two codes** into `NOT_A_GIT_REPO`, which makes "your folder moved" indistinguishable from "that was never a repo".
- **Mapping a permission error to `REPO_PATH_MISSING`** — relocating cannot fix an unreadable directory.
- **Delete-then-re-add** as the relocate implementation: new id, lost cache, dropped workspace tab, silent registration loss.
- **Letting the repo picker render** while a repository is unopenable, which hides the failure (the original bug: `openRepository` leaves `repoId` null).
- **Updating `fs_path` without invalidating** the graph/cache state keyed by the repository id.

## References

- History is compare-free (the 7b refusal): [[adr-0030-history-screen-is-compare-free]]
- File Status screen (where file comparison lives): [[adr-0029-file-status-screen]]
- Multi-repo workspaces (tabs keyed by the core repository id): [[adr-024-multi-repo-workspaces]]
- Slices: [renderer-slice](../slices/renderer-slice.md), [core-slice](../slices/core-slice.md), [contracts-slice](../slices/contracts-slice.md), [desktop-shell-slice](../slices/desktop-shell-slice.md)
- ADR hub: [[adr-index]]
