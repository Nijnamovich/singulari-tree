---
id: adr-0034-retire-cross-repo-commit-search
category: adrs
tags: [adr, core, contracts, desktop-shell, renderer, m3, search]
aliases: [ADR-034, Retire cross-repo commit search]
related: [adr-index, adr-026-cross-repo-commit-search, adr-025-deep-links-and-clipboard-clone, feature-gap-analysis, core-slice, contracts-slice, renderer-slice, accepted-debt]
version: 1.0
status: active
supersedes: adr-026-cross-repo-commit-search
---

# ADR-034: Retire cross-repo local commit search end-to-end (supersedes ADR-026)

## Problem

[[adr-026-cross-repo-commit-search]] admitted cross-repo local commit search over the SQLite metadata cache: a `SearchCommits` RPC over `commit_cache`, a core service with its own port, cache query and gRPC handler, a shell IPC channel with its preload bridge and core client, and a renderer `search` feature folder (store + workspace) reachable from the WORKSPACE nav.

The operator judged the surface as **not serving a real need**. Cross-repo message/author/OID lookup was never part of a working flow: the renderer view shipped (M3) and went unused, and the feature instead carried a permanent cost at every layer it touched.

That cost is not local to the core. The proto surface (one RPC + three messages + regenerated Go/TS stubs), the core service/port/cache query, the shell channel/preload/core-client unary, the renderer feature folder/store/nav entry with its i18n strings, and one accepted-debt row (ASCII-only `LIKE`, unindexed) all had to keep compiling, stay compatible and be re-verified on every contracts change. Cost outweighed value, so the surface is retired outright.

## Solution

Decision, itemized: **full end-to-end removal at every layer, with no replacement.**

1. **Renderer.** The `search` feature folder, `CommitSearchStore`, `SearchWorkspace`, the WORKSPACE nav `Search` item, the in-shell search workspace mounted by the layout, and the `searchCommits` member of the IPC bridge are gone.
2. **Sibling renderer renames landed in the same pass** (not part of the search surface, but riding with it): the nav item `Local changes` becomes `Commit analyzer`, and the File-status variant segment `Pull request` becomes `Branch comparator` — the variant values `local` / `commit` / `pr` are unchanged.
3. **Sibling panel layout in the same pass:** `st-commit-details-panel` now rests on the floor of its container in both hosts, and in the File status `commit` variant the commit subject moved out of the panel to become the right-pane title above `file-status-diff`; `toggle-segment-local` carries a badge with the count of pending (unstaged) files.
4. **Shell.** The `git:searchCommits` channel, its preload bridge method and the `go-core-client` unary are gone.
5. **Core.** `SearchService`, `CommitCache.SearchCommits`, the `SearchCommits` gRPC handler, `domain.CommitSearchHit` / `CommitSearchPort`, and their wiring in `cmd/go-core/main.go` are gone.
6. **`commit_cache` stays.** The table remains the graph's metadata cache; **no migration was added and none was dropped**.
7. **Contracts — a breaking change by intent.** The `SearchCommits` RPC and the `SearchCommitsRequest` / `CommitSearchHit` / `SearchCommitsResponse` messages were removed from `libs/contracts/proto/gitcore.proto`, and the stubs regenerated with `./tools/scripts/gen-contracts.sh`. `./tools/ci/verify-contracts.sh` fails on `buf breaking` **by design**: that failure is the record of the break, not an accident to silence.
8. **Not retired.** The `singularitree://open-commit` deep link keeps `CommitFocusService` ([[adr-025-deep-links-and-clipboard-clone]]); it is a different surface and is untouched.
9. **ADR-026 becomes historical context.** Its status flips to `superseded` and its body is not edited (ADRs are append-only); this record carries the decision forward.

### Rejected

- **Partial removal** — dropping only the renderer view and keeping the RPC/service (or the reverse). It removes the visible half of the cost while leaving a dead wire surface that must still be maintained, versioned, regenerated and breaking-checked.
- **Deprecate-in-place / keep the RPC "for later"** — an unused RPC is not free: it pins every future contracts change to a surface nobody calls, and it invites re-adoption of a surface the operator has already judged worthless.
- **Replace it with another search surface** (global search box, history search, FTS5 index) — no need was demonstrated; a replacement would re-import exactly the cost [[adr-026-cross-repo-commit-search]] accepted on a premise that no longer holds.

## Consequences

- **The contract is breaking for any external consumer.** `SearchCommits` and its three messages are gone from `singularitree.v1`; a consumer outside this repo must drop the call.
- `commit_cache` remains the graph's metadata cache, consumed by the graph's commit windows and stats; it carries **no search query** any more.
- `CommitFocusService` survives for `singularitree://open-commit` deep links.
- [[adr-026-cross-repo-commit-search]] becomes historical context: the slices, the feature-gap analysis and the accepted debt are annotated as retired, and the `LIKE`/ASCII limitation row is dropped because the debt ceased to exist with the query.
- Anti-goal check: nothing persisted changed — no Git objects entered SQLite, and the removal only deletes surface.

## When to use

- When deciding whether an admitted feature is still worth its **standing cross-slice cost** (proto, core, shell, renderer, i18n, accepted debt).
- When recording a **full end-to-end removal with no replacement**, itemized per layer.
- When a **breaking contract change is intentional** and the failing `buf breaking` check is the record of it.

## When not to use

- Not to retire the `commit_cache` table or any graph metadata cache — only the search query is gone.
- Not to retire the `singularitree://open-commit` deep link: `CommitFocusService` stays.
- Not to treat the `buf breaking` failure as a bug to silence with an exemption — it is the intended record of this break.
- Not as a precedent for dropping a contracted surface that has **live** external consumers.

## Examples

```text
Before (ADR-026):  renderer search view -> searchCommits IPC -> git:searchCommits
                   -> go-core-client unary -> SearchService -> commit_cache (LIKE)
After  (ADR-034):  (nothing)  — renderer, shell, core and proto all drop the surface

Stays:  commit_cache                      (graph metadata cache, no search query)
Stays:  singularitree://open-commit -> CommitFocusService  (ADR-025)
Record: ./tools/ci/verify-contracts.sh -> buf breaking FAILS (intended)
```

## Common mistakes

- **Leaving one layer behind** (e.g. dropping the renderer view but keeping the RPC) — that is the partial removal this ADR rejects.
- **Dropping `commit_cache` or touching a migration** — the table is the graph's metadata cache and is untouched.
- **"Fixing" the `buf breaking` failure** by exempting the proto file: the failure is the record of an intentional break.
- **Editing ADR-026's body** — append-only; only its frontmatter status changes.
- **Retiring `CommitFocusService` along with the search surface** — deep links are a different path.

## References

- The retired decision (now superseded): [[adr-026-cross-repo-commit-search]]
- Deep links that survive (`CommitFocusService`): [[adr-025-deep-links-and-clipboard-clone]]
- Feature-gap analysis (truthfulness update): [[feature-gap-analysis]]
- Core slice: [core-slice](../slices/core-slice.md)
- Contracts slice: [contracts-slice](../slices/contracts-slice.md)
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- Accepted debt (row dropped): [[accepted-debt]]
- ADR hub: [[adr-index]]
