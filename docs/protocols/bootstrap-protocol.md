---
id: bootstrap-protocol
category: protocols
tags: [protocol, bootstrap]
aliases: [Bootstrap Protocol]
related: [new-note-protocol]
version: 1.1.1
status: active
---

# Documentation corpus bootstrap protocol

## Problem

A brownfield repo starts without an onrails corpus: no agent-facing entry point, no generated indexes, and no review discipline. The result is orphaned documentation, dead links, duplicate tags, and agents reading different sources in each session. A minimal, repeatable checklist is missing to bootstrap the corpus or audit an existing one and leave it agent-ready.

## Solution

Executable checklist. Copy it as-is into the bootstrap or audit PR and tick each item. An unticked item is pending work, not a footnote.

### Skeleton

- [ ] Entry point `docs/project.md` created: metadata, stack, commands, entities, and the **Slices table**.
- [ ] `doc_language: en` declared **once**, in `docs/project.md`.
- [ ] Create 2–4 folders under `docs/` — and only when the **first real note** needs them. No speculative empty folders.
- [ ] Each folder has its `<folder>-index.md` hub (short body: purpose + contents + elsewhere; not the 7 note sections).

### Runbook

- [ ] Follow onrails guidelines 00–09 for brownfield projects: **slices first**, then the note contract.
- [ ] Prioritize by slice: each change routes to a primary doc via the Slices table.
- [ ] Do not rewrite legacy content to "comply" with the contract; the ratchet applies to new or touched files.

### Store guarantees

- [ ] `docs/index.md` and `docs/tag-index.md` created with their markers (`index`, `tags`).
- [ ] Regenerated with `node tools/docs/validate.js --write` (write-if-diff).
- [ ] Generated artifacts are marked as generated and are **never** patched by hand.
- [ ] Each generated region carries its snapshot line (date).

### Review discipline from day 1

- [ ] Adopt the catalog in `docs-review-protocol.md` as the merge discipline.
- [ ] Calibrate against explicitly accepted debt — see `accepted-debt.md`; excluded legacy does not block the merge.
- [ ] `node tools/docs/validate.js` exits with code `1` on errors → the CI hook blocks the merge.

### Agent-readiness

- [ ] Read-only query path: the agent reads entry point → hubs → tag index, without writing.
- [ ] Visible staleness: each generated region exposes the snapshot date.

## When to use

- When starting a brownfield or greenfield project and defining the corpus from scratch.
- When auditing an existing corpus before a migration or before promoting a topic folder to a slice.

## When not to use

- Not for onboarding a single note: use `new-note-protocol.md`.
- Not for re-bootstrapping an already-green corpus: the checklist would report false pending items.

## Examples

Minimal bootstrap of 4 folders (add each one when creating its first note):

```text
docs/
├── project.md              # entry point (doc_language: en)
├── index.md                # generated (marker: index)
├── tag-index.md            # generated (marker: tags)
├── context/<folder>-index.md
├── protocols/<folder>-index.md
├── adrs/<folder>-index.md
└── slices/<folder>-index.md
```

Audit in one command (read-only):

```bash
node tools/docs/validate.js        # exit 1 on errors
```

## Common mistakes

- Creating empty folders "just in case": they break the principle that each folder is born with its first note.
- Declaring `doc_language` in several files: the single declaration avoids diverging languages.
- Patching `docs/index.md` or `docs/tag-index.md` by hand: the next `--write` reverts the patch.
- Starting the review discipline "later": link debt accumulates faster than it is paid off.

## References

- [docs/project.md](../project.md)
- [documentation-system.md](../context/documentation-system.md)
- [docs-review-protocol.md](./docs-review-protocol.md)
