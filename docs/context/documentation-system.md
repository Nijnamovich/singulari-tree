---
last_updated: 2026-10-05
status: active
description: How SingulariTree's documentation corpus is organized — layers, frontmatter contract, naming, hubs, generated indexes, lifecycle and validator.
tags:
- documentation
- contract
- structure
- onrails
version: 1.2
related:
- accepted-debt
---

# Documentation System

## Problem

A Markdown corpus without rules rots in two ways: notes silently stop being true, and consumers (humans or agents) navigate by guessing paths. Without a single contract there is no way to know which file is the source of truth, which frontmatter key is valid, or how a new note gets indexed. SingulariTree needs an organization that serves both readers and agents, without an intermediate database.

## Solution

The corpus lives under `docs/` and follows the **documentation-onrails v1.4** contract.

### Layers

- **raw** — uncurated sources (code, decisions, drafts).
- **wiki** — curated notes; *it is the store*.
- **schema** — templates and review catalog that apply shape to the wiki.

Rules: **one topic per file**, reference instead of duplicating, maximum 3 nesting levels, and **one hub per folder** named `<folder>-index.md` (*schema* folders such as `protocols/` are exempt, since their notes are registered from the entry point's navigation table).

### Frontmatter contract

- **`note` family** (all `*-index.md`): exactly 7 keys — `id`, `category`, `tags`, `aliases`, `related`, `version`, `status`. Optional `supersedes`, `expires_at`, `moved_from`; they are **omitted** if unused (present-but-empty is an error).
- **`context-doc` family** (`docs/context/*.md` and `docs/project.md`): `last_updated` (YYYY-MM-DD), `status`, `description`, `tags`, `version`; optional `related`, `moved_from`. `docs/project.md` additionally adds `doc_language` (declared **once only**).
- Keys are **never** renamed or translated.

### Naming and identity

- Names in `lowercase-kebab-case`; `docs/README.md` is the only exception and stays **outside** the corpus.
- `related` uses **ids**; `[[wikilinks]]` use file **stems** (without extension). A single **case-insensitive** resolver; every reference must resolve to a real file.

### Generated indexes

- `docs/index.md` and `docs/tag-index.md` are artifacts generated in **regions delimited** by markers (`<!-- BEGIN GENERATED: index|tags -->` … `<!-- END GENERATED: … -->`).
- The generator works **write-if-diff** (byte-stable output) and stamps a **snapshot date**; it never touches text outside the region nor rescues generated content.

### Lifecycle

- `status` ∈ `draft` | `active` | `superseded` | `expired`. Supersede, don't rewrite: the successor declares `supersedes` and the predecessor changes state.
- **ADRs are append-only** by contract: an addendum, never edit the original text. Sole exception: a **translation-only** transform of a historical ADR body (language change, no decision change) — see [[adr-0019-adr-translation-authorization]].

### Ratchet

- The contract applies **only** to new or touched files. The legacy corpus `docs/context/git-client/**` is frozen and excluded from the validator — see [[accepted-debt]].

### Version bump

- `version` = `MAJOR.MINOR(.PATCH)`: MAJOR if it breaks the contract (requires an ADR), MINOR if normative/structural, PATCH if wording only. Every touched file bumps `version` and refreshes `last_updated`.

### Validator

- `node tools/docs/validate.js` walks the catalog and exits with **exit 1** on errors (e.g. `metadata-outside-contract`); `--write` regenerates the indexes.
- `./tools/ci/verify-docs.sh` is the CI hook that runs validation on every change.

## When to use

- Before writing or editing any note: confirm the frontmatter family, the naming, and whether the reference resolves.
- When an agent needs to know where a truth lives or how a new entry gets routed.

## When not to use

- For the human root README (`README.md`): it lives outside the corpus and carries no frontmatter.
- For the legacy design of `docs/context/git-client/**`: it is not migrated in bulk (see [[accepted-debt]]).

## Examples

New note (`note` family, folder hub):

```markdown
---
id: slices-index
category: hub
tags:
- slices
- hub
aliases:
- indice-de-slices
related:
- documentation-system
version: 1.0
status: active
---
```

Minimal context-doc:

```markdown
---
last_updated: 2026-09-28
status: active
description: ...
tags:
- documentation
version: 1.0
---
```

Generated region:

```markdown
<!-- BEGIN GENERATED: index -->
<!-- END GENERATED: index -->
```

## Common mistakes

- Leaving an optional key present but empty (`supersedes:` with no value) — a contract error.
- Editing by hand inside a generated region; it is rebuilt with `--write`.
- Duplicating content that already lives in another context-doc or in `docs/project.md` instead of referencing it.
- Mixing several topics in one file and breaking "one topic per file".
- Declaring `doc_language` in more than one file: only `docs/project.md`.

## References

- Accepted debt and ratchet: [[accepted-debt]]
- Project entry point: [docs/project.md](../project.md)
- Corpus review: [docs/protocols/docs-review-protocol.md](../protocols/docs-review-protocol.md)
