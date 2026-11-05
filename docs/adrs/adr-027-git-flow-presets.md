---
id: adr-027-git-flow-presets
category: adrs
tags: [adr, core, git-flow, workflow, m3]
aliases: [ADR-027, git-flow presets]
related: [adr-index, feature-gap-analysis, core-slice, contracts-slice, adr-028-advanced-git-rpcs]
version: 1.0
status: active
---

# ADR-027: git-flow workflow presets

## Problem

M3 wants git-flow workflow presets (`feature/*`, `release/*`, `hotfix/*`, `develop`, `main`). No preset exists, and the underlying advanced Git operations — branch CRUD, merge, tag CRUD, stash apply/pop/drop — are only being added by [[adr-028-advanced-git-rpcs]]. A decision is needed on where the workflow semantics live, so the renderer never assembles a sequence of Git commands.

Slice: core primary; renderer and contracts secondary. **Depends on the V1.1 ops (ADR-028).**

## Solution

Decision, itemized.

1. **Workflow semantics live in core (single source).** Presets encode branch naming conventions (`feature/`, `release/`, `hotfix/`, `develop`, `main`) and the required operation sequence, built on the ADR-028 RPCs (`CreateBranch` / `DeleteBranch` / `Merge` / `CreateTag` / `Checkout`).
2. **Core exposes** `StartGitFlow{repo_id, kind, name, base}` and `FinishGitFlow{repo_id, kind, name, ...}` with a `GitFlowKind` enum, plus `GetGitFlowConfig` / `SetGitFlowConfig` for the prefix and branch names. The core orchestrates the underlying Git commands; the renderer never constructs command sequences.
3. **Preset configuration** (prefixes, main/develop branch names) is **SQLite config metadata**, not Git data.
4. **Finish semantics:**
   - finish `feature/*` → merge into develop + delete branch;
   - finish `release/*` → merge into main + tag + merge back into develop;
   - finish `hotfix/*` → merge into main + tag + merge back into develop.
   Conflicts surface via `has_conflict`, consistent with ADR-028.

### Anti-goal check

All Git stays in core; the renderer addresses by `kind`/`name` only.

## Consequences

- One source of truth for workflow semantics: the core.
- The renderer only names a kind and a name; it never builds a merge/tag/branch sequence.
- git-flow is only as complete as the ADR-028 operations it depends on.

## When to use

- When starting or finishing a feature/release/hotfix branch.
- When persisting per-repo workflow configuration.

## When not to use

- Not to encode git-flow sequences in the renderer.
- Not to store preset configuration as Git data.
- Not to ship git-flow before the ADR-028 RPCs land.

## Examples

```proto
enum GitFlowKind { GIT_FLOW_KIND_UNSPECIFIED = 0; FEATURE = 1; RELEASE = 2; HOTFIX = 3; }
message StartGitFlowRequest { string repo_id = 1; GitFlowKind kind = 2; string name = 3; string base = 4; }
message FinishGitFlowRequest { string repo_id = 1; GitFlowKind kind = 2; string name = 3; bool delete_branch = 4; }
```

```text
StartGitFlow{kind: FEATURE, name: "login"}  -> core: CreateBranch feature/login off develop + Checkout
FinishGitFlow{kind: RELEASE, name: "1.0"}   -> core: Merge into main + CreateTag + Merge back into develop
```

## Common mistakes

- **Building the merge/tag sequence in the renderer.**
- **Persisting workflow config as Git data** instead of SQLite config metadata.
- **Ignoring `has_conflict`** on a finish merge.
- **Depending on ADR-028 ops that are not yet implemented.**

## References

- V1.1 advanced Git RPCs (dependency): [[adr-028-advanced-git-rpcs]]
- Feature-gap analysis: [[feature-gap-analysis]]
- Core slice: [core-slice](../slices/core-slice.md)
- Contracts slice: [contracts-slice](../slices/contracts-slice.md)
- ADR hub: [[adr-index]]
