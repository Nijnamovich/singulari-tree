---
id: adr-0036-per-tab-fetch
category: adrs
tags: [adr, renderer, workspaces, multi-repo, m3, remote]
aliases: [ADR-036, Per-tab fetch]
related: [adr-index, adr-024-multi-repo-workspaces, adr-025-deep-links-and-clipboard-clone, feature-gap-analysis, renderer-slice]
version: 1.0
status: active
supersedes: adr-024-multi-repo-workspaces
---

# ADR-036: Repositories are fetched per tab — Sync fetches only the active tab and every other tab is fetched lazily when it becomes active (supersedes ADR-024's fan-out)

## Problem

[[adr-024-multi-repo-workspaces]] made multi-repo fetch a **renderer-orchestrated fan-out**: one click iterated every open tab and issued N concurrent per-repo `fetch` calls. The decision kept the core honest (a per-repo executor, no knowledge of workspaces), but the renderer-side behaviour was wrong for how the operator works.

Every fan-out fetches repositories nobody is looking at. A single slow, offline or credential-prompting remote in a background tab can hold the operation open for minutes while the visible repository finished long ago; the status line has to invent an `N/M` aggregate; and the per-repo results arrive after the operator has already switched tabs, so a late result can repaint a line or a ref list that no longer belongs to the visible repository. The operator's ask was concrete: **sync what I am looking at**.

## Solution

Decision, itemized. This ADR **supersedes [[adr-024-multi-repo-workspaces]] in part**: only its solution item 3 (the fan-out) is replaced. The repo-tabs decision (items 1, 2 and 4), the renderer-only boundary and the core's per-repo executor stand as written.

1. **An explicit Sync fetches exactly one repository: the active tab.** The top-bar action is `top-bar-sync` (`data-testid="top-bar-sync"`, `info` variant), its output is `syncRequested`, and `LayoutComponent.onSync()` reads the active tab and calls `RemoteOpsStore.fetchRepo(id, { force: true })`. An explicit sync is a user intent, so it bypasses the session freshness marker. The call is fire-and-forget: the click path is never awaited.
2. **Every other tab is fetched lazily when it becomes active.** A shell-level `effect()` on `WorkspacesStore.activeTabId()` calls `fetchRepoIfStale(id)`. Every activation path funnels through that signal — the tab strip, the drawer, a deep link (`selectTab`), the startup re-activation, and the neighbour promoted by `closeTab` — so no path needs its own fetch call.
3. **Lazy fetches are single-flight and session-fresh.** `RemoteOpsStore` keeps `fetchInFlight` (a repository with an automatic fetch already running) and `fetchedThisSession` (a repository already fetched successfully since the renderer started). `fetchRepoIfStale` returns immediately when either holds; a failed fetch deletes the freshness marker so a later activation retries, and an explicit sync deletes it so Sync always fetches.
4. **A per-repository generation token discards late results.** `fetchRepo(repoId)` bumps a monotonic token for that repository before awaiting `bridge.invoke('fetch', …)`, and after the await drops its whole result — status, error, refs refresh — unless the token is still current. A status line that has moved to another repository is never repainted, and `repoState.loadRefs()` runs only when the finished repository is still the active one.
5. **Closing or removing a tab invalidates its in-flight fetch.** `invalidateFetch(repoId)` bumps the generation (so a late result can never write), clears the in-flight and freshness entries, and drops the reported status line when it belonged to that repository. The shell calls it **before** `workspaces.closeTab` on a tab close and before closing on repository removal.
6. **No new RPC, proto, IPC channel or `fetch-all` surface.** The request shape is the existing per-repo `fetch` (`{ repoId, remote: '', prune: false, tags: false, force: false }`), unchanged from the fan-out. The core stays a per-repo executor and never learns about workspaces. The renderer never talks to Git.
7. **The status line reports one repository at a time, and it settles.** `st-fetch-all-status` (testid `fetch-all-status`) renders the repository being fetched, the last error and a dismiss control; the `N/M` aggregate is gone. Its title is derived from the reported repository's state — pending → "Fetching repository", success → "Repository up to date", failed → "Fetch failed" — so the line never keeps claiming to fetch after the fetch is over. The name is resolved from the open tabs by `fetchRepoId`, and the shell drops a line that belongs to **another** repository as soon as the active tab changes.
8. **The explicit Fetch / Pull / Push dialogs are untouched.** They remain per-repository operations on the active repository; this decision is about the automatic/all-tabs path, not about removing manual control.

### Consequences

