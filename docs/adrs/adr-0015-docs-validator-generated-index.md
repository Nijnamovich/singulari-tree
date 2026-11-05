---
id: adr-0015-docs-validator-generated-index
category: adrs
tags: [adr, documentation, validator, generated]
aliases: [ADR-0015]
related: [adr-index]
version: 1.0
status: active
---

# ADR-0015: Own docs validator + generated indexes with marker regions

## Problem

The review catalog of [[docs-review-protocol]] needs an automated pass: without it, the 9 errors are caught by eye and the indexes drift out of sync. The onrails repo validator is not reusable as-is — it is wired to **its** layout, its corpus root and its entry point — so copying it produces false positives against SingulariTree's structure. Besides, maintaining `docs/index.md` and `docs/tag-index.md` by hand guarantees drift.

## Solution

Adopt an **own equivalent**, not the upstream one. Decision, itemized:

1. The onrails repo's `validate.js` is **not** vendored as-is (wired to its layout). A **zero-dependency equivalent** is adopted at `tools/docs/validate.js`, with corpus root `docs/` and entry point `docs/project.md`.
2. **Implements the full catalog**: the **9 errors + 3 warnings** of [[docs-review-protocol]].
3. **`--write`** regenerates the marker regions of `docs/index.md` (marker `index`) and `docs/tag-index.md` (marker `tags`), **write-if-diff**, with a snapshot line (date).
4. **Explicit exclusion** of the legacy `context/git-client/**` as accepted debt — see `accepted-debt.md`.
5. **CI hook** `tools/ci/verify-docs.sh`, same pattern as `tools/ci/verify-contracts.sh`: it fails the build if the validator exits `1`.

## When to use

- When adding or changing rules of the review catalog.
- When touching the shape of the generated indexes or their markers.

## When not to use

- Not to validate semantic content (technical correctness): that is human review.
- Not for the excluded legacy tree: the validator skips it by design.

## Examples

Regenerate and verify:

```bash
node tools/docs/validate.js --write   # index + tags regions, write-if-diff
node tools/docs/validate.js           # read-only, exit 1 if there are errors
```

CI hook:

```bash
tools/ci/verify-docs.sh               # fails the build if validate.js exits 1
```

## Common mistakes

- **Hand-patching** the generated regions: the next `--write` reverts it.
- **Adopting the upstream validator without adapting it**: foreign root, layout and entry point → false positives.
- Regenerating with `--write` and calling the merge good without running the read-only verification.
- Forgetting the snapshot line: the staleness signal is lost.

## References

- [documentation-system.md](../context/documentation-system.md)
- [docs-review-protocol.md](../protocols/docs-review-protocol.md)
- [accepted-debt.md](../context/accepted-debt.md)
