---
id: new-note-protocol
category: protocols
tags: [protocol, contract]
aliases: [New Note Protocol]
related: [bootstrap-protocol]
version: 1.0.1
status: active
---

# New note protocol

## Problem

A note written "freehand" usually enters without complete frontmatter, without the mandatory body sections, or without edges to the rest of the graph. That makes it invisible to the generated indexes, breaks the validator, and leaves links nobody resolves. A single checklist that runs **before** declaring the note finished is missing.

## Solution

Closing checklist. Run it in full before declaring the note `done`; an unticked item is a blocker.

### Metadata

- [ ] The **7 required keys** are present: `id`, `category`, `tags`, `aliases`, `related`, `version`, `status`.
- [ ] `id` is a unique slug, approximately `<stem>` and consistent with `<category>`.
- [ ] `status` is one of the enum: `draft` | `active` | `superseded` | `expired`.
- [ ] Optional keys: present with a valid value or **entirely absent** (never empty or `null`).
- [ ] No extra keys outside the contract.

### Body

- [ ] H1 present and descriptive.
- [ ] The **7 sections verbatim in order**: `## Problem`, `## Solution`, `## When to use`, `## When not to use`, `## Examples`, `## Common mistakes`, `## References`.
- [ ] `## When not to use` and `## Common mistakes` are real and specific, not filler.

### Graph

- [ ] Every `related` points to an `id` that resolves to a real note.
- [ ] Every `[[wikilink]]` uses the filename stem (without `.md`) and resolves.
- [ ] The note has **≥1 resolved edge** (either `related` or `[[wikilink]]`).
- [ ] The note appears in its folder's hub.

### Hygiene

- [ ] No secrets: no credentials, no long hashes, no `token` or `password` values in the body.
- [ ] The generated index lists the note (`node tools/docs/validate.js --write` with no unexpected diff).
- [ ] All links alive: `node tools/docs/validate.js` exit `0`.

## When to use

- When creating any new note inside the corpus (context, protocols, adrs, decisions).
- When touching an existing note that had not yet gone through the contract.

## When not to use

- Not for hubs: `<folder>-index.md` files use a short body, not the 7 sections.
- It does not replace content review: the checklist verifies form, not truthfulness.

## Examples

Correct minimal frontmatter (7 keys, no extras):

```yaml
---
id: my-note
category: protocols
tags: [protocol, example]
aliases: [My Note]
related: [new-note-protocol]
version: 1.0
status: active
---
```

Live edge: `related: [new-note-protocol]` resolves to `new-note-protocol.md`; `[[new-note-protocol]]` resolves to the same stem.

## Common mistakes

- Leaving optional keys as `null` or `[]` instead of omitting them.
- Writing the H1 in one language and the sections in another; the body goes in the configured language.
- `related` with stems instead of `id`s, or `[[wikilink]]` with `.md`.
- Creating the note without registering it in its folder's hub: it stays orphaned.

## References

- [docs-review-protocol.md](./docs-review-protocol.md)
- [documentation-system.md](../context/documentation-system.md)
- [docs/project.md](../project.md)
