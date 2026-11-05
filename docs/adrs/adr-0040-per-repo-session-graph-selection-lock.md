---
id: adr-0040-per-repo-session-graph-selection-lock
category: adrs
tags: [adr, renderer, graph, workspaces, multi-repo, session]
aliases: [ADR-040, Per-repo session graph selection and lock]
related: [adr-index, adr-0035-commit-details-redesign-and-inline-hunk-actions, adr-024-multi-repo-workspaces, adr-0036-per-tab-fetch, accepted-debt, renderer-slice]
version: 1.0
status: active
---

# ADR-040: Graph selection and the padlock survive tab switches and route destruction, per repository, in a root in-memory session store

## Problem

[[adr-0035-commit-details-redesign-and-inline-hunk-actions]] gave the graph a **selection lock**: `GraphStore` owns `selectedOid`, `lockedOid` and `lockedCommit`, the padlock pins a commit across `/repo` ↔ `/repo/file-status`, and `openRepository` cleared the lock on **both** the success and the failure path because "a different repository's DAG invalidates the pinned commit".

That last clause is correct about a **different** repository and wrong about the switch that actually happens all day. `GraphStore` is provided on the parent `''` route of `REPO_ROUTES`, so:

- **Route destruction recreates the store.** Walking out of `/repo` and back (or any navigation that unmounts the parent route) builds a fresh instance: selection and padlock are blank, and the operator's place in the history is gone even though the repository never changed.
- **Switching repo tabs loses the pin too, by a different path.** A tab switch activates another repository through the same `openRepository` path on the same store instance; the unconditional reset made the switch symmetric in the wrong direction — the repo you left lost its pin the moment you returned, and the repo you entered never got its own pin back.
- **The reset is not the repository's, it is the instance's.** `openRepository` had no way to tell "reopen the same repository" from "open a different one", so it treated both as an invalidation. In a multi-repo workspace ([[adr-024-multi-repo-workspaces]], with the per-tab fetch model of [[adr-0036-per-tab-fetch]]) that is the normal case, not an edge case.

The lock is a cross-screen concept by design, so holding it only in a route-scoped instance was always going to lose it at the one boundary the store cannot see: the boundary where the instance itself is destroyed.

## Solution

Decision, itemized. The lock stays a `GraphStore` concept; what changes is where a per-repository **snapshot** of its selection/lock lives and when it is written, read and dropped.

1. **A root, in-memory session store keyed by `repoId`.** `GraphSessionStore` (`apps/angular/src/app/core/services/graph-session.store.ts`, `@Injectable({ providedIn: 'root' })`) holds a `Map<string, RepoGraphSessionState>` where the state is exactly `{ selectedOid, lockedOid, lockedCommit }`. Its API is three synchronous methods — `read(repoId)`, `write(repoId, state)`, `forget(repoId)` — and it has no dependencies, so a unit test can instantiate it directly. `lockedCommit` travels with the snapshot for the same reason ADR-0035 holds it beside `lockedOid`: the pinned detail pane must keep rendering when the row is no longer in the loaded window.

2. **`GraphStore` restores the target repo's entry on a successful open.** After `repoId.set(repo.id)`, `openRepository` calls `restoreSession(repo.id)`, which reads the entry and writes the three live signals (or the original null/empty state when the repo has no saved entry). **Opening never writes back**: an open is not a user-driven selection change, so it must not overwrite another tab's saved state. The rest of the open path is unchanged — filter reset, scroll offset and pending restore cleared, empty rows installed before the first window loads.

3. **Only the four user-driven mutators persist.** `select()`, `lock()`, `unlock()` and `release()` call `persistSession()`, which is a no-op when no repo is open or the store is absent. Every selection path funnels through `select()` (row click, `moveSelection`, the deep-link `focusCommit`), so the saved snapshot cannot drift from what the operator actually chose. `reload()`, `loadWindow()` and `applyPage()` deliberately do not persist: a window refresh is not a selection change and must never blank a pin (the ADR-0035 rule stands).

4. **`WorkspacesStore` forgets a dead tab's session.** `closeTab(repoId)` calls `forget(repoId)` before mutating the tab list, and `reconcile(repos)` forgets every tab whose repository is absent from the authoritative core list. A closed tab (or a repository removed elsewhere) therefore leaves no orphan entry behind; `forget` on an unknown repo is a no-op. The injection is optional (`inject(GraphSessionStore, { optional: true })`) so a store constructed without DI degrades to the previous behaviour instead of throwing.

