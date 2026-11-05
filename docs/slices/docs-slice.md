---
id: docs-slice
category: slices
tags:
- slice
- generality
aliases:
- Docs slice
related:
- slices-index
version: 1.1
status: active
---

# Docs — Slice Generalities

## What this slice is

Project documentation corpus: entry point, strategic context, slices, protocols, ADRs and generated indexes. It is the canonical source that routes every change to its doc.

## Boundaries

- **IN:** `docs/**`.
- **OUT:** `.opencode/protocols/` (agent-system protocols) and the application code.

## Entry points

- `docs/project.md` — entry point and Slices table.
- `docs/index.md` — root index.
- `docs/context/` — strategic context.
- `docs/slices/` — generalities per slice.
- `docs/protocols/` — project protocols.
- `docs/adrs/` — architecture decisions.

## How it works

- Onrails contract: frontmatter + fixed sections per note type.
- Per-folder hubs that index their notes.
- Generated indexes with regenerable markers: `node tools/docs/validate.js --write`.
- Corpus validator: `tools/docs/validate.js`.

## Conventions of this slice

- `doc_language: en`.
- File and folder names in lowercase-kebab-case.
- `related` references ids; `[[wikilinks]]` reference file stems (without `.md`).
- ADRs are append-only.
- Ratchet: the contract applies only to new or touched files.

## Dependencies

- **Upstream:** documenter and orchestrator agents.
- **Downstream:** all slices (routing).

## Known gaps & accepted debt

- Legacy `docs/context/git-client/**` without frontmatter (see `docs/context/accepted-debt.md`).
- ADR-001..013 embedded in the legacy.
