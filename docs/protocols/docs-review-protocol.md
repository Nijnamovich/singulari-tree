---
id: docs-review-protocol
category: protocols
tags: [protocol, review, validation]
aliases: [Docs Review Protocol]
related: [new-note-protocol, bootstrap-protocol]
version: 1.0.2
status: active
---

# Docs review protocol

## Problem

Without an explicit merge discipline, the corpus degrades silently: duplicate `id`s, dead links, orphaned notes, and indexes that no longer reflect the content appear. Each reviewer applies different criteria and the debt is discovered late, when nobody knows which version is correct anymore. A closed catalog of rules and an automatic pass that enforces it are needed.

## Solution

The review catalog is a **merge discipline**: it runs before every merge that touches `docs/`. It has 9 errors (blocking) and 3 warnings (human review).

### Errors (block the merge)

| # | Error | What it detects |
|---|-------|-----------------|
| 1 | `metadata-outside-contract` | missing or extra keys in the frontmatter |
| 2 | `non-kebab-case-name` | filename outside lowercase-kebab-case |
| 3 | `duplicate-ids` | two notes with the same `id` |
| 4 | `dangling-related-target` | `related` pointing to a nonexistent `id` |
| 5 | `dangling-link` | relative markdown link to a nonexistent target |
| 6 | `orphan-note` | note without any resolved edge |
| 7 | `missing-from-hub` | note absent from its folder's hub |
| 8 | `stale-generated-index` | generated region out of date with respect to the store |
| 9 | `secret-in-prose` | secret or credential in the body |

### Warnings (human review)

| # | Warning | What it detects |
|---|---------|-----------------|
| 1 | `no-h1` | note without an H1 |
| 2 | `category-mismatch-folder` | `category` does not match the folder |
| 3 | `near-duplicate-body` | body nearly identical to another note |

### Machine walk

```bash
node tools/docs/validate.js          # read-only; exit 1 on errors
node tools/docs/validate.js --write  # regenerates the marker regions
```

`validate.js` does not write unless with `--write`, and `--write` only regenerates the marked regions (`index`, `tags`), write-if-diff.

### Brownfield calibration

- Errors block **only the migrated subset** of the corpus.
- Legacy debt (`docs/context/git-client/**`) is **explicitly excluded** from the validator — see [[bootstrap-protocol]] and `accepted-debt.md`.
- The gap-close loop: **search** → if missing, **write per contract** → **register in the hub AND in the tag index in the same commit**.

## When to use

- Before every merge that touches `docs/`.
- When closing a gap found by the validator (gap-close loop).

## When not to use

- It does not replace human content review: the validator checks form and graph, not technical accuracy or prose.
- It does not apply to excluded legacy: forcing it produces false positives.

## Examples

Fail and then fix a `dangling-related-target`:

```yaml
# before
related: [nota-inexistente]
# after — the id resolves
related: [new-note-protocol]
```

Clean merge:

```bash
node tools/docs/validate.js --write   # regenerates regions
node tools/docs/validate.js           # exit 0
```

## Common mistakes

- Running only `--write` and never the read-only verification: `--write` does not fail even if errors remain.
- Editing a generated index by hand instead of regenerating the region.
- Unblocking the merge by disabling a rule instead of fixing the offending note.
- Registering the note in the hub but forgetting the tag index in the same commit (or the reverse).

## References

- [accepted-debt.md](../context/accepted-debt.md)
- [documentation-system.md](../context/documentation-system.md)
- [docs/project.md](../project.md)
