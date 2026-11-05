---
id: adr-0022-graph-context-menu-shell
category: adrs
tags: [adr, renderer, graph, context-menu, m2]
aliases: [ADR-0022, Graph context menu shell]
related: [adr-index, renderer-slice, adr-0021-reset-modes, feature-gap-analysis]
version: 1.0
status: active
---

# ADR-0022: Graph right-click context-menu shell

## Problem

The commit graph has no right-click context menu. The V1.1-planned menu (create-branch-here, cherry-pick, revert, tag) depends on operations that do not exist yet, so shipping the full menu would render entries that silently do nothing. A decision is needed on what the M2 shell contains, and on the explicit exclusion of the entries that wait for M3/V1.1.

## Solution

Decision, itemized.

1. **Renderer-only shell.** The context menu lives in the Angular renderer; it adds **no new core RPC**. It reuses RPCs that already exist or are defined by sibling ADRs.
2. Actions in scope:
   - **Checkout** — reuses the existing `Checkout` RPC, including its existing confirm / discard-untracked flow.
   - **Compare** — reuse `GetDiff` with `from`/`to` set to the two selected commits (the fields already exist in the contract).
   - **Copy SHA** — renderer clipboard only (`navigator.clipboard`); no IPC round-trip.
3. **Explicitly EXCLUDED** — create-branch-here, cherry-pick, revert, tag. These are V1.1-planned and light up only after **M3/V1.1** lands the branch/merge/tag/stash operations. They are not shipped as dead entries now.
4. Reset entries (soft/mixed/hard) are a separate decision — [[adr-0021-reset-modes]] — and render in the same menu once that RPC exists; this ADR does not redefine them.
5. The shell is a dumb presentation component: it emits the chosen action; the owning store performs the RPC.

### Consequences

- M2 ships a menu whose visible entries all work; no dead actions.
- The V1.1 entries are recorded as excluded, so their absence is intentional, not an oversight.
- Compare and Copy SHA need no new contract; Checkout reuses the existing flow.

### Exit criterion

- M2 done when: right-clicking a commit shows a menu with Checkout / Compare / Copy SHA; Checkout calls the existing RPC through the store; Compare opens `GetDiff` between the two commits; Copy SHA writes to the clipboard with no IPC; and none of the V1.1-planned entries are rendered.

## When to use

- When adding a new graph action: check whether it exists in the contract before adding renderer UI.
- When wiring the menu to state: the component emits, the store calls `IpcBridge`.

## When not to use

- Not to render create-branch-here / cherry-pick / revert / tag before M3/V1.1.
- Not to add a new RPC for Compare or Copy SHA — reuse `GetDiff` and the clipboard.
- Not to talk to Git from the menu: everything crosses IPC → shell → core.

## Examples

```text
right-click(commit) -> Checkout  -> store.checkout(repoId, ref)      -> Checkout RPC
                    -> Compare   -> store.compare(oidA, oidB)        -> GetDiff RPC
                    -> Copy SHA  -> navigator.clipboard.writeText(oid) // no IPC
```

## Common mistakes

- **Rendering disabled dead entries** for the V1.1 actions instead of excluding them.
- **Adding a bespoke compare RPC** when `GetDiff` already takes `from`/`to`.
- **Calling Git from the renderer** for checkout/compare — that violates anti-goal #1.
- **Duplicating reset logic** here instead of deferring to [[adr-0021-reset-modes]].

## References

- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- Reset decision that shares the menu: [[adr-0021-reset-modes]]
- Continuation context: [[feature-gap-analysis]]
- ADR hub: [[adr-index]]
