---
id: adr-0014-docs-corpus-layout
category: adrs
tags: [adr, documentation, layout, onrails]
aliases: [ADR-0014]
related: [adr-index]
version: 1.0
status: active
---

# ADR-0014: Adopt the documentation-onrails documentation corpus

## Problem

SingulariTree inherits legacy documentation (`docs/context/git-client/**`) written in a heterogeneous format: hand-written indexes, unvalidated relative links and a root `README.md` that acts as a de facto index. There is no declared layout, no single agent-facing entry point and no language convention. Without a structural decision, every new doc invents its own shape and agents have no stable reading path.

## Solution

Adopt the **documentation-onrails** corpus (contract v1.4) as the canonical layout. Decision, itemized:

1. **Corpus root** = `docs/`. Everything canonical lives under `docs/`; outside it only the human README remains.
2. **Agent-facing entry point** = `docs/project.md`, with the **9 fixed sections** and `doc_language: es` declared **once only**.
3. **ADR location** = `docs/adrs/`. Numbering continues from legacy ADR-013: the first new ADR is **ADR-014**.
4. **Generated indexes** = `docs/index.md` and `docs/tag-index.md`, marked as generated and regenerable.
5. **Root `README.md`** remains a **human** README, outside the corpus, and only points to `docs/project.md`.
6. **Brownfield ratchet:** the contract applies to new or touched files; the legacy `docs/context/git-client/**` is **not rewritten** — it is explicit accepted debt in `accepted-debt.md`.
7. **Language:** Spanish, with technical terms in English.

## When to use

- When deciding where a new document lives or how a slice is routed.
- When evaluating whether a documentation folder should enter the corpus (or remain legacy).

## When not to use

- Do not edit this ADR to change the decision: an accepted ADR is append-only; a successor is written with `supersedes`.
- Do not read it as a mandate to migrate the legacy tree: the ratchet excludes it on purpose.

## Examples

Agent-facing reading path:

```text
README.md (human) -> docs/project.md (entry point) -> hubs -> docs/tag-index.md
```

Corpus folders adopted: `context/`, `protocols/`, `adrs/`, `slices/`.

## Common mistakes

- **Big-bang retro-fit** of the legacy tree: rewriting `docs/context/git-client/**` all at once breaks links and drowns the real PR.
- **Two entry points** (`README.md` + `docs/project.md`) competing: the agent does not know which to read first.
- Continuing ADR numbering in a legacy file instead of `docs/adrs/`.
- Declaring `doc_language` in several files.

## References

- [documentation-system.md](../context/documentation-system.md)
- [docs/project.md](../project.md)
- [accepted-debt.md](../context/accepted-debt.md)
