---
id: adr-0023-commit-change-size-gauge
category: adrs
tags: [adr, core, cache, stats, m2]
aliases: [ADR-0023, Commit change-size gauge]
related: [adr-index, adr-0020-diff-per-file-and-hunk-staging, accepted-debt, feature-gap-analysis]
version: 1.0
status: active
---

# ADR-0023: Commit change-size gauge (numstat counts, metadata cache only)

## Problem

The graph should show a change-size gauge per commit (additions / deletions / files changed), as GitKraken and SourceTree do. Computing it on every render over a large window is expensive, and there is no cache for it. Any cache must respect anti-goal #2: SQLite never stores Git objects or blobs — only metadata.

## Solution

Decision, itemized.

1. New RPC **`GetCommitStats(GetCommitStatsRequest) returns (GetCommitStatsResponse)`**:
   - `GetCommitStatsRequest { string repo_id = 1; repeated string oids = 2; }`
   - `GetCommitStatsResponse { repeated CommitStats stats = 1; }`
   - `CommitStats { string oid = 1; int32 additions = 2; int32 deletions = 3; int32 files_changed = 4; }`
2. Core computes the counts via `git diff --numstat` (and/or `--shortstat`) for each requested commit against its **first parent**. Merge commits diff against the first parent by policy; a root commit diffs against the empty tree.
3. The counts are cached in a SQLite table **`commit_stats`** — counts only, **NEVER Git objects/blobs** (anti-goal #2). Migration: `data/sqlite/migrations/002_commit_stats.sql`, registered per the migrations convention (SSOT in `data/sqlite/migrations/`, embedded via `gen-migrations.sh`, checked by `tools/ci/verify-migrations.sh`).
4. Stats are computed **lazily for the visited window**: only the commits the graph actually requests are measured, not the whole history.
5. Cache invalidation follows the existing pattern: a watcher event or a `HEAD` move invalidates the repo's stats alongside `commit_cache`.

### Consequences

- The gauge is cheap at render time: it reads counts from SQLite, not from git.
- Only counts are persisted; no blobs, trees or patches enter SQLite, so anti-goal #2 holds.
- A first visit to a commit window pays the `git diff` cost once, then serves from cache.
- A new migration file exists, so the migrations generator and CI validator must be re-run.

### Exit criterion

- M2 done when: `GetCommitStats` returns `{oid, additions, deletions, files_changed}` for a batch of oids; `002_commit_stats.sql` applies and passes `verify-migrations.sh`; stats are cached in `commit_stats` (counts only); the graph renders the gauge from the cache; invalidation on watcher/HEAD move is wired.

## When to use

- When the graph needs a change-size indicator for a commit row.
- When batching stats: request the visible window's oids in one call.

## When not to use

- Not to persist diffs, blobs, trees or patch text — counts only.
- Not to precompute stats for the entire history: compute lazily for the visited window.
- Not to compute stats in the renderer: Git stays in core (anti-goal #1).

## Examples

```proto
message GetCommitStatsRequest {
  string repo_id = 1;
  repeated string oids = 2;
}
message GetCommitStatsResponse {
  repeated CommitStats stats = 1;
}
message CommitStats {
  string oid = 1;
  int32 additions = 2;
  int32 deletions = 3;
  int32 files_changed = 4;
}
```

```text
oid O  ->  git diff --numstat <O>^ <O>  ->  sum added / removed / files
        ->  UPSERT commit_stats(repo_id, oid, additions, deletions, files_changed)
```

## Common mistakes

- **Caching diff text or blobs** "to render faster": violates anti-goal #2.
- **Computing stats eagerly for 50k commits**: measure the visited window only.
- **Forgetting the migrations pipeline**: a new `002_*.sql` must be embedded and pass `verify-migrations.sh`.
- **Diffing a merge against all parents**: the policy is first parent.

## References

- Per-file diff and hunk staging (same M2 wave): [[adr-0020-diff-per-file-and-hunk-staging]]
- Accepted debt and anti-goal #2 context: [[accepted-debt]]
- Continuation context: [[feature-gap-analysis]]
- ADR hub: [[adr-index]]