- **Sync is predictable:** it touches the repository on screen and nothing else. A background tab costs no network traffic until it is activated.
- **A closed or abandoned tab can no longer corrupt state.** It may still finish inside the core, but its result is discarded at the renderer boundary (item 4/5), so it cannot write status, error or another repository's ref lists.
- **Recorded honestly: the IPC `fetch` cannot be cancelled.** `invalidateFetch` only discards the **renderer-side result**; the core's `git fetch` for a closed or left repository keeps running until it completes. The guarantee is "no late writes", not "no work".
- **Recorded honestly: lazy fetch means network traffic on tab activation.** The first activation of a repository in a session fetches it (and again after a failure or an explicit sync). The activation path stays responsive because the call is fire-and-forget, but a slow remote now delays *that tab's* freshness instead of being hidden in an aggregate.
- **The freshness marker is in-memory and session-scoped.** A renderer reload re-fetches the first activated tab; it is not persisted UI-state.
- **Single-flight is per repository, not global.** Activating two repositories quickly can run two fetches concurrently; the status line reports the latest one, and a late result from the other is dropped unless that repository is still active.
- **ADR-024 items 1, 2 and 4 stand.** Repo tabs remain renderer UI-state, persisted through the UI-state mechanism, and switching tabs still routes to existing per-repo IPC calls.
- **No contract or core change.** No proto message, IPC channel or Go file changed; the failure modes (`FETCH_FAILED`, `IPC_UNAVAILABLE` → `offline`) are the existing ones.

### Exit criterion

- Done when: the top-bar action is `top-bar-sync` (output `syncRequested`) and fetches only the active tab with `fetchRepo(id, { force: true })`; activating any tab triggers `fetchRepoIfStale` at most once per repository per session and never stacks a second concurrent call for the same repository; a tab close or a repository removal calls `invalidateFetch(repoId)` first; a late result for a closed, left or superseded repository writes no status, error or ref list; the refs refresh of a finished fetch depends only on the token and on the repository still being active, so **dismissing the status line never suppresses it**; the status line names exactly one repository and settles into a state-driven title; and no proto, IPC channel, Go-core file or new RPC was added.

## When to use

- When an automatic or bulk repository action would touch repositories the operator is not looking at.
- When a renderer-orchestrated loop is the right shape but its **scope** should be the visible tab.
- When a result can arrive after the UI that requested it is gone and must be discarded at the boundary.

## When not to use

- Not to introduce a batched or streaming `fetch-all` RPC: the core stays a per-repo executor (ADR-024).
- Not to cancel or abort the core's `git fetch` from the renderer: the IPC is not cancellable, and the renderer must not talk to Git.
- Not to persist the freshness marker as UI-state or as core data.
- Not to remove the explicit Fetch / Pull / Push dialogs: they are manual, per-repository operations and remain.

## Examples

```text
top bar  [Pull] [Push] [Fetch] [Sync]         <- Sync = active tab only
                                      |
                                      v
onSync() -> workspaces.activeTabId() -> remoteOps.fetchRepo(id, { force: true })
                                        (bypasses the freshness marker)

activation  activeTabId changes (tab click / drawer / deep link / startup / closeTab)
              -> effect -> fetchRepoIfStale(id)
                           in flight?      -> return (single-flight)
                           fetched before? -> return (session freshness)
                           else            -> fetchRepo(id)

fetchRepo(id)  token = ++fetchGenerations[id]
               await bridge.invoke('fetch', { repoId, remote: '', prune: false, tags: false, force: false })
               token stale? -> drop status + error + refs
               else         -> fetchedThisSession.add(id); status success/failed
                               refresh refs only if repoState.activeId() === id

closeTab(id)   invalidateFetch(id)  -> generation bump, in-flight/freshness cleared,
                                       reported line dropped if it was this repository
               then workspaces.closeTab(id)
```

## Common mistakes

- **Reintroducing the fan-out or an `N/M` aggregate** — Sync touches one repository, and the status line names one repository.
- **Awaiting the lazy fetch in the activation path** — it is fire-and-forget; awaiting it would make tab switching depend on the network.
- **Refreshing refs from a late result** — `loadRefs()` runs only when the finished repository is still the active one.
- **Forgetting `invalidateFetch` on tab close or repository removal** — a late result then writes a status line or a ref list that no longer belongs to the screen.
- **Claiming the fetch is cancelled** — only the renderer-side result is discarded; the core keeps running the `git fetch`.
- **Adding a `fetch-all` RPC, proto message or IPC channel** — the existing per-repo `fetch` is the whole contract.
- **Treating `fetchedThisSession` as persisted state** — it is in-memory and resets on reload.

## References

- The predecessor, superseded in part (item 3 only): [[adr-024-multi-repo-workspaces]]
- Deep links that activate a tab through `selectTab`: [[adr-025-deep-links-and-clipboard-clone]]
- Feature-gap analysis (truthfulness update): [[feature-gap-analysis]]
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- ADR hub: [[adr-index]]
