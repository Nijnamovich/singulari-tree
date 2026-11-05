---
last_updated: 2026-10-21
status: active
description: Feature-gap analysis of SingulariTree against SourceTree and GitKraken (REA-assisted), with a prioritized, anti-goal-checked development-continuation recommendation.
tags:
- roadmap
- feature-gap
- git-client
version: 1.6.10
related:
- accepted-debt
- documentation-system
---

# Feature-Gap Analysis — SourceTree & GitKraken vs SingulariTree

## Problem

The human asked how to continue SingulariTree's development, using SourceTree and GitKraken as reference desktop Git clients and REA as the reverse-engineering methodology. M1 landed: the MVP's own core flow (status / stage / commit plus the Monaco diff viewer) and a real `fsnotify` watcher are implemented. M2 has since landed too — working-tree safety (per-file `Diff`, hunk/line staging and discard, reset modes) and graph actions (context-menu shell, change-size gauge) — and M3 has now landed as well (multi-repo workspaces, cross-repo commit search, git-flow presets, deep links, and the V1.1 branch/merge/tag/stash operations). New feature ideas must not displace the next gate. There is no single place recording the cross-app gap, the admissibility of each candidate against the anti-goals, or the priorities that follow.

## Solution

### (a) Method and REA feasibility decision

REA v5.0.0 runs on Node 26 here. REA is a local, read-only static-inspection tool (no app execution); it is used only to mine feature ideas, not to copy code or assets. Public vendor documentation was used as the primary source and REA as supporting evidence. Legal note: reverse-engineering may be restricted by the apps' terms of service, so REA stays an idea-mining aid and reference-app code/assets are never redistributed.

- **SourceTree 3.4.32 (Windows/.NET-WPF under Wine): FEASIBLE and executed.** `inspect-managed-artifact` confirmed a managed .NET Framework PE (CIL, x86, anycpu); `inspect-managed-members` on `SourceTree.exe` yielded 197 types / 1913 methods, revealing feature modules: repo tabs (`RepoTabPanel`), URL actions (`UrlActionClone` / `OpenExisting` / `CheckoutExistingPanel`), `CustomActionsManager`, Preferences (Diff / Git / Network / Authentication / CustomActions), `AccountManager` / `HostedAccount`, security SSH key managers (`PageantSshKeyAgent`, `OpenSSHSshKeyAgent`, `DefaultSshKeyManager`), `SchedulerManager` (background remote refresh), `DownloadManager`, and accessibility automation peers.
- **GitKraken 12.6.0 (Electron): full-ASAR REA analysis NOT feasible on this host.** The bundled 299 MB `app.asar` (which embeds a portable `git`, `/git/libexec/git-core/*`) drove Node past its default heap and OOM-aborted (~200 s). Cheap inventory IS feasible: `@electron/asar list` enumerated 53,140 entries; the app's own code is `/src` (157 JS/TS) plus `/node_modules/@axosoft/*`. A targeted re-run on the extracted `/src` subtree (662 files, 51 MB) was attempted as a workaround. GitKraken capability data below is therefore taken from public vendor documentation, with REA reserved for the SourceTree evidence.

### (b) Current implemented baseline (verified in code)