5. **Per-tab isolation is the key, not a flag.** Each repository gets its own entry, so locking a commit in repo A and switching to repo B shows B's own selection and B's own padlock state — never A's. Returning to A restores A's. There is no cross-repo "last selection" and no shared lock.

6. **Memory only, session lifetime only.** The store writes nothing to `localStorage`, `sessionStorage`, SQLite, disk or IPC. State dies with the app process, which is the requirement: a pinned commit is a working-session affordance, and persisting it would resurrect a pin against a DAG that may have moved. The store is a renderer-only construct; the core never learns that a selection exists.

7. **A failed open clears the live signals without erasing the saved entry.** The failure path still drops `selectedOid` and calls a deliberately **non-persisting** `resetLock()`, so no other repository's commits, lanes or pinned commit survive the failure. The snapshot for the repo that failed is kept, so a later successful open (the relocation flow of [[adr-0031-repository-relocation-and-missing-folder-recovery]] is the concrete case) restores the pin instead of silently losing it.

8. **Relation to ADR-0035: its unconditional clear-on-open promise is refined by reference in three places, the rest stands.** [[adr-0035-commit-details-redesign-and-inline-hunk-actions]] stays `active` and is **not edited**. Its §5 (the lock is owned by `GraphStore`, not the panel) and its whole guard model — `select()` refuses a foreign oid and announces the refusal, `unlock()` keeps the selection, `release()` drops both, `lock()` is a no-op unless a genuine commit is selected — are unchanged. Refined **by reference** are all three places where ADR-0035 states the promise unconditionally:

   - its §6 solution bullet — "`openRepository` clears the lock on **both** the success and the failure path";
   - its **Exit criterion** — the padlock is cleared by `openRepository` and never by `reload()`;
   - its **Examples** diagram — `openRepository(...) -> lock cleared (different repo)`.

   In all three, `openRepository` now clears the **live** signals only, restores the target repo's saved entry on success, and leaves the saved entry intact on failure; `reload()` still never clears anything. The same "clear on a different repository" intent survives, expressed per repo instead of per instance.

### Consequences

- **Selection and padlock survive tab switches and route destruction.** Leaving `/repo` and coming back, or hopping between repo tabs, restores each repository's own pinned commit and selected row. The padlock stops being a thing that only works until the operator navigates.
- **Nothing persists across restarts, by requirement.** Quitting the app discards every entry. A new session starts with no selection and no lock, and that is the decided behaviour, not a gap to "fix" with storage.
- **Closing a tab discards that repository's pin.** Closing and reopening the same tab starts from a clean selection/lock; the entry was forgotten on close, and nothing recreates it. Reconcile does the same for a repository that disappeared from the core list.
- **Memory is bounded by the open tabs.** `forget` on close/reconcile is what keeps the map from becoming a leak; an entry exists only for a repository that has an open tab and has been selected or locked at least once.
- **No core, IPC or proto change.** The store is renderer memory; `openRepository`, `getCommits` and every other channel are untouched, and the Go core remains unaware of workspaces and selections.
- **Unit tests outside DI keep the old behaviour.** `new GraphStore(bridge)` has no session store, so an open blanks the selection/lock and mutators do not save — the pre-existing contract, preserved deliberately so existing specs do not need a TestBed.
- **Tests:** `graph-session.store.spec.ts` (read/write/forget, per-repo isolation, unknown repo), `graph.store.spec.ts` (restore on open, persistence from the four mutators, failed open keeps the saved entry) and `workspaces.store.spec.ts` (close and reconcile forget, survivors keep their entries).
- [[renderer-redesign-plan]] gets a truthfulness update: its ADR-0035 note no longer says `openRepository` clears the lock, and points at this record for the per-repository session snapshot.

### Exit criterion

- Done when: `GraphSessionStore` exists as a root service keyed by `repoId` with `read`/`write`/`forget`; `GraphStore.openRepository` restores the opened repo's `selectedOid`/`lockedOid`/`lockedCommit` and never writes back; `select`/`lock`/`unlock`/`release` are the only persisting mutators; a failed open clears the live signals but leaves the saved entry; `WorkspacesStore.closeTab` and `reconcile` forget dropped repos; switching repo tabs and leaving/returning to `/repo` both restore the target repo's own state; nothing is written to `localStorage`, `sessionStorage`, SQLite, disk or IPC; and no proto, IPC channel or Go-core file changed.

## When to use

