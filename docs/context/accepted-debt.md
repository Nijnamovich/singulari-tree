---
last_updated: 2026-10-22
status: active
description: Accepted debt of the corpus — legacy documents not yet migrated and explicitly tolerated decisions, with the criterion to reduce it.
tags:
- documentation
- debt
- legacy
- ratchet
version: 1.11.0
related:
- documentation-system
---

# Accepted Debt

## Problem

Not the whole corpus complies with the onrails contract. Migrating the legacy design and extracting embedded ADRs in bulk (big-bang) would generate enormous noise, break references and halt real work. At the same time, silently tolerating non-compliance turns the corpus into something untrustworthy: nobody knows which exceptions are intentional and which are oversights.

## Solution

Record here **every exception explicitly**, with its reason and the criterion to reduce it. Exceptions are frozen ("ratchet"): the corpus contract only applies to new or touched files; a legacy document is migrated **when it is touched**, not before.

| Accepted item | Why it is tolerated | How it is reduced |
|---|---|---|
| `docs/context/git-client/**` — 13 content docs (`architecture.md`, `decisions.md`, `module-diagram.md`, `service-design.md`, `domain-model.md`, `folder-structure.md`, `roadmap-mvp.md`, `roadmap-v1.md`, `risks.md`, `ipc-strategy.md`, `testing-strategy.md`, `github-oauth-guide.md`, `github-real-data-guide.md`) + non-kebab hub `INDEX.md` + `README.md` alias | No frontmatter and a non-`kebab-case` hub; **EXCLUDED from the validator** (`docs/context/git-client/**` frozen). `roadmap-mvp.md` was already **migrated by ratchet on touch** (`context-doc` frontmatter), but the rest of the tree remains frozen and outside the scan. | Ratchet: migrate each file only when touched (frontmatter + rename hub when applicable); `roadmap-mvp.md` is already migrated. A pure translation is a content transform and does not by itself trigger the ratchet's contract-migration obligation — it changes prose, not shape (no frontmatter, no hub rename) — so the frozen tree remains excluded from the validator. |
| Lane edge visual parity (diagonals/crossings) vs `git log --graph` — Week 1-2 DoD bounded (ADR-0016) | The `Lane{index,color,continues}` wire contract does not carry edge geometry; only **vertical columns** are contracted (correct and continuous across windows). No contract change — deliberate decision (Option B). | Future addition of a `LaneRow`/segment contract + SVG diagonals in the renderer, **behind an ADR** that supersedes [[adr-0016-lane-state-and-graph-dod]]. |
| ADR-001..ADR-013 embedded in `docs/context/git-client/decisions.md` | They are not extracted into `docs/adrs/` to avoid a 13-file big-bang. | Numbering continues at **ADR-042**; new ADRs are born in `docs/adrs/` with their hub. |
| `README.md` (root) | Human README, **no frontmatter**, OUTSIDE the corpus. | Kept as a pointer to the entry point ([`docs/project.md`](../project.md)); it is not migrated. |
| `docs/context/git-client/README.md` | Alias of the legacy hub `INDEX.md`. | Disappears when the legacy hub is migrated/normalized on touch. |
| UNSIGNED package (no signing/notarization/auto-update) | Explicit MVP scope: signing and `electron-updater` are V1 (`roadmap-v1.md` §V1.4). | V1.4 phase: Windows signing, signed flatpak/AppImage, auto-update. |
| e2e of 2 OSes via GitHub Actions (`ubuntu-latest` + `windows-latest`) — no validation on a local Windows station. | The `roadmap-mvp.md` L104 criterion requires "e2e smoke passes on 2 OSes" and no 2-OS station is declared; the workflow is the minimal verifiable mechanism. The Windows-specific branches (`go-core.exe`, no symlinks) are reasoned but **not executed** on this Linux host. | Run the workflow on real CI; if Windows fails, adjust the shim/build script and re-verify. |
| No `git:unwatch` — the `git:watch` server-stream persists for the last-opened repo until another repo is opened or the app quits (M1.5/M2). | The stream is replace-any-existing and bounded to a single repo, so it cannot accumulate; an explicit unsubscribe channel is not yet wired. | Add a `git:unwatch` channel (or cancel-on-navigate) so the stream is released when the repo view is left. |
| `buf` breaking check is SKIPPED when `buf` is not installed (`tools/ci/verify-contracts.sh` prints "buf not found — skipping"). | The host lacks `buf`; the ADR-020/021/023 proto change was additive-only and hand-verified, so no wire break was introduced. | Ensure `buf` is present in CI so `verify-contracts.sh` actually runs the breaking check instead of skipping it. |
| Branch/tag mutations reuse `BRANCH_NOT_FOUND` / `TAG_NOT_FOUND` for generic failures (the real reason travels in `AppError.details`); no dedicated `*_FAILED` codes yet. | [[adr-028-advanced-git-rpcs]] defined only `*_EXISTS` / `*_NOT_FOUND`; the M3 branch/tag mutations reuse the not-found codes when a generic git failure occurs, keeping the underlying message in `details`. | Append dedicated `BRANCH_FAILED` / `TAG_FAILED` codes after the current last code when a concrete need appears (append-only, per ADR-028). |
| `StashApply` / `StashPop` conflicts surface as `STASH_FAILED` and leave the working tree conflicted; there is no stash-conflict code yet. | M3 stash apply/pop land on [[adr-028-advanced-git-rpcs]], which defines no conflict code for stash; a conflicted apply is reported through the generic failure code. | Add a dedicated stash-conflict code (append-only) when the renderer needs to distinguish it from a generic failure; surface `GetStatus.is_conflicted` in the meantime. |
| Monaco's ESM stylesheet side-bundles are still emitted as unreferenced CSS files (~659 KB of dead output) | **The delivery gap is closed** (2026-10-22): `apps/angular/angular.json` carries a second `styles` entry — `node_modules/monaco-editor/min/vs/editor/editor.main.css` with `bundleName: "monaco"` and `inject: false` — which emits a stable, unhashed `monaco.css` (390,830 B) **outside** the initial bundle, and `ensureMonacoCss()` in the lazy Monaco path appends `<link rel="stylesheet" data-st-monaco-css>` (resolved against `document.baseURI`) before `createDiffEditor`. Measured: initial total `559.10 kB` (from ~558.6 kB, still well under the 600 kB warning, no budget change) and `index.html` does not link `monaco.css`. What remains is the **build output**: `@angular/build` 22.2.3 drops esbuild's `cssBundle` associations, so Monaco's ESM `import '*.css'` side effects are still emitted as orphan `chunk-*.css` / `main-*.css` files (~659 KB: one 99,224 B and three 186,536 B files) that nothing references. They are **not** part of the initial payload and are not fetched, so the waste is disk/output only — safe but pointless. | Reduce by a builder upgrade or an upstream fix that collects esbuild `cssBundle` associations, then confirm no unreferenced `chunk-*.css` / `main-*.css` remains in `apps/angular/dist/browser`. Regression guards while the orphan output exists: the `angular.json` config spec, the jsdom loader spec and the Electron e2e assertion that `<link data-st-monaco-css>` exists and that the largest `.monaco-editor` computes `position: relative`, `.overflow-guard` computes `overflow: hidden` and has height > 100 px. |
| GitHub UI settings — the 9 human-only items in [`docs/context/repository-configuration.md`](./repository-configuration.md) § Layer 2 (default workflow-token permission, branch protection, tag rulesets, secrets/variables, environments, Pages source, Actions policy, security features, release access/retention) are **not applied** and are **not readable from a checkout**. | No workflow needs them today: the repository already declares least privilege per workflow (`contents: read` at workflow level, `contents: write` only in the publish job), so the UI default is a backstop rather than the primary control, and the first real release is the proof. | Reduced when the maintainer applies and verifies the Layer 2 checklist in the GitHub UI and the first published release proves the pipeline — branch protection, `v*` tag rules, a `release` environment and the read-only workflow-token default are then verified in the UI, not assumed. Remove this row once each Layer 2 item is verified. |

