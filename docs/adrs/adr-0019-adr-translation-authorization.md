---
id: adr-0019-adr-translation-authorization
category: adrs
tags:
- adr
- documentation
- lifecycle
aliases:
- ADR-0019
- ADR translation authorization
related:
- adr-0014-docs-corpus-layout
- adr-0015-docs-validator-generated-index
- adr-0016-lane-state-and-graph-dod
- adr-0017-docs-language-en
- documentation-system
version: 1.0
status: active
---

# ADR-0019: Authorize translation-only amendment of historical ADR bodies

## Problem

The append-only rule protects the *content* of an accepted ADR from being rewritten: an addendum is written, never an edit of the original text. But the corpus-wide language change (ADR-0017) leaves historical ADR bodies recorded in Spanish, so the corpus is not single-language. Translating those bodies by hand would look exactly like rewriting history: the same record would change its wording after the fact, with no successor and no `supersedes`, and append-only offers no path for it. A decision is needed to distinguish a **translation** — which preserves every decision — from a semantic edit, which does not.

## Solution

Authorize a **translation-only transform** of historically-recorded ADR bodies. The decision, itemized:

1. **Scope = language only, never content.** A translation-only transform may change the human language of an already-accepted ADR body, and nothing else.
2. **Invariants preserved exactly:** meaning, decisions, alternatives, numbers, ids, section structure, links/wikilinks and code. Only the human language changes; no decision is altered, added, removed or renumbered.
3. **Single exception to append-only.** This is the **only** exception to the append-only rule, and it applies to language translation alone. Correcting or changing a decision still requires a successor ADR with `supersedes`; the original text is never edited for that purpose.
4. **Explicit coverage:** `adr-0014-docs-corpus-layout`, `adr-0015-docs-validator-generated-index`, `adr-0016-lane-state-and-graph-dod`, and the legacy `ADR-001`..`ADR-013` blocks embedded in `docs/context/git-client/decisions.md`.
5. **No version bump.** Translation-only transforms change no semantics, so they are **exempt** from the version-bump requirement; historical ADRs keep their `version` value.
6. **Still append-only for everything else.** After the transform, the ADR remains immutable except for another translation-only transform under this ADR.

## When to use

- When translating the prose of an already-accepted ADR body under ADR-0017, without touching any decision.
- When auditing the corpus for the single-language requirement and finding historically-recorded bodies in Spanish.

## When not to use

- To correct, clarify or change a decision: that requires a successor ADR with `supersedes`.
- To renumber items, drop alternatives, reorder sections, or touch `id`, `category`, `tags`, `related`, `status` or `version`.
- To translate anything other than the body prose: filenames, ids, wikilink stems and link targets stay verbatim (ADR-0017).
- To rewrite the frozen legacy tree in bulk: the ratchet still applies (see [[accepted-debt]]).

## Examples

A translation-only transform of an ADR body:

```text
Problem (es)  "Sin una decisión estructural, cada nuevo doc inventa su propia forma."
Problem (en)  "Without a structural decision, every new doc invents its own shape."
```

The decision, numbering and links are identical in both versions; only the language changed.

Preserved on translation (do not touch):

```yaml
id: adr-0014-docs-corpus-layout   # unchanged
version: 1.0                      # unchanged (translation-only is exempt)
related: [adr-index]              # unchanged
```

## Common mistakes

- **Editing a decision under the cover of translation** — the meaning changed, not just the language; that requires a successor ADR.
- **Renumbering items or dropping an alternative** while translating — breaks the invariants.
- **Bumping `version`**: translation-only transforms are exempt and keep the historical `version`.
- **Translating an `id`, a filename or a wikilink stem** — breaks resolution and identity.
- **Extending the exception to the frozen legacy tree** beyond the listed embedded ADR blocks.

## References

- Corpus language decision: [[adr-0017-docs-language-en]]
- Corpus contract, lifecycle and append-only rule: [[documentation-system]]
- The translated ADRs: [[adr-0014-docs-corpus-layout]], [[adr-0015-docs-validator-generated-index]], [[adr-0016-lane-state-and-graph-dod]]
- Accepted debt and the ratchet: [[accepted-debt]]