- **Implemented:** RepoService Open / List / Remove; GetCommits; GetBranches; GetRemotes; GetTags; Checkout; StashPush; Fetch / Push / Pull (streaming); GraphService lanes; CacheService; AuthService (GitHub via `gh` CLI); GetStatus; per-file `Diff` (`FileDiff files` + `truncated`, `GetDiffRequest.path` / `staged`); Stage / Unstage / Commit; hunk- and line-level staging / unstaging / discarding plus file-level discard (Commit Composer); Reset soft / mixed / hard (`Reset` RPC, `RESET_FAILED`); `GetCommitStats` numstat counts cached in SQLite `commit_stats` (migration `002_commit_stats.sql`, lazily per visible window); real `fsnotify` watcher (`repo:changed` / `fs:changed`, `.git`-as-gitfile aware) and the `Watch` → `git:watch` → renderer `fs:changed` stream. Renderer: virtualized graph + filter + commit details + WIP row; repos list; fetch / pull / push; sidebar branches / tags / remotes; StatusStore + changes/commit panel; hunk/line staging Composer; graph right-click context-menu shell (Checkout / Compare / Copy SHA, plus Reset); commit change-size gauge; real Monaco `DiffViewer` (lazy-loaded); settings (theme, en/es). M3 landed: branch CRUD (`CreateBranch` / `RenameBranch` / `DeleteBranch`), `Merge` (MERGE / NO_FF / FF_ONLY / SQUASH; conflicts surfaced, not resolved — no 3-way editor), tag CRUD (`CreateTag` / `DeleteTag`), `GetStashes` un-stubbed plus `StashApply` / `StashPop` / `StashDrop`, and the append-only error codes `MERGE_CONFLICT=28`, `MERGE_FAILED=29`, `TAG_EXISTS=30`, `TAG_NOT_FOUND=31`, `GIT_FLOW_FAILED=32`; renderer UI for all of these plus the graph context-menu "Create branch here" / "Tag this commit" and a merge-conflict banner; multi-repo Workspaces / repo tabs (renderer-only UI-state) with a per-tab fetch model — the top-bar **Sync** fetches only the active tab and every other tab is fetched lazily on activation ([[adr-0036-per-tab-fetch]], superseding ADR-024's fan-out); cross-repo commit search over the SQLite `commit_cache` metadata only plus the renderer WORKSPACE `search` view (**both retired by [[adr-0034-retire-cross-repo-commit-search]]**); git-flow presets (`GetGitFlowConfig` / `SetGitFlowConfig` / `StartGitFlow` / `FinishGitFlow`, migration `003_git_flow_config.sql`) plus a git-flow panel; and deep links (`singularitree://`) with the shell single-instance/protocol client, the `deeplink:open` event, renderer routing (open repo / commit / branch / clone-prefill) and clipboard clone / copy-repo-URL (clone itself is prefill-only, V1.4) — [[adr-024-multi-repo-workspaces]], [[adr-025-deep-links-and-clipboard-clone]], [[adr-026-cross-repo-commit-search]], [[adr-027-git-flow-presets]], [[adr-028-advanced-git-rpcs]].
- **NOT implemented (stubs / Unimplemented):** `GetWorktrees` (stub); `StreamCommits` IPC streaming; worktrees; GitHub OAuth; the 3-way conflict editor (M3 surfaces conflicts only); clone/onboarding (V1.4).

### (c) Gap analysis

SourceTree — `In SingulariTree?` ∈ {Have, Planned MVP-V1, Missing}.

| Capability | In SingulariTree? | Verdict |
|---|---|---|
| Interactive rebase, merge, branch CRUD, tag CRUD | Planned MVP-V1 | drop-as-planned |
| Worktrees CRUD, stash apply/pop/drop, submodules, LFS | Planned MVP-V1 | drop-as-planned |
| Remote CRUD, SSH/HTTPS auth, external diff tool, packaging, clone/onboarding | Planned MVP-V1 | drop-as-planned |
| Repo tabs / simultaneous multi-repo (multi-repo *management* already exists: repos list, MVP W7) | Missing (tabs / simultaneity only) | new candidate |
| Custom Actions (parameterized commands) | Missing | new candidate |
| URL / deep-link + clipboard-clone | Missing | new candidate |
| git-flow presets | Missing | new candidate |
| Cross-repo commit search | Missing | new candidate |
| Bookmarks / favorites grouping | Missing | new candidate |
| Multi-host account manager | Missing | new candidate |
| Periodic background remote refresh | Missing | new candidate |
| Global / custom gitignore | Missing | new candidate |
| Discard at hunk / line granularity | Missing | new candidate (landed in M2 — see (f)) |

GitKraken — same columns.

| Capability | In SingulariTree? | Verdict |
|---|---|---|
| Solo/focus view (⊂ V1.2 filter), dim merge commits (⊂ V1.2) | Planned MVP-V1 | drop-as-planned |
| Interactive rebase, blame/file history, bisect, reflog | Planned MVP-V1 | drop-as-planned |
| Keyboard nav, zoom/minimap, signed commits | Planned MVP-V1 | drop-as-planned |
| Commit change-size gauge ("changes" column) | Missing | new candidate (landed in M2 — see (f)) |
| Graph right-click context menu shell (reset soft/mixed/hard, compare two refs, copy SHA/link) — only the shell and reset/compare/copy-SHA are new; the menu's cherry-pick/revert/tag entries are V1.1-planned | Missing | new candidate (shell + reset/compare/copy-SHA) (landed in M2 — see (f)) |
| Customizable graph columns | Missing | new candidate |
| Multi-repo Workspaces + per-tab sync / lazy per-tab fetch | Missing | new candidate (landed in M3 — see (f)) |
| Launchpad PR/issue inbox | Missing | new candidate |
| Commit Composer (hunk/line commit crafting) | Missing | new candidate |
| Stashes as graph nodes | Missing | new candidate |
| Undo/redo of Git operations | Missing | new candidate |
| AI features via MCP | Missing | new candidate |

### (d) Prioritized new feature ideas

The five landed rows below are the items §(f) records as delivered: the four P1 rows marked *landed (M2)* are governed by [[adr-0020-diff-per-file-and-hunk-staging]], [[adr-0021-reset-modes]], [[adr-0022-graph-context-menu-shell]] and [[adr-0023-commit-change-size-gauge]], and the post-M3 History-screen row by [[adr-0030-history-screen-is-compare-free]]. They are kept here for traceability, not as open work.

| Idea | Primary slice | Secondary slices | Anti-goal check | Depends on (unimplemented) | Priority |
|---|---|---|---|---|---|
| Discard at file/hunk/line granularity | core | contracts, renderer | none (Git stays in core) | GetStatus, GetDiff (MVP) | landed (M2) — see (f) |
| Hunk/line staging (Commit Composer) | core | contracts, renderer | none | GetStatus, GetDiff, Monaco (MVP) | landed (M2) — see (f) |
| Graph right-click context menu shell (checkout / compare / copy SHA now; create-branch-here / cherry-pick / revert / tag wire once V1.1 lands) | renderer | core, contracts | none (routes to IPC→core) | V1.1 ops + GetDiff | landed (M2) — see (f) |
| Reset (soft/mixed/hard) | core | contracts, renderer | none | read path | landed (M2) — see (f) |
| History screen is compare-free; comparison redirects to the File status screen (ADR-0030) | renderer | docs | none (renderer-only; reuses GetDiff/DiffViewer, no new RPC/IPC/Core) | none (ADR-0029 File status screen landed) | landed — see (f) |
| Multi-repo Workspaces / repo tabs + per-tab sync (lazy per-tab fetch) | renderer | core, desktop-shell | none | Fetch (have); stable multi-repo state | landed (M3) — see (f) |
| Cross-repo local commit search | core | renderer, contracts | metadata cache only, never Git objects (ADR-006 OK) | real fsnotify watcher | P2 |
| Commit change-size gauge (numstat stats) | core | contracts, renderer, tooling | counts only, no blobs (ADR-006 OK) | GetCommits window + caching | P2 |
| git-flow workflow presets | core | renderer, contracts | none | V1.1 branch/merge/tag | P2 |
| Deep links / OS protocol handler + clipboard clone URL | desktop-shell | renderer, core | shell routes only, never runs Git | clone is V1.4 onboarding | P2 |
| Undo/redo of Git operations (operation journal) | core | contracts, renderer | metadata journal (ADR-006 OK) | V1.1 reset/checkout + reflog read | P2 |
| Custom Actions (user-defined parameterized commands) | core | contracts, renderer | MUST run in core with consent/allowlist, never renderer | — (needs ADR) | P3 |
| Bookmarks / favorites grouping | renderer | core | metadata only (ADR-006 OK) | — | P3 |
| Multi-host account manager (GitLab/Bitbucket/Azure DevOps) | core | contracts, renderer | external SaaS from core, no app backend | OAuth, V1.3 credential helper | P3 |
| Periodic background remote refresh | core | desktop-shell, renderer, contracts | network via core | real watcher/cache invalidation | P3 |
| Global/custom gitignore management | core | renderer, contracts | file writes in core | — | P3 |
| Customizable graph columns | renderer | core | none | graph exists | P3 |
| Stashes as graph nodes | core | contracts, renderer | none | GetStashes (Unimplemented) | P3 |
| PR/issue inbox (Launchpad) + GitHub/GitLab PR integration | core | contracts, renderer, desktop-shell | external SaaS from core, no app backend | multi-host accounts + OAuth | P3 |
| AI-assisted features (commit message, conflict resolution, explanations) | core | contracts, renderer, docs | via optional MCP (ADR-013); no bespoke cloud proxy | MCP-B + mutation RPCs | P3 |

### (e) Rejected / deferred ideas

- **Cloud Patches / Code Suggest / hosted sync — REJECT as specified.** It requires a SingulariTree-operated cloud backend, which does not exist (grounded in ADR-006, which rejects a server-backed store, and ADR-001, which keeps the core headless with no app-operated backend). Any revival must be an optional outbound core adapter using user-owned credentials.
- **Any renderer/preload-side Git, `.git` reads, user shell, or direct host-API calls — REJECT.** It violates anti-goal #1 (the renderer never talks to Git) and ADR-005 (contextIsolation / sandbox / CSP).

### (f) Recommended continuation

- **M1 (landed, P0): the MVP core flow is closed.** Core GetStatus → Stage/Unstage → Commit plus GetDiff (`apps/go-core/internal/adapter/git/adapter.go`) and the renderer StatusStore / commit box + lazy-loaded Monaco diff viewer + real fsnotify watcher (`apps/go-core/internal/adapter/watcher/watcher.go`) are implemented; the `stage → commit → diff` e2e `test.skip` was replaced by a real passing Playwright test and the two settled accepted-debt rows were removed. It was the MVP's own missing flow, a recorded accepted debt, and the prerequisite for nearly every new idea above (discard, reset, hunk staging, compare, undo/redo, change gauge). **M2 followed and has now landed (see below).** The remaining M1 limitation — a flattened `Diff` with no per-file/path addressing — is resolved by [[adr-0020-diff-per-file-and-hunk-staging]] (M2), and the corresponding accepted-debt row is removed.
- **M2 (landed, P1): working-tree safety and graph actions.** Per-file `Diff` plus hunk/line stage + discard, Reset soft/mixed/hard, graph context-menu shell (checkout / compare / copy-SHA, plus Reset), and the commit change-size gauge — [[adr-0020-diff-per-file-and-hunk-staging]], [[adr-0021-reset-modes]], [[adr-0022-graph-context-menu-shell]], [[adr-0023-commit-change-size-gauge]]. The shell's create-branch-here / tag entries were to light up after the V1.1 ops; M2 shipped the shell with the checkout / compare / copy-SHA actions. **M3 followed and has now landed (see below).**
- **M3 (landed, P2): multi-repo Workspaces/tabs + per-tab sync / lazy per-tab fetch ([[adr-0036-per-tab-fetch]]), cross-repo commit search, git-flow presets and deep links/clipboard clone, plus the V1.1 branch CRUD / merge / tag / stash the presets consume** — [[adr-024-multi-repo-workspaces]], [[adr-025-deep-links-and-clipboard-clone]], [[adr-026-cross-repo-commit-search]], [[adr-027-git-flow-presets]], [[adr-028-advanced-git-rpcs]]. The graph context-menu shell now lights up its create-branch-here / tag-this-commit entries; merge conflicts are surfaced (banner, `has_conflict`, `GetStatus.is_conflicted`), not resolved — the 3-way editor remains open. Deep links route to existing per-repo IPC and clone is prefill-only (V1.4).
- **History screen is compare-free (landed, P1, post-M3): the History screen became a read-only commit overview and comparison moved to File status** — [[adr-0030-history-screen-is-compare-free]]. `RepoPage` no longer mounts `st-status-workspace` below the graph (the fixed 260px `.st-repo-page__status` band and `status-workspace.ts` are gone), so the selection-coupled first-parent diff went with the panel; the selected-commit aside renders only `commit-details-panel` (general characteristics, no file list / diff / stats). The inline compare modal and `GraphStore`'s `compare` / `compareDiff` / `compareLoading` / `compareError` state plus `compareCommits` / `clearCompare` are removed; "Compare with selected" is now a navigation shortcut reusing the "File status" hand-off (`GraphStore.select(oid)` then route to `/repo/file-status`) and stays disabled for the synthetic WIP row. Three mechanisms that lived only in the deleted band were re-homed: the `git:watch` kickoff into `GraphStore.openRepository` (`startWatch`, `graph.store.ts`), the graph half of `RepoState.statusRefreshRequested` into `RepoPage` and its working-tree half into `FileStatusPage` (`refreshForExternalChange()`), and `fs:changed → graph.reload()` into `RepoPage`. `StatusStore.loadCommitDiff` is kept as a store capability with no graph-selection consumer. Renderer-only — no new RPC, IPC channel or Go-core change. This post-M3 work is not part of the M-numbering above and is recorded here on landing. **Update ([[adr-0032-history-commit-file-list-tooltip]]):** the compare-free contract is narrowed — the History aside shows a changed-file list sourced from `StatusStore` + the existing `getDiff`, so the store's commit-diff read has a graph-selection consumer again while the diff itself stays in File status. Same renderer-only posture (no new RPC, IPC channel or Go-core change). **Superseded in part ([[adr-0033-commit-details-files-expandable-panel]]):** ADR-0032 surfaced that list as a `st-popover` tooltip; its *surface* is now an **inline expandable panel** inside the commit-details body, so `st-popover` is no longer consumed in the History aside. The data source (`StatusStore` + `getDiff`), the read-only contract and the compare-free boundaries are unchanged.
- **Commit-details redesign + inline hunk actions (landed, renderer/ui-kit):** the selected-commit panel became a header/description/changed-files/metadata surface with an independent collapsible file block (literal-substring name filter, accurate count), a `GraphStore`-owned selection lock (padlock) that spans `/repo` ↔ `/repo/file-status`, a `navMode` contextual action and an analyzer-only "show in graph" hand-off, and `st-diff-viewer` gained host-supplied inline per-hunk actions rendered in its own 5-column grid (Monaco suppressed) that address the existing [[adr-0020-diff-per-file-and-hunk-staging]] per-hunk RPCs — [[adr-0035-commit-details-redesign-and-inline-hunk-actions]], refining [[adr-0033-commit-details-files-expandable-panel]]. **Recorded reduction:** per-hunk unstage is no longer surfaced (the viewer renders one diff, the worktree one); file-level unstage remains. **Refused:** pre-setting the Branch comparator (PR variant) with the locked commit — `FileStatusStore.openPr` diffs base ↔ target branches and has no commit input, so it would need a new RPC. Renderer-only: no new RPC, IPC channel or Go-core change. **Update (2026-10-17; refined 2026-10-19):** the panel's two independent disclosures became **one exclusive switch** — exactly one of {description, changed files} is visible (default `description`); the panel forces `files` and disables its `description` segment for a commit with no message at all (a subject-only commit stays selectable). On **2026-10-19** the switch and mode were reworked: the analyzer's description region now lives in the panel (subject + body, `showSubject=true`) and, since **2026-10-20**, the panel is the analyzer's whole commit view — it also owns the `files` region (paths-only changed-file list with selectable rows, so the right-pane diff stays reachable) and its metadata footer closes the column, while the page renders no summary or `st-file-diff-list` in that variant and the forced-`files` rule for a message-less commit lives only in the panel's `effectiveMode` (the page-level `effectiveAnalyzerMode` is gone) — the route-scoped `CommitViewModeService` is shared across `/repo` ↔ `/repo/file-status` and resets on a repository change, the panel is three regions with a collapsed-by-default metadata footer that is a sibling of the only scrolling content, and the padlock gained a delayed `role="tooltip"` explanation (`aria-describedby` through the ui-kit's additive `ariaDescribedby`). Same renderer-only posture.
- **Next (not yet scheduled):** worktrees and `GetWorktrees`, `StreamCommits` IPC streaming, GitHub OAuth, the 3-way conflict editor, clone/onboarding (V1.4), and the P3 candidates above (undo/redo, Custom Actions, multi-host accounts, background refresh, gitignore, PR inbox, AI/MCP).
- **Process:** do NOT hand-edit the frozen `docs/context/git-client/roadmap-mvp.md` / `roadmap-v1.md` (ratchet; touching forces migration). Record this analysis here. When the human blesses a direction, open append-only ADRs continuing at **ADR-040** for the structurally significant decisions (hunk staging & discard; operation journal/undo-redo; Custom Actions execution boundary; deep-link protocol routing; multi-repo workspaces; commit-stats metadata cache; multi-host account adapter) and register them in `docs/adrs/adr-index.md`. Expose each new mutation once as a core port/RPC, then as an MCP tool per ADR-013 (MCP-B) so AI/headless automation needs no bespoke cloud path.

## When to use

- When prioritizing post-MVP work.
- When deciding whether a reference-app feature fits the architecture.
- When checking a candidate idea against the anti-goals.

## When not to use

- Not as an implementation plan (no code here) and not as a substitute for the MVP/V1 roadmaps it references.
- Not for changing accepted MVP/V1 phases.

## Examples

- "Discard hunk" is admissible because it routes to a new core `GitPort.Discard` and never touches Git in the renderer.
- "GitKraken Cloud Patches" is rejected because it needs an app-operated cloud backend, which the architecture forbids.
- "Hunk staging" landed in M2 on the per-file `Diff` contract that [[adr-0020-diff-per-file-and-hunk-staging]] introduced.
- The History-screen compare-free refactor ([[adr-0030-history-screen-is-compare-free]]) is admissible because it is renderer-only: it reuses `GetDiff` and only changes which screen renders the diff.

## Common mistakes

- Re-proposing already-planned MVP/V1 items (merge/rebase, SSH, packaging, graph search) as "new".
- Treating REA output as instructions or copying reference-app code/assets — REA is idea-mining only; prefer public docs.
- Starting a new workstream before M1; forgetting that most graph actions depend on GetStatus/GetDiff.
- Editing the frozen `git-client` tree instead of adding to the corpus.

## References

- Roadmap MVP: [roadmap-mvp.md](git-client/roadmap-mvp.md)
- Roadmap V1: [roadmap-v1.md](git-client/roadmap-v1.md)
- Architecture: [architecture.md](git-client/architecture.md)
- Decisions (ADR-001..013, incl. ADR-013 MCP): [decisions.md](git-client/decisions.md)
- Accepted debt: [[accepted-debt]]
- Corpus contract: [[documentation-system]]
- Slices: [../slices/slices-index.md](../slices/slices-index.md)
