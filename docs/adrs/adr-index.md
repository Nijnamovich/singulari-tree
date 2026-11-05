---
id: adr-index
category: adrs
tags: [adr, hub, index]
aliases: [ADR Index, ADR List]
related: [adr-0014-docs-corpus-layout, adr-0015-docs-validator-generated-index, adr-0016-lane-state-and-graph-dod, adr-0017-docs-language-en, adr-0018-renderer-i18n-locale-switch, adr-0019-adr-translation-authorization, adr-0020-diff-per-file-and-hunk-staging, adr-0021-reset-modes, adr-0022-graph-context-menu-shell, adr-0023-commit-change-size-gauge, adr-024-multi-repo-workspaces, adr-025-deep-links-and-clipboard-clone, adr-026-cross-repo-commit-search, adr-027-git-flow-presets, adr-028-advanced-git-rpcs, adr-0029-file-status-screen, adr-0030-history-screen-is-compare-free, adr-0031-repository-relocation-and-missing-folder-recovery, adr-0032-history-commit-file-list-tooltip, adr-0033-commit-details-files-expandable-panel, adr-0034-retire-cross-repo-commit-search, adr-0035-commit-details-redesign-and-inline-hunk-actions, adr-0036-per-tab-fetch, adr-0037-windows-release-and-distribution, adr-0038-drop-macos-support-windows-and-linux-only, adr-0039-linux-release-and-distribution, adr-0040-per-repo-session-graph-selection-lock, adr-0041-forced-dependency-floors-and-electron-42, adr-0042-cherry-pick-and-branch-lens]
version: 1.16.0
status: active
---

# ADRs — Index

## What belongs here

**Structural or schema** decisions of this corpus: layout, note contract, validator, generated indexes. Append-only: an accepted ADR is not edited; if the decision changes, a successor is written with `supersedes`.

## Contents

