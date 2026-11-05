---
id: adr-0017-docs-language-en
category: adrs
tags: [adr, documentation, language]
aliases: [ADR-0017]
related: [adr-0014-docs-corpus-layout, documentation-system]
version: 1.0
status: active
---

# ADR-0017: Adopt English as the documentation corpus language

## Problem

SingulariTree's corpus was written in Spanish (ADR-0014 item 7: *Idioma: español, con términos técnicos en inglés*). The tooling, consumers and agents that read the corpus operate in English: the validator, the CI hooks, the prompt pipeline and the agent roles are all English-first, and cross-team contributors and external readers must mentally translate every note. A Spanish corpus also fragments the tag vocabulary and the aliases (mixed-language tokens) and adds onboarding friction for anyone who does not read Spanish. The language was never a structural decision with a migration path — it was a single bullet inside ADR-0014.

## Solution

Declare `doc_language: en` in `docs/project.md` and translate the corpus to English. The decision, itemized:

1. **Language declaration** = `doc_language: en` in `docs/project.md` (declared **once only**, as the contract requires).
2. **Corpus translation** = translate all prose to English, file by file (ratchet-friendly; no big-bang rewrite of the frozen legacy tree).
3. **Invariants that do not move:** frontmatter keys, onrails contract headings, filenames, folder names, `id` values, `related` values, `category`, `status`, `[[wikilink]]` stems and relative markdown link targets/anchors stay **verbatim**.
4. **`tags`** values stay unchanged (the vocabulary is already English; grep it before adding a new tag).
5. **`aliases` and `description`** values are translated to English.
6. **Generated regions** are rebuilt, never hand-edited: `node tools/docs/validate.js --write`.
7. **Version bump:** a pure prose translation is a **PATCH**; the normative language flip (this ADR + the `doc_language` declaration) is documented here.
8. **Supersede, don't rewrite:** this ADR supersedes **ADR-0014 item 7** (`Idioma: español, con términos técnicos en inglés`). ADR-0014 is **append-only**, so it is not edited; its item 7 is superseded by this record.

## When to use

- When writing or translating any note in the corpus: default to English prose.
- When declaring or changing `doc_language`: the single source is `docs/project.md`.
- When deciding whether a translation touches the ratchet: see [[accepted-debt]].

## When not to use

- To translate filenames, ids, wikilink stems or link targets — those are invariants.
- To rewrite the frozen legacy tree `docs/context/git-client/**` in bulk — the ratchet still forbids it.
- To rename frontmatter keys or the onrails contract headings.

## Examples

Language declaration in `docs/project.md`:

```yaml
doc_language: en
```

A translated note keeps its identity:

```text
aliases: [ADR-0017]                       # translated value
related: [adr-0014-docs-corpus-layout]    # id unchanged
[[adr-0014-docs-corpus-layout]]           # stem unchanged
```

Rebuild the generated indexes after translating:

```bash
node tools/docs/validate.js --write
```

## Common mistakes

- **Translating an `id`, a filename or a wikilink stem** — breaks resolution and identity.
- **Renaming frontmatter keys or contract headings** — breaks the validator.
- **Editing a generated region by hand** — the next `--write` reverts it.
- **Migrating the frozen legacy tree in bulk** under cover of translation — violates the ratchet.
- **Declaring `doc_language` in more than one file** — only `docs/project.md`.
- **Forgetting the version bump** when translating a touched file.

## References

- Superseded decision: [[adr-0014-docs-corpus-layout]] (item 7)
- Corpus contract and language key: [documentation-system.md](../context/documentation-system.md)
- Ratchet and translation policy: [accepted-debt.md](../context/accepted-debt.md)
- Project entry point: [project.md](../project.md)
- ADR hub: [[adr-index]]
