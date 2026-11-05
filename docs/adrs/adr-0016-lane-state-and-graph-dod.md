---
id: adr-0016-lane-state-and-graph-dod
category: adrs
tags: [adr, graph, lanes, dod, onrails]
aliases: [ADR-0016]
related: [adr-index, accepted-debt]
version: 1.0
status: active
---

# ADR-0016: Per-repo lane state + graph DoD scope

## Problem

Two decisions were left implicit while implementing the graph and, without a record, they are lost. (a) Column (lane) assignment suffered *seams* of re-layout because the algorithm was local to each window: the same commit could land in a different column depending on which scroll window requested it. (b) The Week 1-2 DoD promised visual parity with `git log --graph --oneline`, which draws convergence diagonals and crossings, while the wire contract `Lane{index,color,continues}` does not carry edge geometry and those diagonals are not representable.

## Solution

Two decisions, itemized.

### (a) Lane state ownership — stateful `GraphService` per repo

1. Lanes are computed **only in Go** (ADR-008); the renderer never re-derives columns.
2. `GraphService` keeps a **fold state per repository** (lane slots) plus the **accumulated lane vector**, resolved from HEAD.
3. A commit's column depends **only on the history from HEAD**, not on which window requested it — the re-layout *seams* of the previous purely window-local computation are eliminated.
4. State is **invalidated** by watcher events and HEAD moves: `GitService` mutating operations emit a watcher event, and `main.go` wires `WatcherService.OnChange → GraphService.Invalidate`.
5. **Concurrency:** mutex per service; `go test -race` stays green.
6. **In-memory cache only**; SQLite remains a commit-metadata cache and **never** stores Git objects (entry-point anti-goal).

### (b) DoD scoping — vertical columns; edge geometry deferred

7. The wire contract `Lane{index,color,continues}` **does not carry edge geometry**, so convergences and crossings cannot be drawn as diagonals.
8. The Week 1-2 DoD is **scoped to vertical lane columns**: correct and continuous column assignment across windows.
9. Full **visual parity** with the diagonals/crossings of `git log --graph` is deferred as **accepted debt** (see [[accepted-debt]]).
10. **There was no contract change** (neither `LaneRow` nor segments): it was a deliberate decision (Option B) not to freeze an incomplete wire contract.

## When to use

- When touching `GraphService.Lanes`, its fold state, its invalidation or its benchmark.
- When evaluating whether the graph DoD requires diagonals/crossings (today: no; it is accepted debt).

## When not to use

- Not to redesign the graph UI nor assume parity with `git log --graph`.
- Not to introduce `LaneRow`/segments without a successor ADR that supersedes this one.
- Not to move lane computation into the renderer: violates ADR-008.

## Examples

Per-repo state and invalidation:

```go
// GraphService: fold state per repo + accumulated lane vector, resolved from HEAD.
func (s *GraphService) Invalidate(repoID string) { /* drop fold state -> recompute from HEAD */ }

// main.go: a watcher change triggers invalidation.
watcher.OnChange(func(ev Event) { graph.Invalidate(ev.RepoID) })
```

Verification cycle:

```bash
cd apps/go-core && go test -race ./...   # the state mutex stays green
```

## Common mistakes

- **Putting the fold state in the window** instead of the service: reintroduces the *seams* between scrolls.
- **Forgetting to invalidate on HEAD moves**: a mutating operation without a watcher event leaves stale lanes.
- **Caching Git objects in SQLite** "to speed things up": violates the anti-goal; SQLite is metadata only.
- **Promising diagonals** with the current contract: `Lane` carries no edge geometry.

## References

- Accepted debt (edge parity): [[accepted-debt]]
- ADR hub: [[adr-index]]
- Corpus contract: [documentation-system.md](../context/documentation-system.md)
- Legacy service design: [service-design.md](../context/git-client/service-design.md)