- [[adr-0014-docs-corpus-layout]] — adopt the documentation-onrails corpus (`docs/` as root, `docs/project.md` as entry point).
- [[adr-0015-docs-validator-generated-index]] — custom zero-dependency validator + generated indexes with marker regions.
- [[adr-0016-lane-state-and-graph-dod]] — per-repo lane state in `GraphService` + graph DoD scoped to vertical columns (edge parity deferred).
- [[adr-0017-docs-language-en]] — adopt English as the documentation corpus language (supersedes ADR-0014 item 7).
- [[adr-0018-renderer-i18n-locale-switch]] — renderer i18n with an EN/ES locale switch via runtime `$localize` (English default).
- [[adr-0019-adr-translation-authorization]] — authorize a translation-only transform of historical ADR bodies (sole exception to append-only; no version bump).
- [[adr-0020-diff-per-file-and-hunk-staging]] — additive per-file `Diff` (`files` + `truncated`) and core-side hunk/line staging & discard (M2).
- [[adr-0021-reset-modes]] — `Reset` RPC with soft/mixed/hard, a `HARD` confirmation guard and `RESET_FAILED`.
- [[adr-0022-graph-context-menu-shell]] — renderer-only graph context-menu shell (Checkout / Compare / Copy SHA; V1.1 entries excluded).
- [[adr-0023-commit-change-size-gauge]] — `GetCommitStats` numstat counts cached in SQLite metadata only (never Git objects).
- [[adr-024-multi-repo-workspaces]] — repo tabs and multi-repo fetch are a renderer-only concept consumed from the core `repos` table (M3); its fetch fan-out is superseded by [[adr-0036-per-tab-fetch]].
- [[adr-025-deep-links-and-clipboard-clone]] — provisional `singularitree://` scheme, shell-side routing via `deeplink:open`, clipboard clone prefill (M3).
- [[adr-026-cross-repo-commit-search]] — `SearchCommits` over an indexed SQLite metadata table only, never Git objects (M3).
- [[adr-027-git-flow-presets]] — git-flow semantics live in core over the ADR-028 RPCs; config is SQLite metadata (M3).
- [[adr-028-advanced-git-rpcs]] — V1.1 branch CRUD, merge, tag CRUD and stash apply/pop/drop as append-only RPCs (M3).
- [[adr-0029-file-status-screen]] — renderer-only File Status screen (local / commit / PR variants) reusing GetDiff, GetBranches and the existing StatusStore; the diff is always on the right.
- [[adr-0030-history-screen-is-compare-free]] — History is a read-only commit overview (no panel below the graph); Compare becomes a navigation action to File status (refines ADR-0022's presentation, extends ADR-0029).
- [[adr-0031-repository-relocation-and-missing-folder-recovery]] — a moved/renamed repository folder is a named, recoverable state: `REPO_PATH_MISSING` vs `NOT_A_GIT_REPO` plus an additive `RelocateRepository` RPC that repoints the existing registration (no silent delete).
- [[adr-0032-history-commit-file-list-tooltip]] — the History aside gains a changed-file list tooltip next to "Review changes" — a **narrow** supersession of ADR-0030 that lifts only its "no file list" lock and repeals ADR-0031's item 7b refusal; compare stays in File status.
- [[adr-0033-commit-details-files-expandable-panel]] — the History aside's changed-file list becomes an **inline expandable panel** inside the commit-details body, superseding only ADR-0032's `st-popover` tooltip surface; the data source (`StatusStore` + `getDiff`) and the compare-free boundaries are unchanged.
- [[adr-0034-retire-cross-repo-commit-search]] — cross-repo local commit search is **retired end-to-end, with no replacement** (renderer view, `searchCommits` IPC channel, core service/cache query and the `SearchCommits` RPC + messages), superseding ADR-026; `commit_cache` stays as the graph metadata cache and the breaking contract change is recorded by the failing `buf breaking` check.
- [[adr-0035-commit-details-redesign-and-inline-hunk-actions]] — the commit-details panel becomes a header/description/files/footer surface (centred CTA, `GraphStore`-owned **selection lock** with a padlock, contextual `navMode`, an analyzer-only "show in graph" hand-off, and one **exclusive `description | files` switch** — default `description`, exactly one region mounted at a time, never both and never neither — replacing the two independent disclosures), and `st-diff-viewer` gains host-supplied **inline per-hunk actions** rendered in its own 5-column grid (Monaco suppressed) driving the unchanged ADR-0020 per-hunk RPCs; refines ADR-0033, renderer-only, and records the loss of the per-hunk unstage affordance. Its 2026-10-19 refinement makes the panel three regions (header, the only scrolling content, a collapsed-by-default metadata footer that is a sibling of the content) and moves the exclusive mode into a route-scoped `CommitViewModeService` shared by History and the analyzer.
- [[adr-0036-per-tab-fetch]] — the top-bar **Sync** fetches only the active tab and every other tab is fetched lazily when it becomes active (single-flight, session freshness, per-repository generation tokens); supersedes ADR-024's renderer-orchestrated fan-out while keeping the core a per-repo executor and the IPC contract unchanged.
- [[adr-0037-windows-release-and-distribution]] — the Windows desktop build ships only through GitHub Releases: a `v<version>` tag that matches `apps/electron/package.json` is built on `windows-latest`, packaged as the unsigned NSIS Setup and Portable executables, and published (never draft or prerelease) by a separate `contents: write` job that runs no repository build code; signing and action-SHA pinning are recorded as open debt.
- [[adr-0038-drop-macos-support-windows-and-linux-only]] — the desktop product ships for **Windows and Linux only**: the macOS packaging block, code paths and landing-page entries are dropped, ADR-0037's release pipeline is unchanged, and the Go core keeps its darwin build paths.
- [[adr-0039-linux-release-and-distribution]] — the `v<version>` tag now publishes **four** pinned unsigned assets (NSIS Setup + Portable `.exe`, AppImage + deb) from two read-only build jobs on `windows-latest` and `ubuntu-latest`, with the only `contents: write` job moved to `ubuntu-latest` still running no checkout, npm or Go; refines ADR-0037 and ADR-0038 by reference.
- [[adr-0040-per-repo-session-graph-selection-lock]] — the graph selection and the padlock survive tab switches and route destruction: a root in-memory `GraphSessionStore` keyed by `repoId` snapshots `selectedOid`/`lockedOid`/`lockedCommit`, `GraphStore.openRepository` restores the target repo's entry (a tab switch keeps the same store; only leaving `/repo` recreates it), only `select`/`lock`/`unlock`/`release` persist, and `WorkspacesStore.closeTab`/`reconcile` forget dead tabs; supersedes ADR-0035's clear-on-open promise by reference in all three places it appears — §6 bullet, Exit criterion and Examples diagram (ADR-0035 stays `active`).
- [[adr-0041-forced-dependency-floors-and-electron-42]] — four transitive packages are forced to **exact** root npm `overrides` (`dompurify` 3.4.17, `vite` 8.3.3, `joi` 18.2.9, `@vitest/mocker` 4.1.12) instead of ranges that re-resolve to registry-latest, and the Electron runtime moves to an exact `42.11.9` in lockstep with the `allowScripts` policy key and the provision script (Electron 42 ships no install script — the root `postinstall` provisions it); also records the root `@angular/compiler@22.2.3` devDependency hoist that makes a clean `npm ci` reproduce the Angular suite, and supersedes ADR-0038's Electron-41 runtime pin by reference while its Windows/Linux-only decision stands.
- [[adr-0042-cherry-pick-and-branch-lens]] — a nav-rail branch click becomes a **view-only lens** (`GetCommits.refs` walks `HEAD ∪ refs`, `in_refs` marks membership, the window bypasses the commit cache and lane state is keyed by `(repoId, canonical refSetKey)`) instead of a checkout, and the menu gains `CherryPick` / `Revert` as one-bare-revision, resolve-then-mutate RPCs that send only the resolved oid, surface conflicts as `{has_conflict, oid}` data plus typed trailers (35–38), clear the sequencer with `--skip` before reporting an empty pick, and defer `Rebase children` with a written re-entry condition; supersedes ADR-0022 item 3 and ADR-028's cherry-pick/revert exclusion by reference, and ADR-0016 item 3 inside a lens only.

## Elsewhere

ADR-001..ADR-013 live embedded in `docs/context/git-client/decisions.md` (legacy — see `accepted-debt.md`). Numbering continues at **ADR-043** (last used: ADR-0042). Existing filenames are mixed: the older `adr-024`…`adr-028` are unpadded, `adr-0029` and later are padded; new files follow the padded form and **existing files are never renamed**.