**What is NOT debt** (complies with the contract and must be validated):

- `docs/project.md` — agent-facing entry point.
- `docs/slices/` — slices and their hub `slices-index.md`.
- `docs/protocols/` — corpus protocols.
- `docs/adrs/` — new decision records (ADR-014 onward).
- Generated artifacts `docs/index.md` and `docs/tag-index.md`.

## When to use

- Before "fixing" a legacy file: confirm whether its exception is already here.
- When adding a new temporary exception: add a row with its reason and its exit criterion.

## When not to use

- To justify new non-compliance: a new or touched note **must** comply with the contract (see [[documentation-system]]).
- For files already listed under "What is NOT debt".

## Examples

- A PR that fixes a typo in `docs/context/git-client/risks.md` only adds frontmatter if it also normalizes the file; otherwise it does not enter the validator.
- A PR that creates a new ADR uses `docs/adrs/adr-0014-<slug>.md` and registers it in the `adr-index.md` hub.

## Common mistakes

- Migrating `docs/context/git-client/**` in bulk "to leave it clean" — the ratchet forbids it.
- Extracting ADR-001..ADR-013 into `docs/adrs/` — deliberately avoided (big-bang).
- Adding frontmatter to the root `README.md` or the `git-client/README.md` alias.
- Forgetting to remove a row once the debt is settled.

## References

- How the corpus and the ratchet work: [[documentation-system]]
- Project entry point: [docs/project.md](../project.md)