- When a graph selection or padlock must survive a tab switch on the same store instance, or a store recreation when `/repo` is left and re-entered, for the repository it belongs to.
- When a renderer feature needs per-repository, session-scoped UI state that must **not** outlive the app or leak into another repository.
- When closing or reconciling a tab must invalidate state owned by a service that outlives the tab.
- When wiring a new mutator that changes the selection or the lock: route it through the existing method so the snapshot is written once, at the chokepoint.

## When not to use

- Not to persist the selection across restarts. A stable "last opened commit" across launches would need a storage decision (and an ADR), and the DAG may have moved since.
- Not to persist anything else (scroll offset, filters, dialogs, fetch freshness) "while the store is here": it is a selection/lock snapshot, not a general UI-state cache.
- Not to store Git data in the renderer or in any cache — the graph, not a cache, is the truth.
- Not to forget a session on a mere navigation: only a closed tab or a reconciled-away repository is dead.
- Not as a reopening of ADR-0035's guard model: a foreign selection is still refused and announced, `unlock` still keeps the selection, `release` still drops both.

## Examples

```text
repo A: select c1, lock(c1)
  GraphSessionStore: A -> { selectedOid: c1, lockedOid: c1, lockedCommit: … }

switch to repo B (WorkspacesStore.activeTabId -> B)
  RepoPage effect -> openRepository(B) on the SAME GraphStore
    (a tab switch does not unmount the parent '' route, so nothing is recreated)
    restoreSession(B) -> no entry -> selection null, lock open
    GraphSessionStore: A -> {…c1…}            (untouched: open never writes)
  select(c2) in B
    persistSession() -> B -> { selectedOid: c2, lockedOid: null, lockedCommit: null }

switch back to A
  openRepository(A) -> restoreSession(A) -> selection c1, padlock closed on c1

leave /repo for another route (REPO_ROUTES parent destroyed) and return
  new GraphStore -> openRepository(A) -> restoreSession(A) -> c1 + padlock

open A fails (folder moved)
  live signals cleared (selection null, lock open)
  GraphSessionStore: A -> {…c1…}              (kept for the next successful open)

close tab A
  WorkspacesStore.closeTab(A) -> forget(A)    (entry gone)

quit the app
  every entry is gone                         (no localStorage / SQLite / disk / IPC)
```

## Common mistakes

- **Writing back on `openRepository`.** An open is not a user selection; persisting there overwrites another tab's saved state with a freshly restored — or empty — one.
- **Assuming a tab switch recreates `GraphStore`.** It does not: the parent `''` route survives, so `RepoPage`'s effect calls `openRepository(B)` on the same instance. Recreation happens only when `/repo` is left and entered again; both paths rely on `restoreSession`, not on a fresh store.
- **Persisting from `reload()` / `loadWindow()` / `applyPage()`.** A window refresh does not move the selection; saving there would let a reload blank a pin.
- **Clearing the saved entry on a failed open.** The live signals must be cleared, the snapshot must not: a retried or relocated open is exactly when the pin has to come back.
- **Forgetting to `forget` on tab close or reconcile** — the map turns into a leak, and a reopened tab resurrects a pin nobody asked for.
- **Keying the session by anything other than `repoId`** (path, tab index, active id): two tabs for the same repository and a repo moving on disk both break that key, and the lock leaks across repositories.
- **Reusing the session store as a general UI-state cache** (filters, scroll offsets, dialogs). It is selection + lock, nothing else.
- **Assuming ADR-0035 is superseded as a whole.** Only its clear-on-open promise (solution bullet, exit criterion and examples) is; the ownership and guard model still govern.
- **Adding storage "so it survives a restart"** without a decision — that is a new ADR, not a cleanup.

## References

- The lock this refines (stays `active`): [[adr-0035-commit-details-redesign-and-inline-hunk-actions]]
- Multi-repo tabs, and the renderer-only workspace concept: [[adr-024-multi-repo-workspaces]]
- Per-tab activation model (the tab switch that opens another repo on the same store): [[adr-0036-per-tab-fetch]]
- Relocation of a missing repository — the failed-then-recovered open: [[adr-0031-repository-relocation-and-missing-folder-recovery]]
- Renderer slice: [[renderer-slice]]
- Accepted debt (no ratchet entry for this change): [[accepted-debt]]
- Corpus contract and version-bump rule: [[documentation-system]]
- ADR hub: [[adr-index]]
- Root session store: [graph-session.store.ts](../../apps/angular/src/app/core/services/graph-session.store.ts)
- Route-scoped graph store: [graph.store.ts](../../apps/angular/src/app/features/repo/graph/graph.store.ts)
- Tab lifecycle: [workspaces.store.ts](../../apps/angular/src/app/core/services/workspaces.store.ts)
