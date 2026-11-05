---
id: adr-026-cross-repo-commit-search
category: adrs
tags: [adr, core, search, cache, m3]
aliases: [ADR-026, Cross-repo commit search]
related: [adr-index, feature-gap-analysis, core-slice, contracts-slice, accepted-debt, adr-0023-commit-change-size-gauge, adr-0034-retire-cross-repo-commit-search]
version: 1.1
status: superseded
---

# ADR-026: Cross-repo local commit search over the metadata cache

## Problem

M3 needs cross-repo local commit search: find commits by message, author or OID across several repositories. No RPC exists, and the only safe store is the SQLite metadata cache — **never Git objects** (anti-goal #2, ADR-006). A naive implementation would either read Git objects into SQLite or run an unbounded `git log --grep` across repos at query time, breaking either the architecture or bounded responsiveness.

Slice: core primary; renderer and contracts secondary.

## Solution

Decision, itemized.

1. **New core RPC** `SearchCommits{query, repeated repo_ids, limit}` returning results `{repo_id, oid, message, author_name, author_email, committed_at}`. The query matches **message**, **author name/email**, and **short/long OID prefix**.
2. **Backing store is the SQLite metadata cache only.** Search reads an indexed SQLite table holding commit **metadata** — `oid`, `repo_id`, `message`, `author`, `committed_at`. The existing `commit_cache` table already holds exactly this metadata (author_name/author_email/message/committed_at), so search **reuses `commit_cache`** and only adds a dedicated index in an append-only migration (`003_*`) if the query needs it. No blobs, no trees, no diffs, no packfiles — never Git objects.
3. **Population is opportunistic and bounded.** Rows are filled from the commit windows the graph already loads, plus an optional bounded per-repo backfill (explicit cap constant). Search never triggers an unbounded `git log` scan at query time.
4. **Query engine starts as a case-insensitive indexed `LIKE`** (provisional), upgradeable to FTS5 later. The decision is "metadata table + indexed query"; the specific operator is provisional.
5. **The renderer sends only `{query, repo_ids, limit}`**; the core owns the query.

### Rejected

- Reading Git objects/packfiles into SQLite.
- Running an unbounded `git log --grep` across repos at query time — violates bounded responsiveness and the cache-only intent.

## Consequences

- Cross-repo search is cheap and bounded: it reads the metadata table, never Git.
- Coverage is partial by design (cached windows + bounded backfill); results are "what is cached", not full history.
- If a dedicated search index is added, the migration must be embedded and pass `verify-migrations.sh`.
- Anti-goal check: no Git objects enter SQLite — the table holds metadata only.

## When to use

- When adding cross-repo commit search or a global search box.
- When deciding what may be persisted to support search.

## When not to use

- Not to store commit bodies, diffs or object data — metadata only.
- Not to scan Git at query time without a bound.
- Not to compute results in the renderer: the core owns the query.

## Examples

```proto
message SearchCommitsRequest {
  string query = 1;
  repeated string repo_ids = 2;
  uint32 limit = 3;
}
message CommitSearchHit {
  string repo_id = 1;
  string oid = 2;
  string message = 3;
  string author_name = 4;
  string author_email = 5;
  int64 committed_at = 6;
}
message SearchCommitsResponse { repeated CommitSearchHit hits = 1; }
```

```text
SQLite commit_search(repo_id, oid, message, author, committed_at)   -- metadata only
query -> WHERE message LIKE ? OR author LIKE ? OR oid LIKE ? LIMIT ?
```

## Common mistakes

- **Persisting diffs or blobs** "so search is richer": violates ADR-006 / anti-goal #2.
- **Unbounded `git log --grep`** at query time: breaks bounded responsiveness.
- **Making FTS5 a hard requirement now**: the operator is provisional; the table is the decision.
- **Building the query in the renderer**: the core owns it.

## References

- Feature-gap analysis: [[feature-gap-analysis]]
- Core slice: [core-slice](../slices/core-slice.md)
- Contracts slice: [contracts-slice](../slices/contracts-slice.md)
- Cache-only context (ADR-006): [[accepted-debt]]
- Commit-stats cache precedent: [[adr-0023-commit-change-size-gauge]]
- ADR hub: [[adr-index]]
