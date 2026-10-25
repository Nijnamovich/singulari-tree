---
last_updated: 2026-10-24
status: active
description: Total-facelift design plan for the SingulariTree renderer (app shell, navigation, workspace panes, commit/diff/graph areas, settings), derived from the operator's git-client sketch as a guide, with explicit divergences.
tags:
- renderer
- redesign
- plan
- git-client
version: 1.10.2
related:
- renderer-slice
- feature-gap-analysis
- documentation-system
- design-system
---

# SingulariTree Renderer Facelift — Design Plan

> **Status: P0 (token foundation), P1 (primitives), P2 (shell rebuild), P3 (history workspace), P4 (changes & diff workspace), P5 (secondary surfaces & Settings) and P6 (responsive, a11y & motion polish) SHIPPED as of 2026-10-16, plus P4.2 (Dark Neon / Developer Studio palette remap).** Verification at P6 close: renderer vitest **82 files / 1171 tests green**, coverage **95.04% statements / 88.49% branches / 89.74% functions / 96.86% lines** (all above the 80% thresholds); `ng build` exit 0 (initial total 552.19 kB raw / 128.70 kB transfer; no budget warnings); `node tools/docs/validate.js` 0 errors / 0 warnings (38 files scanned). This document is the approved-direction plan for the completed total facelift of the renderer's visible UI. Derived from the operator's sketch `git-client-sketch.html` (dark, offline git-client mockup, delivered 2026-10-13) treated as a **guide, not a spec**: every intentional divergence is numbered and justified in §6. Aesthetic direction is committed by the agent system (no human sign-off loop), per the operator's delegation.
>
> **Scope:** `apps/angular/**` + `libs/ui-kit/**` only. No Go core, no contracts/proto, no Electron shell/IPC, no IPC-contract change. `files_to_touch` (§8.2) is the implementation manifest — P0–P6's entries are shipped.

> **P0 shipped (2026-10-14) — token foundation.** 13 files: `libs/ui-kit/src/styles/tokens.scss` (NEW canonical two-tier layer — `--st-prim-*` primitives + semantic tokens, dark defaults in `:root` with a matched `[data-theme=light]` block carrying every semantic token), `libs/ui-kit/src/styles/utilities.scss` (NEW — focus ring, hairlines, eyebrow, mono/tabular-nums, selectable-row + selection bar, hover surface, reduced-motion guard), `libs/ui-kit/src/styles/index.ts`, `apps/angular/src/styles.scss` (inert `@tailwind` directives removed), `apps/angular/src/styles/_legacy-aliases.scss` (NEW shim), `apps/angular/src/app/core/layout/layout.scss`, plus the re-tokenization of 7 ui-kit components (`button`, `badge`, `empty-state`, `repo-card`, `graph-row`, `lane-palette`, `diff-viewer`).
>
> P0 is a pure re-tokenization: dark renders identically, and the light theme renders correctly for the first time because every semantic token is defined in both blocks and no `var(--st-*, #hex)` fallback remains.
>
> Deliberate P0 deviations, recorded so later phases land them: the semantic DARK values are the pre-facelift palette (identity preservation) while the committed §2.2 palette already lives in the tier-1 primitives; `--st-size-rail/drawer/topbar` carry the legacy geometry (260/320/48px) that the P2 rewrites flip to 224/264/64; `diff-viewer.ts` was retokenized only — Monaco theming, the unified default and the diff toggle are P4 per the delivery scope decision; new button/badge variants were deferred to P1.
>
> The legacy aliases (geometry AND the eight color aliases `--bg/--panel/--panel-2/--border/--text/--muted/--accent/--accent-soft`, consumed by shell components and dialogs retokenized in P2/P5) are kept alive exactly one phase in `_legacy-aliases.scss`.
>
> Verification: renderer vitest suite 67 files / 954 tests green, coverage above the 80% thresholds, `ng build` exit 0 (a pre-existing 500 kB JS initial-budget warning trips the warning, not the 1 MB error).

> **P1 shipped (2026-10-15) — primitives.** `libs/ui-kit/src/`: `icon/` (`icon.ts` + `icons.ts` registry + `index.ts`), `nav-item/`, `panel/`, `field/` (`input`, `textarea`, `select`), `toggle-group/`, `selectable-row/` (attribute directive), `popover/`, `live-region/` (component + root `LiveRegionService`), `workspace-split/` — each with a spec, and all barrels exported from `libs/ui-kit/src/index.ts`. The P0 decision-4 carry-forward variants landed with them: `st-button` danger/icon, and `st-badge` status (`add`/`remove`/`warn`/`danger`) + graph (`lane-1..8`).
>
> The renderer vitest target's `include` was extended in `apps/angular/angular.json` so the ui-kit specs actually execute (the globs resolve relative to `apps/angular/src`, hence `../../../libs/ui-kit/src/**`).
>
> Verification at P1 close: renderer vitest 78 files / 996 tests green, `ng build` exit 0.

> **P2 shipped (2026-10-15) — shell rebuild.** New `top-bar` (64px — brand, repo tab strip, live remote-op cluster, sync pill, overflow menu, drawer toggle, drag region), `nav-rail` (224px — repo header, then `Espacio de trabajo` / `Ramas locales` / `Referencia remota` / `Tags` / `Stashes` / `Git Flow` groups carrying the full retired `sidebar-left` behavior including its context menus, with the `st-sidebar-*` testids preserved), and `status-bar` (31px — `repo · branch · short-hash`, sync/online, and the live region hosting the per-tab fetch line — one repository at a time since 2026-10-19, see the update below). `repo-drawer` is now pin/unpin + floating-popover-at-all-widths (Escape / outside-click / focus-out close, focus restored to the toggle).
>
> `shell-header`, `shell-toolbar`, `sidebar-left` and their specs were **deleted** (delivery decision: deletions land in P2, no one-phase parity retention); the inert toolbar buttons (Commit / Branch / Merge / Stash / Discard / Tag) are removed and the live remote ops moved into the top bar. `layout.html/ts/scss` were rewritten to `top-bar | banners | body(nav-rail | workspace-split | repo-drawer) | status-bar`; the old overlay/backdrop/resize/`st-right-peek` machinery is gone, and drawer state is `drawerPinned` (persisted `st:drawerPinned`) + ephemeral `drawerOpen`.
>
> Palette is live: the semantic DARK block flipped to the committed charcoal & cyan values (§2.2 table); geometry landed (topbar 64 / rail 224 / drawer 264); `--st-size-toolbar` was removed; the legacy geometry aliases were deleted from `_legacy-aliases.scss` (the color alias group is retained for the P5 dialogs, and only `--muted` still has consumers). Judgement calls, recorded as deviations: ref pills were aligned to the new palette in the DARK block only (the light block kept the P0 values, already the committed light family); dark badge pills follow the light block's `color-mix` pattern; light graph lanes are ~20%-darkened versions of the new dark hues.
>
> Recorded deferrals (not fabricated scope): the nav-rail working-tree count pill ships wired but inert (`RepoState` exposes no change count and `StatusStore` is feature-scoped — the feed lands with a later phase); the status-bar short-hash segment is supported but fed `''` (no HEAD oid at shell scope); the status-bar ahead segment is `0` (not tracked at shell scope).
>
> Verification at P2 close: renderer vitest 78 files / 998 tests green, coverage 93.86% statements / 87.41% branches / 89.15% functions / 95.79% lines (all above the 80% thresholds); `ng build` exit 0 (the pre-existing 500 kB initial-budget warning only). No commits were made — every change is in the working tree on `feature-rebrand-style`.

> **P3 shipped (2026-10-15) — history workspace.** The split moved **into the route**: the detail pane is route-specific, the sketch's split is inherently per-route, and projecting a second content slot through the shell's single `<router-outlet>` is not natural in Angular — so the shell-level `st-workspace-split` was removed from `layout.html` and `repo-page` mounts it instead, with `file-status-page` to do the same in P4. `repo-page` wires the split as detail = `st-commit-details-panel`, primary = `st-graph-page`, with `st-repo-picker` demoted to the first-run empty state when no repository is open.
>
> `graph-page` gained the pane redesign: sticky `Grafo | Commit/autor | Fecha` column header, search with a clear affordance, sticky `N of M commits` footer, and loading / offline / empty rendered via `st-empty-state`. `commit-details-panel` gained its redesign: cyan mono 7-char hash + branch chip, 22px subject + muted description, metadata `dl` with a 24px initials avatar, committer demoted to a secondary line, and one primary `Review changes` CTA — opt-in through a new `showCta` input, so the same panel stays clean in the File-status screen. `graph-context-menu` moved onto `st-popover`; `wip-row` was retokenized; `GraphStore` gained scroll-offset persistence/restore (route-scoped, in-memory), which `GraphPage`'s destroy hook queues on every exit from History — one hook covering every path out (CTA, rail entry, tab switch, deep link, browser back).
>
> Recorded deviations, stated as deviations: `graph-context-menu` neutralizes `st-popover`'s panel via `::ng-deep` (accepted for P3; an `unstyled`/`panelClass` input on the primitive is the follow-up); `repo-picker` keeps a native token-styled `<input>` because `st-input` cannot forward a `data-testid` to its inner input; the graph column width is exact via the shared `LANE_COLUMN_WIDTH`, while the date column is right-edge aligned rather than a fixed width.
>
> Verification at P3 close: renderer vitest 78 files / 1021 tests green, coverage 93.24% statements / 86.81% branches / 88.57% functions / 95.29% lines (all above the 80% thresholds); `ng build` exit 0 (the pre-existing 500 kB initial-budget warning only, now 544.86 kB). No commits were made — every change is in the working tree on `feature-rebrand-style`.

> **P4.1 shipped (2026-10-15) — operator-reported defects and refinements of the P0–P4 surfaces.** A polish batch, NOT folded into P5/P6: it touches only surfaces this plan already shipped (plus one additive core RPC). Verification at close: renderer vitest **81 files / 1084 tests green**, coverage above the thresholds, `ng build` exit 0, Electron vitest 10 files / 129 tests green + `tsc --noEmit` clean, `go vet ./...` + `go test ./...` green, `verify-contracts.sh` OK (lint + breaking vs `main` + no generated drift), `node tools/docs/validate.js` 0 errors.
>
> 1. **Missing-folder recovery (cross-slice).** The core distinguishes `REPO_PATH_MISSING` (only `fs.ErrNotExist`) from `NOT_A_GIT_REPO`, and a new additive `RelocateRepository` RPC re-points the **existing** registration (same repository id, `created_at` preserved, `common_dir` re-resolved, `REPO_PATH_IN_USE` on a duplicate target, graph/cache invalidation like `RemoveRepository`). The History pane renders a recovery panel instead of the repo picker whenever the active repository cannot be opened: it names the state, offers **Edit path** / **Choose folder…** (the existing native chooser) and an explicit confirm-gated **Remove repository**. No code path deletes a registration implicitly. Decision record: [[adr-0031-repository-relocation-and-missing-folder-recovery]].
> 2. **Row action alignment.** `st-changes-panel` rows used `space-between` over three children, which floated the stage `+` to the row's centre; the path is now the only flexible child and both sections share one flush-right `.st-changes__actions` group.
> 3. **Staging no longer flips the variant.** `FileStatusPage`'s graph-selection effect re-ran on every `commits()` replacement (each stage/unstage/commit fires `fs:changed` → `graph.reload()`) and re-applied the selected commit, yanking the user from `local` to `commit`. It now dedupes on the *resolved* selection, so only a genuinely new selection is followed.
> 4. **Space for the items.** In the file-status `commit` variant the commit-details panel's greedy `height: 100%` crowded the changed-file list ~70/30. The panel gained a `collapsible` mode (compact head + disclosure, collapsed by default) and the list is the flexible child — ≈30/70, the description one click away. **(ADR-035 removed that `collapsible` mode; since its 2026-10-19 refinement one exclusive `description | files` switch decides the region instead of the panel collapsing as a whole.)**
> 5. **A/M/D status filters.** `st-file-diff-list` renders status filter chips above the "Changed files" heading, derived from the data (A, M, D, R, then any other status), multi-select with a distinct zero-match state; `st-button` gained a `pressed` input so the chips forward `aria-pressed` to the inner native button.
> 6. **Palette.** The dark neutrals moved to the navy/indigo ramp (divergence **D16**), the cyan accent/lanes/status colours kept, `monaco-theme.ts` mirrored, and the renderer's last 87 `var(--st-*, #hex)` fallbacks removed so the design-system hard rule finally holds repo-wide.
> 7a. **Back / View in tree.** The commit-details panel gained `showNavigation` with `viewInTree` (reveals the commit in the graph, paging if it is outside the loaded window) and `back` (clears the selection), wired by `RepoPage`. **(ADR-035 replaced `showNavigation`/`back` with the single `navMode` slot — `'release'` for the History release action, `'history'` for the analyzer shortcut — plus the analyzer-only `showInGraph` input, which hands the oid to the existing `CommitFocusService` deep-link path.)** **7b was refused at the time**: the operator's file-list tooltip next to "Review changes" contradicted [[adr-0030-history-screen-is-compare-free]], so the History aside stayed compare-free; `delivery` surfaced the conflict to the human. **7b is now ACCEPTED and landed via [[adr-0032-history-commit-file-list-tooltip]]** — a changed-file list tooltip next to "Review changes" (`st-popover`, sourced from `StatusStore` + the existing `getDiff`), a *narrow* supersession of ADR-0030 that lifts only its "no file list" lock; the compare-free contract (no status band, no inline compare modal, diff only in File status) is unchanged. **ADR-033 now supersedes that surface:** the changed-file list is an **inline expandable panel** inside the panel body (still `StatusStore` + `getDiff`, still paths only) — only the *surface* moved, so D6 below (which cited ADR-0030 to justify *not* inlining the file list) is likewise narrowed.

> **P4.2 shipped (2026-10-15) — Dark Neon / Developer Studio palette remap.** A colour-only polish batch, NOT folded into P5/P6, shipped on `feature-rebrand-style`. At the operator's request the renderer's colour system was remapped from the P4.1 **Navy & Cyan** direction onto a near-black, slightly blue-tinted **Dark Neon / Developer Studio** one with a strict intensity budget (~70% dark surfaces, ~20% neutral structure and text, ~10% bright accents) and accents assigned per semantic role: turquoise `--st-color-accent` = interaction / selection / focus / graph connections / primary action / `HEAD`; violet = local branches; the **new** electric blue `--st-color-info` = navigation / links / history / informational and `origin/*`; amber = pending changes / warnings / tags; mint = mainline ref (the **new** `--st-color-ref-main`) / staged / sync; coral `--st-color-danger` reserved for errors.
>
> Files moved: `libs/ui-kit/src/styles/tokens.scss` (dark ramp + new `info`/`ref-main` tokens, light selection/graph/ref/avatar values), `libs/ui-kit/src/diff-viewer/monaco-theme.ts` (mirrored), `libs/ui-kit/src/button/button.ts` (`info` variant + the single permitted primary glow) and the shell/consumer surfaces that read the new roles (`top-bar`, `nav-rail`, `st-graph-row`, `commit-details-panel`). The two-tier `--st-*` vocabulary and **all** geometry, hairlines, radii and the type scale were kept, and the light theme's neutrals, status and diff values were left unchanged. Verification path: the renderer vitest suite + `ng build`. `node tools/docs/validate.js` 0 errors.

> **P5 shipped (2026-10-15) — secondary surfaces & Settings.** `apps/angular/src/app/features/settings/settings.ts` was rewritten as five grouped `st-panel`s — **Appearance** (theme, motion), **Workspace** (density, reset pane width), **Diff** (layout, font size, word wrap), **Language** (EN/ES) and **About** (read-only) — built on `st-panel` / `st-toggle-group` / `st-field` / `st-button`. A new root service, `apps/angular/src/app/core/services/preferences.service.ts`, owns the renderer-local `st:`-prefixed preference signals for `st:motion` (`auto|on|off`), `st:density` (`compact|comfortable`), `st:paneWidth`, `st:diffFontSize` (`11|12|13`) and `st:diffWordWrap` (`on|off`), following the house pattern of `theme.service.ts` / `diff-mode.service.ts`. Theme, language and diff **layout** stayed owned by their existing services (`ThemeService`, `LanguageService`, `DiffModeService`) — no state was duplicated.
>
> **Consumed today:** theme, language and diff layout (the same `DiffModeService` instance the diff-pane toggle uses). **Now consumed (P6.1):** motion and density are enforced at runtime by `PreferencesService` — motion via the `<html data-st-motion>` attribute, density via `<html data-st-density>` and the `--st-size-row-tree` override; pane width is settable through the `st-workspace-split` resizable divider; diff font size and word wrap flow into `st-diff-viewer`'s `fontSize`/`wordWrap` inputs. The `PreferencesService` doc comment states the enforced-versus-passed-through split plainly, and so does this note.
>
> Secondary surfaces were retokenized and moved onto the primitives: `repos-page` (panel header, `st-field`, `st-button`, `st-empty-state`, retokenized rows), `github-account` + `account-profile` + `repo-list`, `search-workspace` (`st-input`, `.st-eyebrow` group headers, mono accent oid, hits on `[stSelectableRow]`, `st-empty-state` for the four states), the three remote dialogs (`pull`/`push`/`fetch`), the six ref dialogs (`merge`, `branch-create`, `ref-rename`, `ref-delete-confirm`, `tag-create`, `stash-push`) plus `stash-drop-confirm`, `git-flow-dialog` and `clone-dialog`, and — as a bounded adjacent consistency pass — `switch-branch-confirm-dialog` and `reset-confirm-dialog`.
>
> The shared `st-modal` (`apps/angular/src/app/shared/ui/modal/modal.ts`) was retokenized onto `--st-color-raised` / `--st-color-overlay` / `--st-z-modal` / `--st-radius-4` with hairline structure and the elevation shadow removed, its `✕` glyph replaced by `st-icon`, and a 180ms fade+rise open motion added — **plus a focus trap and focus restore**: focus moves into the dialog on open and returns to the previously focused element on every close path, and Tab/Shift+Tab cycle inside (hand-rolled to match the `st-popover` pattern, not CDK `FocusTrap`).
>
> The ui-kit field primitives gained an additive `testId` input (`st-input` / `st-select` / `st-textarea`, forwarded to the inner native control with the previous default preserved) and `st-input` gained `readonly`.
>
> **Shim retired:** `apps/angular/src/styles/_legacy-aliases.scss` was deleted and its `@use` removed from `apps/angular/src/styles.scss`. Its last consumers — 11 `var(--muted, #8a8a9a)` fallbacks across the P5 dialogs — are gone, verified by grep; no `var(--st-*, #hex)` fallback and no hardcoded colour remains in the renderer sources.
>
> **Recorded deviations:** (1) `repos-page` rows are **not** `[stSelectableRow]` — each row owns Open/Remove buttons, so an activatable row would double-fire the open action (the spec asserts `setActive` runs exactly once); the rows were retokenized to the shared row geometry instead. (2) The git-flow dialog's `role="tablist"` / `role="tab"` / `aria-selected` mode strip keeps its semantics (retokenized only); it was not downgraded to `st-toggle-group` ahead of the P6 accessibility audit. (3) Modal/dialog footers adopted `st-button`, so `data-testid` stays on the host while `disabled`/clicks resolve on the inner native button (the `repo-relocate-panel` / `top-bar` spec convention). (4) Read-only remote-URL displays use `st-input [readonly]` rather than a bespoke style.
>
> Verification at P5 close: renderer vitest **82 files / 1157 tests green**, coverage **95.01% statements / 88.46% branches / 89.64% functions / 96.83% lines** (all above the 80% thresholds); `ng build` exit 0; `node tools/docs/validate.js` 0 errors.

> **P6 shipped (2026-10-16) — responsive, a11y & motion polish.** The final phase of the facelift; the whole §8.2 manifest is now shipped. Five groups of change:
>
> 1. **Responsive.** `libs/ui-kit/src/styles/utilities.scss` gained the committed breakpoint utilities — `.st-hide-at-1600` / `.st-hide-at-1100` / `.st-hide-at-800` (`display: none` inside the matching `max-width` query) and `.st-chip-strip` (the ≤1100 wrapping chip row). They are applied on the graph date column (header + row, `st-hide-at-1600`), the graph-row author byline and the top-bar tab branch byline (`st-hide-at-1100`), and the nav rail's workspace list (`st-chip-strip`). `apps/angular/src/app/core/layout/layout.scss` carries the shell rules and is their SSOT: at ≤1100 `.st-body` becomes a **grid** — the nav rail turns into a full-width, height-capped strip above the routed region, the drawer stays in the right column — instead of a wrapping flex row, because a wrapped flex line has no definite cross-size: a routed page's `height: 100%` resolves to `auto`, the line grows to its content height and the clipped `.st-router-host` never detects overflow, so nothing scrolls; the rail cap likewise keeps a long branch list from starving the routed row. At ≤800 the repo drawer becomes a full-width bottom strip with its hairline moved to the top edge, both strips are capped tighter and the routed row carries a non-zero floor, so a short window still renders a usable routed page instead of only chrome (positive control: `/repos`); nothing above 1100 changes. **(2026-10-24: this bullet previously said the body *wraps*; the shipped structure, its caps and its floor are defined only in `layout.scss`.)** The ≤800 split-collapse rule lives in `libs/ui-kit/src/workspace-split/workspace-split.ts` (the pinned detail pane becomes a full-width top band capped at 40% height with a bottom hairline; one sanctioned `!important` overrides its inline width binding).
> 2. **A11y.** The nav rail's five section disclosure heads (Workspace / Local branches / Remote references / Tags / Stashes) now bind `aria-expanded` to their signals, with a spec asserting the reflected state; the `aria-pressed` / `aria-current` / live regions shipped in P1–P5 remain intact.
> 3. **Motion.** `PreferencesService` now enforces the persisted `st:motion` (`auto|on|off`) at runtime, mirroring `ThemeService`'s `data-theme` pattern — it writes `<html data-st-motion>` synchronously at construction and reactively from an `effect()`, and the boot initializer (`app.config.ts`, `initializeShellState`) instantiates it before first paint. `utilities.scss` extends the motion guard: the `prefers-reduced-motion` neutralisation is scoped to `:root:not([data-st-motion='on'])`, and a new `:root[data-st-motion='off']` guard neutralises unconditionally — so `auto` follows the OS, `off` kills motion, and `on` survives an OS "reduce".
> 4. **i18n.** `apps/angular/src/locale/messages.json` was regenerated with `ng extract-i18n` (229 ids at P6 — now 230 after the Settings group-label split; id-stable across two runs) and `messages.es.json` rewritten to exact id parity (127 retained translations reused verbatim, 102 new Spanish renderings authored, 33 stale ids dropped; ICU placeholders preserved). `apps/angular/src/app/core/i18n/i18n-runtime.spec.ts` gained a catalogue-parity guard (the en/es id sets are equal) plus sample-id resolution checks in both locales.
> 5. **Bounded design-system polish.** The two unpermitted `0 12px 32px` elevation shadows were removed (`repo-drawer.ts` floating popover, `graph-context-menu.ts` — exactly two shadows remain system-wide: the inset selection bar and the primary-button glow), and residual opacity-based CONTENT dimming was converted to `var(--st-color-muted)` (status-bar in-sync line, push-dialog labels/headers/status, hunk-actions header + notes, reset-confirm target, switch-branch hint, top-bar tab-close affordance, graph-context-menu hint); documented disabled-state opacity (states matrix) and the intentional graph-row dimming were left untouched.
>
> **Recorded deviations:** (a) the ≤800 split-collapse rule landed in `workspace-split.ts` rather than `layout.scss` — view encapsulation prevents the shell stylesheet from reaching routed-component hosts, so `layout.scss` owns only the rail/drawer rules it can actually reach; (b) `.st-hide-at-800` ships as the manifest-committed ≤800 utility slot with no current consumer (the ≤800 stacking is delivered by the shell rules + the split collapse) — kept as committed inventory; (c) `st:motion` was enforced in P6 while `st:density` / `st:paneWidth` / `st:diffFontSize` / `st:diffWordWrap` remained persisted-only — **now CLOSED by P6.1 (2026-10-16)**, which shipped their consuming surfaces (density via the `--st-size-row-tree` override, pane width via the split divider, diff typography via the viewer inputs).
>
> Verification at P6 close: renderer vitest **82 files / 1171 tests green**, coverage **95.04% statements / 88.49% branches / 89.74% functions / 96.86% lines** (all above the 80% thresholds); `ng build` exit 0 (initial total 552.19 kB raw / 128.70 kB transfer; no budget warnings); `node tools/docs/validate.js` 0 errors / 0 warnings (38 files scanned). No commits were made — every change is in the working tree on `feature-rebrand-style`.

> **P6.1 shipped (2026-10-16) — preference surfaces.** Four `st:` preferences that P5 persisted had no consuming surface; they now do. This is a consumption/wiring batch, not a new phase: no new token, no IPC, no Git core, no contracts change, no manifest entry.
>
> 1. **`st:density`** (`compact | comfortable`) is enforced at runtime exactly like `st:motion` — `PreferencesService` writes `<html data-st-density="compact|comfortable">` synchronously at construction and from an `effect()` on every change (both values explicit; the attribute is never removed). `libs/ui-kit/src/styles/tokens.scss` gained a third top-level block after the theme blocks: `:root[data-st-density='compact'] { --st-size-row-tree: 24px; }` / `:root[data-st-density='comfortable'] { --st-size-row-tree: 28px; }`. `:root[data-st-density=…]` outranks both `:root` and `[data-theme='light']`, so density wins in either theme; overriding only `--st-size-row-tree` flips every file/tree row consumer at once (today the only one is `.st-repos-page__row` in `repos-page.ts`). The frozen `--st-size-row-graph` (28px, must equal `GRAPH_ROW_HEIGHT`) and `--st-size-row-tree-dense` (nav rail rows, split detail header, graph rows, diff header) are deliberately untouched, so graph alignment never moves. The shipped default preference is `comfortable`, so with nothing persisted the rows render 28px (the default the operator approved); only an explicit persisted `compact` opts into the 24px rows.
> 2. **`st:paneWidth`** is settable through `st-workspace-split`'s opt-in `resizable` divider (inputs `detailWidth` / `resizable`, output `detailWidthResized`), clamped to `[320, max(320, host width − 320)]` (320 mirrors `--st-size-pane-min`); pointer capture is guarded and jsdom-safe, keyboard is ArrowLeft/Right ±16px (Shift ±64), Home = 320, End = max, with `role="separator"` + `aria-valuemin/max/now`. The hosts `repo-page` and `file-status-page` bind the persisted width in and persist the emitted width out, so the Settings "Reset pane width" restores the 380px default and the value survives a reload.
> 3. **`st:diffFontSize`** (`11 | 12 | 13`) and **`st:diffWordWrap`** (`on | off`) are consumed by `st-diff-viewer` through two dumb inputs (`fontSize`, default 12; `wordWrap`, default false) plus the exported pure helper `diffLineHeight(fontSize) => fontSize * 2` (11→22, 12→24, 13→26). Monaco follows the values live via `editor.updateOptions` only — never a remount — and the non-Monaco 4-column fallback grid carries a `data-wrap="on|off"` attribute plus inline typography.
>
> **Frozen invariants respected:** the graph row stays 28px; the ≤800 split collapse (its sanctioned `width: 100% !important`) still beats any inline width and the divider is `display: none` there; ui-kit stays dumb (the split and the viewer take inputs and emit outputs, never reading preferences); the diff viewer never remounts; no new token was added. No IPC, no Git core and no contracts change — renderer-local only.
>
> Verification at P6.1 close: renderer vitest **82 files / 1202 tests green**, coverage **95.02% statements / 88.45% branches / 89.74% functions / 96.87% lines** (all above the 80% thresholds); `ng build` exit 0 (initial total 557.97 kB raw / 129.90 kB transfer; no budget warnings); `node tools/docs/validate.js` 0 errors / 0 warnings (38 files scanned).

> **ADR-032 surface superseded (2026-10-16) — the changed-file list is now an inline expandable panel.** The tooltip this plan recorded as 7b's landing (`st-popover` beside "Review changes") **shipped**, and has since been **superseded in part** by [[adr-0033-commit-details-files-expandable-panel]]: the selected commit's changed paths render as a collapsed/expanded disclosure **inside** the `st-commit-details-panel` body, scrolling within its own capped region, and the file-list `st-popover` is **no longer consumed in the History aside** (the primitive itself is unchanged, still used by the graph context menu and the repo drawer). The data source (`StatusStore` + the existing `getDiff`), the read-only contract and the compare-free boundaries are unchanged — only the *surface* moved.

> **Commit-details redesign, selection lock and inline hunk actions (2026-10-17).** A renderer + ui-kit batch that changes two shipped surfaces, recorded in [[adr-0035-commit-details-redesign-and-inline-hunk-actions]] (a **refinement** of [[adr-0033-commit-details-files-expandable-panel]], which stays `active`). (1) **`st-commit-details-panel` is now header row → description → changed files → demoted metadata**: identity (short sha + branch chip) left, the primary CTA centred, an action group right (padlock + contextual nav + the analyzer-only "show in graph"); the message disclosure and the changed-files disclosure are **independent** and the changed-files block gains a `st-input type="search"` name filter (case-insensitive **literal substring** via `String#includes` — never a `RegExp`) with an accurate, filter-aware `N of M changed files` heading; the `collapsible` compact-head mode, the `back` output and `commit-details-byline` are gone, `showNavigation` became `navMode: 'none' | 'release' | 'history'`, and the testids `commit-details-back` / `commit-details-files` were renamed `commit-details-release` / `commit-details-files-toggle`. (2) **The selection lock (padlock) lives in the route-scoped `GraphStore`** (`lockedOid`/`lockedCommit`, `lock`/`unlock`/`release`), so it spans `/repo` ↔ `/repo/file-status`; `select()` refuses a foreign oid while locked and announces through the root `LiveRegionService`; `reload()` never clears it, and since 2026-10-22 `openRepository` restores each repository's own saved pin from the root in-memory `GraphSessionStore` instead of clearing it ([[adr-0040-per-repo-session-graph-selection-lock]]); `lockedCommit` keeps the pinned pane rendering when the row leaves the loaded window. (3) **`st-diff-viewer` carries host-supplied inline per-hunk actions** (`hunkActions` + `hunkAction`/`hunkLineToggle`): with slots supplied the viewer renders its **own 5-column tokenized grid** and Monaco does not mount, so `st-hunk-actions` and the left-column `changes-hunks` block are deleted and `isHunkActionable` moved to `status/ui/hunk-actions.model.ts`; the hunk→index mapping is the new pure `hunkGridSegments(diff)` walk, so the existing ADR-0020 per-hunk RPCs are addressed unchanged. **Known reduction, recorded honestly: per-hunk unstage is no longer surfaced** (the viewer renders one diff — the worktree one); file-level unstage remains. **Refused:** pre-setting the Branch comparator (PR variant) with the locked commit — `FileStatusStore.openPr` diffs base ↔ target branches and has no commit input, and expressing it would need a new RPC. Icons `lock` / `lock-open` added (additive). No proto, IPC channel or Go-core change — renderer + ui-kit only.

> **Update (2026-10-17):** the ADR-0035 batch's two **independent** disclosures (message / changed files) are now **one exclusive switch** — a refinement recorded in [[adr-0035-commit-details-redesign-and-inline-hunk-actions]]. `st-commit-details-panel` and the analyzer (`file-status-page`) each render **exactly one of {description, changed files}** at a time from a two-segment `st-toggle-group` (`description` default): the panel's switch sits in the subject row (subject always shown, clamped in `files` mode) and forces `files` with the `description` segment disabled for a body-less commit, while the analyzer's switch sits in its title header and keeps `description` enabled (the subject is its content). The mode is component-local on each host — never shared — and the primitive gained an additive per-segment `ToggleOption.disabled`. Testids: `commit-details-toggle` / `commit-details-files-toggle` / `file-status-title-toggle` are gone, replaced by `commit-details-view-switch` / `file-status-view-switch` (plus `file-status-title-body`). No new RPC, IPC channel or Go-core change. **Superseded on 2026-10-19:** the mode is now one route-scoped service shared by both hosts and the switch lives in the panel header (see the update below).

> **Per-tab fetch, three-region panel and the shared view mode (2026-10-19).** A renderer + ui-kit batch recorded in [[adr-0035-commit-details-redesign-and-inline-hunk-actions]] (its 2026-10-19 refinement) and [[adr-0036-per-tab-fetch]]. (1) **`st-commit-details-panel` is three regions**: a header (identity | centred CTA | the exclusive `description | files` switch | the action group), the **only** scrolling content region (the subject always; the body in `description` mode; the changed-file block with its filter and both empty states in `files` mode) and a metadata footer that **starts collapsed** behind `commit-details-footer-toggle` and is a **sibling** of the content region — the fix for the changed-files list painting over the metadata. New testids: `commit-details-header`, `commit-details-content`, `commit-details-footer`, `commit-details-footer-toggle`, `commit-details-meta`, `commit-details-lock-tooltip`. (2) **The mode is one route-scoped `CommitViewModeService`** provided on the parent `''` route, so a pick survives `/repo` ↔ `/repo/file-status` even though the panel unmounts, and resets to `description` when the active repository changes; the panel keeps no mode state (`[mode]` in, `(modeChange)` out, the host feeds it back) and the switch moved from the analyzer's title header into the panel header (`file-status-view-switch`, `file-status-title` and `file-status-title-body` are gone). (3) **The analyzer's whole commit view is the panel** (2026-10-20): the panel is the first child of the left column and owns the description region (`showSubject=true`, height-capped so a long body scrolls inside it) **and** the `files` region (its own paths-only changed-file list); the page no longer renders its own summary line or `st-file-diff-list` in the `commit` variant, the panel's file rows are selectable (`fileSelect`, wired to `fs.selectFile`) so the right pane's single-file diff stays reachable, and the panel's metadata footer is the column's last element. A message-less commit is forced to `files` by the panel's `effectiveMode` alone — the page-level `effectiveAnalyzerMode` and its `hasMessage` / `commitTitle` / `commitBody` helpers are gone. (4) **The padlock tooltip** appears after ~1 s of continuous hover or keyboard focus, is `position: fixed`, wraps at 320px and is referenced through `aria-describedby`; the ui-kit `st-button` gained the additive `ariaDescribedby` input. (5) **Per-tab fetch** ([[adr-0036-per-tab-fetch]]): the top-bar action is now **Sync** (`top-bar-sync`, output `syncRequested`) and fetches only the active tab; every other tab is fetched lazily when it becomes active, single-flight per repository with a session freshness marker, and a per-repository generation token plus `invalidateFetch(repoId)` (tab close / repository removal) discards late results. The existing per-repo `fetch` RPC is unchanged — no new RPC, proto or IPC channel — and the status line reports one repository, not an `N/M` aggregate.

**Evidence base:** every `path:line` claim below was read from the working tree, not inferred. Two findings shaped the plan: (1) `apps/angular/src/styles.scss` imports `@tailwind base/components/utilities` but there is no `tailwind.config.*`, no `postcss.config.*`, no Tailwind dependency in any workspace `package.json` and zero Tailwind utility classes in the codebase — the directives are inert; (2) `apps/angular/src/index.html` loads no font files, so the `Inter, system-ui, ...` stack silently resolves to `system-ui`.

---

## 1. Design thesis

After the facelift SingulariTree should read as a **dense-but-calm desktop instrument**: a charcoal workbench where structure comes from hairlines and type weight instead of boxes and gradients, where a single cyan accent marks identity (brand, commit hashes, current branch, the active/selected thing) and nothing else competes for it, and where the commit graph is treated as ornament — the only continuously-drawn, saturated element on screen. Every region is a flat panel separated by a 1px line; every list row is legible at 12–13px with a mono byline; every action carries exactly one visual weight (primary | default | ghost | danger). The feel is closer to a terminal multiplexer than to a web dashboard: information-dense, quiet, predictable, with the graph lanes and the diff tints supplying the only colour. Concretely, the sketch's cues that produce that feel are adopted wholesale — telegraphic 10/11/12/13/22 type scale, cyan-on-charcoal, 1px hairline structure, uppercase letter-spaced eyebrows, 4–5px control radii, the 3px inset accent selection bar, the 2px cyan focus ring, and a single 180ms fade — while the sketch's *mock-specific* accidents (single-repo context block, a 1:1 pane split, a 172px rail, Spanish literals, an inline per-selection file list) are explicitly diverged from.

---

## 2. Visual direction (committed)

### 2.1 The direction: **Charcoal & Cyan (graphite workbench)**

Adopt the sketch's palette as the dark theme, promote it into a two-tier token system, and author a matched light theme from the same token names. Justification for committing rather than offering options: the sketch is a coherent, already-validated dark palette, the product is a desktop developer tool where dark-first is the norm, and the existing `ThemeService` + `data-theme` contract means a second theme is a value set, not an architecture change. A cyan accent is also the only accent family in the sketch that keeps ≥4.5:1 against every surface it sits on (#69dfdc on #1e1e2e is ~11:1). **P4.1 update:** the dark *neutral* ramp moved from charcoal onto a navy/indigo family at the operator's request (divergence D16 below); the accent, lanes, ref pills and status colours are unchanged, so the direction now reads **Navy & Cyan** in the shipped design system.

### 2.2 Colour — two tiers, one vocabulary

**Tier 1 primitives** (`--st-prim-*`, raw values, never referenced by a component):

```
ink-900 #1e1e2e  ink-850 #20202f  ink-800 #252536  ink-750 #2a2a3a
ink-700 #2e2e40  ink-600 #3a3a52  ink-050 #e9e9f2  ink-300 #a8a8c0
cyan-400 #69dfdc  cyan-500 #438c89  cyan-600 #356966  cyan-700 #164746
green-300 #9fe0b1  red-300 #ffacaf  amber-300 #ebcb86
ins-bg #223e2e ins-fg #c6f1d1  del-bg #49292d del-fg #ffd4d5  hunk-bg #293638 hunk-fg #aad8d7
graph-cyan #67cbc7 graph-amber #cfad78  avatar-bg #343a52 avatar-fg #cef4db
```
> The neutral ramp shown is the P4.1 navy/indigo family (divergence D16); the charcoal values committed at P0–P2 are superseded for the dark theme only. The accent, status, diff and graph primitives are unchanged.

**Tier 2 semantic** (`--st-color-*`) — the existing naming, extended. Only these appear in components:

| Token | Dark | Light | Used by |
|---|---|---|---|
| `--st-color-bg` | #1e1e2e | #f7f8f7 | app background, center region |
| `--st-color-chrome` (new) | #232334 | #eceeed | top bar, bottom bar |
| `--st-color-rail` (new) | #20202f | #f0f2f1 | nav rail |
| `--st-color-surface` | #252536 | #ffffff | panels, panes, cards |
| `--st-color-surface-2` | #2a2a3a | #f4f6f5 | raised strips, table header |
| `--st-color-raised` (new) | #2e2e40 | #ffffff | popovers, modals |
| `--st-color-border` | #3a3a52 | #d8dcda | hairline structure |
| `--st-color-border-strong` (new) | mix(border 70%, text 6%) | mix(border 80%, text 10%) | pane dividers, focus-adjacent |
| `--st-color-text` | #e9e9f2 | #14181a | primary text |
| `--st-color-muted` | #a8a8c0 | #5b6668 | bylines, paths, metadata |
| `--st-color-accent` | #69dfdc | #0f7f7c | brand, hashes, current branch, primary CTA |
| `--st-color-accent-soft` | mix(accent 18%) | mix(accent 12%) | active nav fill, badges |
| `--st-color-accent-contrast` (new) | #16162a | #ffffff | text on accent fills |
| `--st-color-selected` | #123a46 | #d3ece9 | selected row/fill |
| `--st-color-selected-bar` | #69dfdc | #0f7f7c | 3px inset selection bar |
| `--st-color-selected-border` | #3a7d78 | #7fc4bd | selected row hairline |
| `--st-color-focus` (new) | #69dfdc | #0f7f7c | `:focus-visible` ring |
| `--st-color-add` / `-soft` | #9fe0b1 / mix 14% | #1c7c3c / mix 10% | +N stats, A status, staged |
| `--st-color-remove` / `-soft` | #ffacaf / mix 14% | #b3261e / mix 10% | −N stats, D status, discard |
| `--st-color-warn` / `-soft` | #ebcb86 / mix 14% | #8a6100 / mix 10% | M status, ahead/behind, conflict banner |
| `--st-color-danger` (new) | #ffacaf | #b3261e | destructive actions (replaces the hardcoded #ff6b6b) |
| `--st-color-diff-insert-bg/-fg` | #223e2e / #c6f1d1 | #e6f7ea / #14532d | diff additions |
| `--st-color-diff-delete-bg/-fg` | #49292d / #ffd4d5 | #fde8e9 / #7f1d1d | diff deletions |
| `--st-color-diff-hunk-bg/-fg` | #293638 / #aad8d7 | #e8f4f3 / #0f5f5c | hunk headers |
| `--st-color-diff-gutter-bg/-fg` (new) | #20202f / #6f7690 | #f4f6f5 / #8a9490 | line-number columns |
| `--st-color-graph-lane-1..8` (new) | #67cbc7 #cfad78 #8fd6a0 #e79aa0 #b3a6e8 #7fb3e0 #e2cf8a #dba6d4 | same hues ~15% darkened | graph lanes (see §6 D9) |
| `--st-color-avatar-bg/-fg` (new) | #343a52 / #cef4db | #d9e6df / #14532d | commit-detail initials avatar |
| `--st-color-overlay` (new) | rgba(12,12,24,.62) | rgba(20,24,26,.35) | modal/drawer backdrop |

**Hard rule (the theming fix):** delete every `var(--st-color-x, #hex)` fallback in the codebase. A fallback is a theming bug: today `sidebar-left.ts`, `graph-row.ts`, `changes-panel.ts`, `commit-details-panel.ts`, `file-diff-list.ts` and others paint wrong colours under `data-theme=light` because their fallback hex wins when the light block omits the token. Every token must be defined in both blocks, so a fallback is never needed. **P4.1:** the last 87 fallbacks were removed from the renderer (dialogs, repos manager, settings, search, GitHub account), so the rule now holds repo-wide — reintroducing one is a review blocker.

### 2.3 Typography

- Families unchanged: `--st-font-ui: Inter, system-ui, -apple-system, sans-serif`; `--st-font-mono: Consolas, 'Liberation Mono', ui-monospace, SFMono-Regular, Menlo, monospace`. **No font asset is added** (CSP forbids remote fonts; a bundled Inter would balloon the initial budget past the 1MB error limit and change nothing about the layout).
- **Divergence D12:** the sketch uses 550 and 650. Because Inter is not actually loaded, fractional weights resolve unpredictably on fallbacks. Commit to the 400 / 500 / 600 / 700 quadruple.
- Scale (sketch 10/11/12/13/22 + brand): `--st-font-10/11/12/13/17/22`.
- Line heights: `--st-leading-tight:1.25` (dense rows), `--st-leading-ui:1.5` (prose/description), `--st-leading-code:24px` (12px mono in the diff/editor, matching the sketch's `12px/24px` grid).
- Roles: **eyebrow** 11/600/uppercase/ls .08em/muted; **label** 12/400; **body** 13/400; **row** 12/600 subject + 11/400 muted byline; **detail subject** 22/600; **brand** 17/600; **code** 12/400 mono.
- **Mono rules:** hashes/oids (short and full), fs paths, `remote/branch` ref names, diff code and gutter numbers, `+N/−N` stat counts, keycaps. Never mono for nav labels, buttons, settings labels, commit subjects or table headers. All numeric columns use `font-variant-numeric: tabular-nums` so dates and counts do not jitter.

### 2.4 Spacing & geometry

```
space  --st-space-1..8 = 4 8 12 16 20 24 32 40   (base unit 4px)
radii  --st-radius-1 3px  -2 4px (controls)  -3 5px (cards)  -4 8px (panels/popover/modal)  --st-radius-pill
hair   --st-hairline 1px    (panels are separated by hairlines, never by shadows)
heights --st-size-topbar 64  --st-size-statusbar 31  --st-size-rail 224  --st-size-rail-collapsed 40
        --st-size-drawer 264  --st-size-detail-pane 380  --st-size-pane-min 320
        --st-row-graph 28 (frozen: MUST equal GRAPH_ROW_HEIGHT)  --st-row-tree 28  --st-row-tree-dense 24
        --st-control-sm 24  --st-control-md 28  --st-control-lg 32
        --st-selection-bar-w 3
z       --st-z-sticky 10  -rail 15  -backdrop 30  -drawer 35  -popover 40  -menu 45  -modal 100  -toast 120
motion  --st-motion-fast 120ms  -base 180ms  -slow 240ms  --st-ease cubic-bezier(.2,.7,.2,1)
```

Every sketch magic number is collapsed here: 65px top bar → `--st-size-topbar:64px` (rounds to the 4px grid); 172px rail → `--st-size-rail:224px` (see D2); 220px drawer → `--st-size-drawer:264px`; 31px bottom bar → `--st-size-statusbar:31px`; 4px/3–5px radii → `--st-radius-2`/`-1`; 17px icons → `--st-icon-size:17px`; 58px graph column → dynamic (see D9). The selection bar is `box-shadow: inset 3px 0 0 var(--st-color-selected-bar)` rather than a border, because a border shifts layout and would be clipped inside CDK's virtualized rows.

### 2.5 States & affordances

| Element | rest | hover | active/pressed | selected | focus-visible | disabled |
|---|---|---|---|---|---|---|
| `st-button` default | surface + border | border→accent, bg surface-2 | translateY(1px) | — | 2px focus ring, offset 2px | 40% opacity, default cursor, no hover |
| `st-button` primary | accent bg + accent-contrast text | accent 88% mix white | as above | — | ring on accent-contrast | 40% |
| `st-button` ghost | transparent | surface-2 | as above | — | ring | 40% |
| `st-button` danger | transparent + danger text | danger-soft bg | as above | — | ring | 40% |
| nav item | muted icon + text | surface-2 bg, text | — | accent text + accent-soft fill + 3px inset bar | ring offset -1px (inset) | 40% |
| history/list row | transparent | raised 6% | — | selected fill + 3px inset bar | ring offset -1px (inset) | — |
| tree/file row | transparent | raised 6% | — | selected fill + 3px inset bar | ring offset -1px (inset) | 45% |
| input / select | surface-2 + border | border-strong | — | — | border→accent + ring | 45% |
| popover item | transparent | accent-soft | — | — | accent-soft + no ring | 40% |

The selection treatment is **one reusable pattern** (`selectable-row` + the utilities class), applied identically in the nav rail, the history list, the file list, the search hits and the repo drawer cards, so 'what is selected' reads the same everywhere.

### 2.6 Motion

A deliberately minimal set: `120ms` for hover/press colour and border transitions; `180ms` for the pane mode swap (cross-fade of the pane body only — never the graph rows), popovers, the drawer slide and the dialog fade + 6px rise; `240ms` for drawer width. One easing curve. No motion on selection change, on scroll, or on graph rows (density and virtualization win). The whole set is neutralised by one guard:

```scss
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
```

plus a user-facing override in Settings (auto | on | off, persisted under `st:motion`).

---

## 3. Information architecture & shell layout

Region order, top → bottom (all inside `LayoutComponent`, `layout.html`):

```
[1] top bar            64px    brand | hairline | repo tab strip (+ add) ......... actions | sync pill | menu | drawer toggle
[2] banners            auto    checkout-error · merge-conflict        (conditional, prominent, dismissible)
[3] body               flex    nav rail 224 | workspace (pinned detail 380 + flexible primary) | repo drawer 264
[4] status bar         31px    repo · branch · short-hash | sync/online | live region
```

**What each persistent region owns**

- **Top bar** — brand glyph (cyan) + `SingulariTree` wordmark 17/600; a 1px vertical hairline; the **repo tab strip** (each tab = repo name 13/600 + branch 12 mono muted; active tab = surface bg + cyan inset bar + `aria-selected`); `+` add-tab; the live remote-op cluster (Pull / Push / Fetch / Fetch-all / Clone-from-clipboard / Copy-URL, icon + label, disabled without an active repo, Pull badged with the ahead count); a sync status pill; an overflow menu (Repositories / GitHub account / Settings); and the drawer toggle (`aria-expanded`). The far-right area is a `-webkit-app-region: drag` region.
- **Nav rail** — active-repo header (name 13/600, current branch 12 mono cyan, fs path 11 mono muted, truncating), then `Espacio de trabajo` (Historial → `/repo`; Cambios locales → `/repo/file-status` with a count pill fed by the working-tree change count), `Ramas locales` (current branch pinned first + filter input + per-row context menu), `Referencia remota` (mono `remote/branch` rows), `Tags`, `Stashes`, `Git Flow`, and the collapse control. Every item carries `aria-pressed`/`aria-current`.
- **Workspace split** — a pinned left detail/source pane and a flexible right primary pane (§4.3–4.6). Owns its pane header, its own search/column header, and the pane's scroll position.
- **Repo drawer** — `Local repositories` header + pin toggle, search, repo rows (name / branch / path), add. Pinned = docked 264px; unpinned = 280px floating popover with Escape / outside-click / focus-out close.
- **Status bar** — left: `repo · branch · short-hash` in mono 11; centre: sync state (↑ahead ↓behind) and a core online/offline dot; right: a single `aria-live="polite"` region that receives the single-repository fetch line and ambient notices.
- **Banners** — reserved for actionable failures only (checkout failure, merge conflict). Fetch progress is *not* a banner: it moves to the status-bar live region, which removes one full-width band from the default layout.

**Navigation model.** One rail replaces the current triad (tabs + toolbar nav buttons + collapsible sidebar sections). The toolbar's functions are dissolved, not moved wholesale: live remote ops → top bar; route navigation → overflow menu; the five inert chrome buttons (Commit / Branch / Merge / Stash / Discard / Tag, `shell-toolbar.ts:18,78-82`) → deleted, because each already has a real home (the commit box in `changes-panel`, the rail context menus in `sidebar-left.ts:294-346`, the ref dialogs). Search keeps both the rail `Espacio de trabajo` entry and a top-bar affordance, and remains an in-shell workspace rather than a route (ADR-026) — the sketch's nav-entry model is adopted as an *additional* entry point, never as a replacement.

---

## 4. Screen-by-screen mapping

Legend: **R** = reused as-is · **E** = edited/retokenized · **N** = new.

### 4.1 Top bar (sketch region 1)

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| brand glyph + 17px/650 wordmark, cyan | `shell-header.ts:23` renders `brand()` as plain text in a 48px blue `linear-gradient` bar | **E** charcoal 64px bar; cyan `st-icon` brand glyph + wordmark 17/600 | `st-icon` |
| hairline separator | none | 1px vertical hairline, full bar height, 12px inset | — (utilities) |
| repo context (name 13 + path 11 mono) | the header shows multi-repo **tabs** instead (`shell-header.ts:24-57`); path is absent | **E** active tab doubles as repo context (name + branch); full fs path on the tab title plus the rail repo header. Divergence D1 | `st-icon`, `st-badge` |
| status badge pill | `st-badge variant=warning` on the Pull toolbar button | **E** one sync pill in the bar (ahead/behind/clean/syncing) | `st-badge` |
| `Repositorios` toggle (folder, `aria-expanded`) | `shell-toolbar.ts` Repo/GitHub/Settings routerLinks + a separate right-peek chevron (`layout.html:119-123`) | **E** one drawer-toggle button with `aria-expanded`; nav targets in an overflow menu | `st-button` (icon), `st-popover` |
| window glyphs | `shell-header.ts:59` static `─ □ ×` | **DIVERGE D4:** delete. The Electron frame owns them; fake glyphs are misleading and non-functional | — |
| (sketch has no toolbar) | `st-shell-toolbar`, 44px, 13 buttons | **DIVERGE D3:** retired as a row; remote ops into the top bar, inert buttons deleted, routing into the menu | `st-button`, `st-popover` |

### 4.2 Left navigation (sketch region 3)

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| 172px rail, `#202224`, uppercase 11px eyebrows | `sidebar-left.ts:372-390` — 260px `#252536`, 12.5px, `▾/▸` unicode disclosure rows | **E** 224px `--st-color-rail`, 24px rows, `st-icon` chevrons, eyebrow group headers. Divergence D2 (width) | `st-nav-item`, `st-icon`, `st-badge` |
| `Espacio de trabajo`: Historial; Cambios locales + count pill | `sidebar-left.ts:734-738` `WORKSPACE` = File status / History / Search | **E** Historial → `/repo`, Cambios locales → `/repo/file-status` + live count pill, Search retained | `st-nav-item`, `st-badge` |
| `Ramas locales`: branch + filter buttons | `sidebar-left.ts:88-121` BRANCHES accordion, dblclick checkout, context menu | **E** filter input + rows with the 3px selection bar; all existing context-menu intents preserved (`checkout/rename/merge/delete`, current-branch delete guard) | `st-nav-item`, `st-field/input`, `st-popover` |
| `Referencia remota`: `origin/main` mono | `sidebar-left.ts:165-205` REMOTES groups | **E** mono remote rows under a remote eyebrow | `st-nav-item` |
| (not in sketch) Tags / Stashes / Git Flow | `sidebar-left.ts:123-292` | **ADOPT + EXTEND D5:** kept; they are shipped features and dropping them to match the mock would be a regression | `st-nav-item` |

### 4.3 Commit detail pane (sketch region 4a, mode 1)

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| cyan mono short hash + branch chip | `commit-details-panel.ts:21-31` full 40-char hex as the panel title; refs as colour-coded pills with hardcoded hexes | **E** cyan mono 7-char hash + `st-badge variant=branch` chip; refs tokenized | `st-badge` |
| 22px subject + muted description | `:33` a single `<pre>` message | **E** subject 22/600 + description 13/1.5 muted, `\n\n` split | — |
| metadata dl + 24px initials avatar | `:35-54` a 5-row dl (Author, Committer, Date, Parents, Refs), no avatar | **E** Author+avatar, Date, full hash, Parents; Committer demoted to a secondary muted line (data preserved, hierarchy applied) | `st-icon` |
| primary `Review changes` button | none | **N** one `st-button primary` CTA → `/repo/file-status` with the commit selected | `st-button` |
| inline file list (N files, ±stage) | `commit-details-panel` is metadata-only by design | **DIVERGE D6:** not inlined; the CTA carries the intent. ADR-0030 made History compare-free | — |

### 4.4 Local changes / status pane (sketch region 4a, mode 2)

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| eyebrow + 22px title + `repo · branch` caption | `changes-panel.ts:23-24,52-53` two uppercase 11px headings, no title block | **E** pane title block (eyebrow + 13/600 title + mono `repo · branch` caption) | `st-panel` |
| staged/unstaged groups with `±` stage actions | `changes-panel.ts:22-89` text buttons `Stage/Unstage/Discard` | **E** icon `±` actions with accessible labels, `st-icon`, selection bar on the active file, commit box on `st-textarea` + primary `st-button`, hunk actions retokenized **(the separate hunk-actions block was later deleted — ADR-035 moved the per-hunk actions inline into `st-diff-viewer`)** | `st-panel`, `st-icon`, `st-textarea`, `st-button`, `selectable-row` |

### 4.5 History / graph list (sketch region 4b)

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| title + branch badge, search + clear | `graph-page.ts:52-80` title, filter input, Changes button, inline loading/offline text | **E** panel header (title + branch badge), search field with a clear affordance, loading/offline via `st-empty-state` | `st-panel`, `st-field/input`, `st-empty-state` |
| sticky column header `Grafo \| Commit/autor \| Fecha` | absent | **N** sticky 24px header row aligned to the row columns, muted 11/600 eyebrow | `st-panel` + utilities |
| row: inline graph + chip + subject 12/550 + byline 11 + date | `graph-row.ts` — inline SVG lane, short oid, ref pills, message, author, stats, date; hardcoded hex fallbacks | **E** retoken, chip styling, `tabular-nums` dates, selection bar; keep 28px | (retoken `graph-row`) |
| footer `N of M commits` | absent | **N** sticky footer fed by `store.filteredRows().length` / `store.total()` | — |
| 58px graph column | `graphWidth = (maxLane+1) * LANE_COLUMN_WIDTH(14)` | **DIVERGE D9:** dynamic width, not a fixed 58px — real repos need N lanes and a fixed width breaks alignment | (edit `lane-palette`, `graph-row`) |
| small static list | CDK virtual scroll, 200-row window, prefetch 100 | **DIVERGE D8:** keep CDK virtualization | ScrollingModule |

### 4.6 Diff viewer (sketch region 4b, diff mode)

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| `← back` + badge; path + stats strip | `file-status-page.ts:107-120` renders only `st-diff-viewer`; the stats strip is a mono summary line on the left | **E** a pane header (path + branch badge + `+N/−N` strip) above the viewer | `st-panel`, `st-badge` |
| mono 12/24 grid, old-num 36 \| new-num 36 \| sign 20 \| code | `diff-viewer.ts:150-157` fallback is a single `<pre>` unified blob; Monaco mounted with `fontSize:12`, no line height, default theme | **E** Monaco themed to the tokens with `lineHeight:24`, 12px mono, tokenized gutters; **default unified** (`renderSideBySide:false`) with a persisted toggle; the `<pre>` fallback rebuilt as the sketch's 4-column grid with the insert/delete/hunk tints | `monaco-theme.ts` (new) |
| row tints | `diff-viewer.ts:134-143` hardcoded `#ff6b6b`/`#e0a458` | **E** `--st-color-danger` / `--st-color-warn` / diff tint tokens | — |
| diff replaces the list, selection + scroll preserved | routes are separate (`/repo` ↔ `/repo/file-status`); scroll offset is not persisted | **E** 180ms pane cross-fade + `GraphStore` scroll-offset persistence so returning restores selection and viewport | `workspace-split` |

### 4.7 Repo drawer / popover (sketch region 5)

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| 220px, `border-left`, `Local repositories` + pin toggle | `repo-drawer.ts` — 320px, resizable, head with a ✕ close, search, `st-repo-card` rows, `+ Add repository` | **E** 264px, pin/unpin toggle replacing close, retokenized rows (name / branch / path) | `st-panel`, `st-repo-card`, `st-field/input`, `st-icon` |
| unpinned → 280px popover, Escape/outside-click/focus-out | `layout.ts:137` overlay only below 1024px, with a backdrop (`layout.html:114-116`) | **E** unpinned = floating popover at **all** widths, Escape + outside-click + focus-out, focus restored to the toggle | `st-popover` |

### 4.8 Bottom bar (sketch region 6)

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| 31px, left context, right cyan live region | **does not exist** | **N** `st-status-bar` at shell level: `repo · branch · short-hash` (mono), sync/online indicator, and one `aria-live=polite` region carrying the single-repository fetch line and notices | `st-status-bar`, `st-live-region` |

### 4.9 Settings

| Sketch cue | Current code | Proposed | New ui-kit |
|---|---|---|---|
| (not covered by the sketch) | `settings.ts` — a 520px column with two `st-toggle` groups (Dark/Light, EN/ES) | **E** grouped preference panels: Appearance (theme, motion), Workspace (density, pane width reset), Diff (unified/side-by-side, font size, word wrap), Language (en/es), About (read-only). All renderer-local (`st:` localStorage). Git-config editing **deferred** — needs core I/O, out of the UI layer | `st-panel`, `st-toggle-group`, `st-field`, `st-button` |

### 4.10 Inheritance of the new language (surfaces the sketch does not show)

- **Repositories manager** (`repos-page.ts`) — panel header, `st-field` path input, `st-button` actions, empty/offline via `st-empty-state`, rows on `selectable-row`.
- **GitHub account** (`github-account.ts`, `account-profile`, `repo-list`) — retoken only; `repo-list` rows align with `st-repo-card`.
- **Remote dialogs** (`pull/push/fetch`, plus the ref dialogs, git-flow and clone dialogs) — all already sit on `st-modal`; retoken the shell (head/body/footer, radius, overlay, hairline) and move their controls onto `st-field` / `st-button` / `st-toggle-group`. One change benefits 12 dialogs.
- **Search workspace** (`search-workspace.ts`) — retoken; grouped-by-repo eyebrow rows, mono oid in accent, hits on `selectable-row`, `st-empty-state` for the four states. Stays an in-shell workspace, not a route.
- **File status** (`file-status-page.ts`) — becomes the canonical two-pane instance; its three variants (local / commit / pr) inherit the identical geometry, variant bar rebuilt on `st-toggle-group`.
- **Banners** (`checkout-error-banner`, `merge-conflict-banner`) — retoken to `--st-color-danger`/`--st-color-warn` tokens; both stay prominent.

## 5. Phasing

Each phase is independently shippable and reviewable; each ends with the vitest suite green for the touched specs.

**P0 — Token foundation (no intended visual delta). SHIPPED 2026-10-14.** Ship `tokens.scss` + `utilities.scss`, rewire `styles.scss`, add the legacy alias shim, and mechanically remove every `var(--x, #hex)` fallback while ui-kit components are retokenized. *Ships dark looking identical and light looking correct for the first time.*
**P1 — Primitives (additive, nothing consumes them yet). SHIPPED 2026-10-15.** `st-icon`, `st-nav-item`, `st-panel`, `st-field/*`, `st-toggle-group`, `selectable-row`, `st-popover`, `st-live-region`, `workspace-split` + barrel.
**P2 — Shell rebuild. ⚠ RISKIEST. SHIPPED 2026-10-15.** New `top-bar`, `nav-rail`, `status-bar`; drawer pin/popover; retire `shell-header`, `shell-toolbar`, `sidebar-left`; `layout.html/ts/scss` rewritten. Largest single diff, most specs touched, and the only phase that deletes working components — do it behind the P0 tokens so a revert is cheap.
**P3 — History workspace.** `workspace-split` in `repo-page`; commit-detail redesign; graph column header + footer + search/clear; `GraphStore` scroll-offset persistence. *Flagged:* the scroll/selection restore touches store behaviour, so gate on the existing `graph-page.spec.ts` and `graph.store.spec.ts`.
**P4 — Changes & diff workspace. ⚠ LARGE.** `changes-panel` + `hunk-actions` retoken with ± affordances **(the standalone `hunk-actions` block is gone as of ADR-035 — the per-hunk actions render inside `st-diff-viewer`)**; `file-status-page` split; Monaco custom theme + explicit line height + **unified default** + fallback grid. *Flagged:* flipping `renderSideBySide` changes behaviour, not just paint — ship it with the Settings toggle and keep side-by-side one click away.
**P5 — Secondary surfaces. SHIPPED 2026-10-15.** Settings expansion; repos / github-account / search / remote + ref dialogs / banners inherit the language; `st-modal` gains a focus trap.
**P6 — Responsive, a11y & motion polish. SHIPPED 2026-10-16.** Breakpoint utilities (≤1600 / ≤1100 / ≤800), rail→horizontal chip strip, drawer→full-width strip, split collapse, aria audit, motion overrides; regenerate `messages.json` + `messages.es.json`.

---

## 6. Sketch fidelity & divergences

**ADOPT** — top bar as the only chrome band; 64px height; hairline structure; cyan accent for brand/hash/branch/focus/current; eyebrow group headers; `Espacio de trabajo` / `Ramas locales` / `Referencia remota` group names; the 3px inset selection bar; the 2px cyan focus ring with 2–3px offset; `aria-pressed/current/expanded/live`; the single ~180ms fade gated on `prefers-reduced-motion`; the 10/11/12/13/22 scale; 4–5px control/card radii; the diff insert/delete/hunk tints; mono bylines; the 31px bottom bar; the pin/unpin drawer model; the responsive intent (hide the date column, then stack).

| # | Divergence | Reason |
|---|---|---|
| D1 | Multi-repo **tab strip** instead of a single repo-context block | `WorkspacesStore` + ADR-024 make multi-repo first-class; the active tab *is* the repo context. The fs path moves to the tab title and the rail header so no information is lost. |
| D2 | Rail **224px**, not 172px | 172px clips branch names, `remote/branch` refs and the Spanish strings (`Cambios locales`, `Referencia remota`); 224px also matches the existing 260px `--left-w` used for persisted collapse state, easing migration. |
| D3 | **Toolbar row retired** and its 5 inert buttons deleted | The sketch has no toolbar; the buttons produce no effect (`shell-toolbar.ts:18,78-82`) and each already has a working home. Live remote ops move into the top bar rather than being lost. |
| D4 | Fake window glyphs `─ □ ×` **deleted** | The Electron frame owns window controls; static glyphs imply functionality that does not exist. Replacing them with a real frameless titlebar would be an Electron-shell change, outside this plan's scope. |
| D5 | Tags / Stashes / Git Flow **kept** in the rail | Shipped features absent from the mock; removing them to match the sketch would be a feature regression. |
| D6 | Commit detail **does** disclose the changed-file list inline (was: did not) | ADR-0030 made History compare-free and re-homed the file list + diff to File status. A primary `Review changes` CTA preserves the intent. **ADR-032 narrowed this** to a changed-file list **tooltip** next to the CTA (reusing `getDiff` through `StatusStore`); **ADR-033 supersedes that surface** — the list is now an **inline expandable panel** inside the commit-details body (still paths only, still reusing `getDiff`), while the diff stays in File status. |
| D7 | **Routes** kept (`/repo`, `/repo/file-status`) with a pane cross-fade + scroll restore, instead of one screen whose right pane swaps | Preserves deep links, ADR-0029/0030 and route-scoped stores; the restore makes the transition read as a pane swap, which is the sketch's actual perceptual claim. |
| D8 | **CDK virtualization** kept, not a static list | 50k-commit repos are an explicit non-negotiable (`docs/project.md` performance principle, `service-design.md:142`); the sketch's short static list cannot represent them. |
| D9 | **Dynamic** graph column width, not a fixed 58px | Width must track the maximum lane count in the window (`graphWidth = (maxLane+1) * 14`); a fixed 58px misaligns real repos. The lane *palette* is adopted, now via `--st-color-graph-lane-N`. |
| D10 | Pane split is **pinned detail + flexible primary**, not two equal columns | Equal columns starve the graph and the 12px-mono diff and break below ~1200px. Both screens already use pinned/flex geometry. |
| D11 | Spanish mock labels stay **English source strings under `$localize`** | The i18n contract is `$localize` with `en` source + `es` runtime bundle; hardcoding the mock's Spanish would break English and duplicate every id. `messages.json`/`messages.es.json` are regenerated in P6. |
| D12 | Weights **400/500/600/700**, not 550/650 | Inter is not actually loaded (no `@font-face`, CSP forbids remote fonts), so fractional weights resolve unpredictably on the system fallback. |
| D13 | **Monaco** kept as the diff engine (rethemed, unified by default) instead of a hand-rolled grid | ADR-006 chose Monaco for highlighting + the large-file fallback and it is already lazy + worker-isolated. The sketch's grid becomes a *theme* plus unified layout; the literal 4-column grid is implemented in the non-Monaco fallback. |
| D14 | Settings gains a **renderer-local** preferences surface, not a git-config editor | Git config needs core reads/writes; `roadmap-v1.md:59` schedules it for V1. Keeping new controls to `st:`-prefixed localStorage keeps this plan inside the UI layer. |
| D15 | Status bar carries **ambient** status; failure banners stay | Demoting a checkout failure or a merge conflict into a 31px strip would harm recovery. Only the non-blocking per-tab fetch line moves down. |
| D16 | Dark **neutral** ramp is navy/indigo, accent stays cyan (P4.1) | The operator asked for "un poco más como antes" after P4 shipped: the dark surfaces moved onto the app's earlier navy family (canvas `#1e1e2e`, surfaces `#252536`/`#2a2a3a`, raised `#2e2e40`, border `#3a3a52`, text `#e9e9f2`, muted `#a8a8c0`) while the cyan accent, the eight graph lanes, the ref pills and the status colours were deliberately kept. The reference blue `#0a84ff` only reaches ~4.3:1 on these surfaces — below AA for the 11–13px mono hash/path text that consumes `--st-color-accent` — so a literal copy would have broken the identity token's contrast. Geometry, hairlines, radii, type scale and the light theme are untouched. Recorded so the §2.2 charcoal values read as historical. |

---

## 7. Acceptance self-check

- **Full surface coverage** — shell (§3), top bar (4.1), navigation (4.2), commit detail (4.3), local changes (4.4), history/graph (4.5), diff (4.6), drawer (4.7), bottom bar (4.8), settings (4.9), plus the inheriting surfaces (4.10). Nothing in the sketch inventory is unmapped.
- **Region → code mapping** — every proposal cites the file and line it changes, and states whether the result is reused, edited or new.
- **Coherent visual direction traceable to the sketch** — §1 traces each feeling to a specific sketch cue; §2 commits to one palette/scale/geometry/motion set rather than offering choices.
- **Dark and light both consistent** — §2.2 defines every semantic token in both blocks from the same names, with the accent swapped on the light theme for contrast; the token contract makes a missing light value a visible bug instead of a silent fallback.
- **Divergences justified** — 16 numbered items, each with a reason tied to a doc, a contract or a functional constraint.
- **Gate for the operator** — D3 (retiring the toolbar entirely) is the one load-bearing choice below the designer's comfort band (0.65) and is called out here so the orchestrator can confirm it before P2, while P0/P1 remain safe to start immediately.

---

## 8. Companion artefacts — decisions recap, files_to_touch by phase, risks & confidence

### 8.1 decisions recap (14 load-bearing decisions)

1. **layout structure** — Keep `LayoutComponent` as the single app shell, but replace the top zone (48px blue-gradient header + 44px toolbar) with ONE 64px charcoal top bar, add a 31px bottom status bar, and turn the center region into a pinned-detail + flexible-primary two-pane workspace split shared by `/repo` and `/repo/file-status`. *Why:* the sketch's slim chrome band is the largest structural cue; the two-pane split is already the de-facto shape of both routes, so it is a restyle of existing geometry, not new architecture. Routes, `GraphStore`/`StatusStore`/`FileStatusStore`, CDK virtualization and `WorkspacesStore` tabs are preserved; only the chrome layer changes. Aligns with `docs/slices/renderer-slice.md`.
2. **top-bar consolidation / toolbar retirement** — Retire `st-shell-toolbar` as a separate row and delete its 5 inert chrome buttons; move live remote ops into the top-bar action cluster and route navigation into an overflow menu. **Confidence 0.65 — the item to gate.**
3. **token strategy** — Two-tier CSS custom properties owned by ui-kit: Tier 1 primitives (`--st-prim-*`) and Tier 2 semantic (`--st-color-*`, `--st-space-*`, `--st-font-*`, `--st-size-*`, `--st-radius-*`, `--st-motion-*`, `--st-z-*`), shipped as `libs/ui-kit/src/styles/tokens.scss` + `utilities.scss`, with legacy `--left-w/--right-w/--header-h/--toolbar-h/--bottom-h` alive one phase as aliases.
4. **theme system** — Keep `ThemeService` exactly as-is (signal + `data-theme` + `st:theme`) and author a full token set for both themes; accent swaps `#69dfdc` → `#0f7f7c` on light. No third theme.
5. **diff viewer approach** — Keep Monaco as the engine; register `singularitree-dark`/`singularitree-light` themes, set `fontSize:12` with `lineHeight:24` and tokenized gutters, flip default to unified (`renderSideBySide:false`) with a persisted toggle, and rebuild the `<pre>` fallback as the sketch's 4-column grid. Confidence 0.85.
6. **navigation model** — One left nav rail replaces the tabs + toolbar-nav + sidebar triad; groups `Espacio de trabajo` → `Ramas locales` → `Referencia remota` → Tags → Stashes → Git Flow; tabs stay in the top bar; search keeps two entry points.
7. **workspace pane model** — One `st-workspace-split` primitive (pinned 380px detail + flexible primary), not the sketch's two equal columns.
8. **history pane stays compare-free** — Commit detail shows hash + branch chip + 22px subject + description + metadata dl + avatar + one primary `Review changes` CTA; it does not inline the file list (ADR-0030).
9. **icon system** — New dumb `st-icon` backed by an inline-SVG registry authored to Lucide geometry (24 viewBox, `stroke-width:1.8`, 17px render); no new npm dependency.
10. **settings scope** — Expand to Appearance / Workspace / Diff / Language / About, all renderer-local; git-config editing explicitly deferred. Confidence 0.75.
11. **focus, selection and motion** — Global 2px `:focus-visible` ring (offset 2px, −1px inset in rows), selection as `--st-color-selected` fill + 3px inset bar via `box-shadow`, `aria-pressed/current/expanded`, one polite live region, three motion tokens fully disabled under `prefers-reduced-motion`; one z-index scale replaces the ad-hoc 19/20/100/119/120.
12. **typography inventory** — Keep the `Inter, system-ui` and mono stacks; quantize weights to 400/500/600/700; adopt the 10/11/12/13/22 scale plus 17 for the brand; mono restricted to hashes, paths, remote refs, diff code/gutter, counts, keycaps.
13. **retire the inert Tailwind directives** — Remove `@tailwind base/components/utilities` from `styles.scss` and keep tokenized hand-rolled SCSS + a small utilities layer; do not introduce a Tailwind/PostCSS build.
14. *(companion to #7/#8)* **selection and pane-swap affordances** — the 3px inset bar and the 180ms pane cross-fade are the only two mechanisms that express "where am I / what moved", shared by rail, list, file list, search hits and drawer cards via `selectable-row`.

### 8.2 files_to_touch by phase (86 targets, all inside `apps/angular/**` + `libs/ui-kit/**`)

**P0 — token foundation — SHIPPED 2026-10-14**
- `libs/ui-kit/src/styles/tokens.scss` — NEW: canonical two-tier token layer (`--st-prim-*` + `--st-color/space/font/size/radius/motion/z`), dark defaults + light block.
- `libs/ui-kit/src/styles/utilities.scss` — NEW: focus ring, hairline, eyebrow, mono, tabular-nums, selectable-row/selection-bar, hover surface, reduced-motion guard.
- `libs/ui-kit/src/styles/index.ts` — EDIT: replace the `STYLES_PLACEHOLDER` export with the real style entry metadata.
- `apps/angular/src/styles.scss` — EDIT: import ui-kit tokens/utilities, define `:root`/`[data-theme=light]`, add the legacy aliases block; remove the inert `@tailwind` directives.
- `apps/angular/src/styles/_legacy-aliases.scss` — NEW: temporary shim mapping `--left-w/--right-w/--header-h/--toolbar-h/--bottom-h` onto `--st-size-*`.
- `apps/angular/src/app/core/layout/layout.scss` — EDIT: consume the new tokens; delete the local token alias block.
- `libs/ui-kit/src/button/button.ts` — EDIT: retoken, add danger/icon variants, state matrix (dark+light).
- `libs/ui-kit/src/badge/badge.ts` — EDIT: retoken to semantic badge tokens; add status/graph variants used by the rail and rows.
- `libs/ui-kit/src/empty-state/empty-state.ts` — EDIT: retoken, icon slot via `st-icon`, tokenized spacing.
- `libs/ui-kit/src/repo-card/repo-card.ts` — EDIT: retoken, selection via inset accent bar, mono path line.
- `libs/ui-kit/src/graph-row/graph-row.ts` — EDIT: retoken, strip hardcoded `#0a84ff/#30d158/#ff6b6b` ref-fallbacks, tabular-nums, 28px row kept.
- `libs/ui-kit/src/graph-row/lane-palette.ts` — EDIT: `LANE_PALETTE` becomes `var(--st-color-graph-lane-N)` references (contract unchanged: numeric slot → colour).
- `libs/ui-kit/src/diff-viewer/diff-viewer.ts` — EDIT: retoken notices, wire the new Monaco theme + unified default + toggle input.

**P1 — primitives — SHIPPED 2026-10-15**
- `libs/ui-kit/src/icon/icon.ts` — NEW: dumb `st-icon` (24 viewBox, stroke 1.8, 17px render, currentColor).
- `libs/ui-kit/src/icon/icons.ts` — NEW: inline SVG path registry (nav, actions, status, file-status, chevrons, brand glyph).
- `libs/ui-kit/src/icon/index.ts` — NEW: barrel.
- `libs/ui-kit/src/nav-item/nav-item.ts` — NEW: rail item (icon, label, count, `aria-current`/`aria-pressed`, 3px inset selected bar).
- `libs/ui-kit/src/panel/panel.ts` — NEW: panel + sticky section header (13/600 + optional badge slot).
- `libs/ui-kit/src/field/input.ts` — NEW: tokenized text/search input.
- `libs/ui-kit/src/field/textarea.ts` — NEW: tokenized textarea (commit message).
- `libs/ui-kit/src/field/select.ts` — NEW: tokenized select (PR target, ref pickers).
- `libs/ui-kit/src/toggle-group/toggle-group.ts` — NEW: segmented control (theme/language/density/diff mode/variant bar).
- `libs/ui-kit/src/selectable-row/selectable-row.ts` — NEW: reusable row with hover/selected/focus-visible/disabled states.
- `libs/ui-kit/src/popover/popover.ts` — NEW: floating layer with Escape + outside-click + focus-out close (replaces ad-hoc fixed menus).
- `libs/ui-kit/src/live-region/live-region.component.ts` — NEW: polite/assertive announcer host.
- `libs/ui-kit/src/live-region/live-region.service.ts` — NEW: signal-backed `announce()` for the status bar.
- `libs/ui-kit/src/workspace-split/workspace-split.ts` — NEW: pinned-detail + flexible-primary two-pane primitive used by `/repo` and `/repo/file-status`.
- `libs/ui-kit/src/index.ts` — EDIT: export the new primitives.

**P2 — shell rebuild ⚠ — SHIPPED 2026-10-15**
- `apps/angular/src/app/core/layout/ui/top-bar/top-bar.ts` — NEW: 64px shell top bar (brand, repo tab strip, remote action cluster, sync pill, overflow menu, drawer toggle, drag region).
- `apps/angular/src/app/core/layout/ui/top-bar/top-bar.spec.ts` — NEW: tab select/close/add, overflow menu, `aria-expanded`, disabled remote ops.
- `apps/angular/src/app/core/layout/ui/nav-rail/nav-rail.ts` — NEW: 224px rail (repo header, Espacio de trabajo, Ramas locales + filter, Referencia remota, Tags, Stashes, Git Flow, collapse).
- `apps/angular/src/app/core/layout/ui/nav-rail/nav-rail.spec.ts` — NEW: group rendering, active state, count pill, ref context menus, loading/offline/empty branches.
- `apps/angular/src/app/core/layout/ui/status-bar/status-bar.ts` — NEW: 31px bar (repo · branch · short-hash, sync/online state, live region).
- `apps/angular/src/app/core/layout/ui/repo-drawer/repo-drawer.ts` — EDIT: pin/unpin toggle, popover mode at all widths, retoken, focus-out close.
- `apps/angular/src/app/core/layout/ui/shell-header/shell-header.ts` — DELETE after top-bar lands (retained one phase for parity).
- `apps/angular/src/app/core/layout/ui/shell-header/shell-header.spec.ts` — DELETE with its component.
- `apps/angular/src/app/core/layout/ui/shell-toolbar/shell-toolbar.ts` — DELETE after the live remote ops move into the top bar; inert chrome buttons are removed, not relocated.
- `apps/angular/src/app/core/layout/ui/shell-toolbar/shell-toolbar.spec.ts` — DELETE with its component.
- `apps/angular/src/app/core/layout/ui/sidebar-left/sidebar-left.ts` — DELETE after nav-rail lands (its ref/context-menu logic is the migration source).
- `apps/angular/src/app/core/layout/ui/sidebar-left/sidebar-left.spec.ts` — DELETE with its component.
- `apps/angular/src/app/core/layout/ui/fetch-all-status/fetch-all-status.ts` — EDIT: render the single-repository fetch line into the status-bar live region instead of a banner row.
- `apps/angular/src/app/core/layout/ui/checkout-error-banner/checkout-error-banner.ts` — EDIT: retoken (kept as a prominent banner, not demoted to the status bar).
- `apps/angular/src/app/core/layout/ui/merge-conflict-banner/merge-conflict-banner.ts` — EDIT: retoken to `--st-color-warn` tokens.
- `apps/angular/src/app/core/layout/layout.html` — EDIT: new region order (top-bar | banners | body(rail|split|drawer) | status-bar).
- `apps/angular/src/app/core/layout/layout.ts` — EDIT: rename state flags, add drawer pinned state, wire status-bar signals.
- `apps/angular/src/app/core/layout/layout.spec.ts` — EDIT: shell composition + persisted layout state.

**P3 — history workspace**
- `apps/angular/src/app/features/repo/page/repo-page.ts` — EDIT: mount `st-workspace-split`, drop the duplicated page title header.
- `apps/angular/src/app/features/repo/page/repo-page.spec.ts` — EDIT: split layout wiring.
- `apps/angular/src/app/features/repo/graph/page/graph-page.ts` — EDIT: pane swap to (left detail | right list), sticky column header `Grafo|Commit/autor|Fecha`, search with clear, footer `N of M commits`.
- `apps/angular/src/app/features/repo/graph/page/graph-page.spec.ts` — EDIT: column header, filter clear, WIP selection path.
- `apps/angular/src/app/features/repo/graph/ui/commit-details-panel.ts` — EDIT: cyan mono short hash + branch chip, 22px subject, muted description, metadata dl with 24px initials avatar, single primary CTA routing to `/repo/file-status`.
- `apps/angular/src/app/features/repo/graph/ui/commit-details-panel.spec.ts` — EDIT: avatar initials, CTA emit, committer secondary line.
- `apps/angular/src/app/features/repo/graph/ui/wip-row.ts` — EDIT: retoken dashed WIP node to graph tokens.
- `apps/angular/src/app/features/repo/graph/graph.store.ts` — EDIT: persist/restore CDK scroll offset so returning from `/repo/file-status` restores selection + viewport.
- `apps/angular/src/app/features/repo/graph/graph.store.spec.ts` — EDIT: scroll-offset persistence.
- `apps/angular/src/app/features/repo/graph/ui/graph-context-menu.ts` — EDIT: move to `st-popover`, retoken, add danger/token rules.
- `apps/angular/src/app/features/repo/ui/repo-picker.ts` — EDIT: demote to a first-run empty state inside the history pane.

**P4 — changes & diff workspace ⚠**
- `apps/angular/src/app/features/repo/status/ui/changes-panel.ts` — EDIT: staged/unstaged groups with ± stage/discard icon buttons, eyebrow headings, commit box on `st-textarea` + primary `st-button`.
- `apps/angular/src/app/features/repo/status/ui/changes-panel.spec.ts` — EDIT: stage/unstage affordances, commit enablement.
- `apps/angular/src/app/features/repo/status/ui/hunk-actions.ts` — EDIT: retoken + icon actions (stage/unstage/discard hunk). **(Deleted by ADR-035: the component is gone, `isHunkActionable` moved to `status/ui/hunk-actions.model.ts` and the affordances render inline in `st-diff-viewer`.)**
- `apps/angular/src/app/features/repo/file-status/page/file-status-page.ts` — EDIT: adopt `st-workspace-split` (file list left, diff right always).
- `apps/angular/src/app/features/repo/file-status/page/file-status-page.spec.ts` — EDIT: split geometry + variant routing.
- `apps/angular/src/app/features/repo/file-status/ui/file-diff-list.ts` — EDIT: retoken, amber status letters, `+N/−N` mono, selection bar.
- `apps/angular/src/app/features/repo/file-status/ui/file-status-variant-bar.ts` — EDIT: rebuild on `st-toggle-group` + `st-input`/`st-select`.
- `libs/ui-kit/src/diff-viewer/monaco-theme.ts` — NEW: `singularitree-dark`/`singularitree-light` `IStandaloneThemeData` generated from the token values.
- `libs/ui-kit/src/diff-viewer/monaco-loader.ts` — EDIT: register the custom themes before handing back the module.
- `libs/ui-kit/src/diff-viewer/diff-viewer.spec.ts` — EDIT: unified default + theme registration + retokenized fallback grid.

**P5 — secondary surfaces — SHIPPED 2026-10-15**
- `apps/angular/src/app/features/settings/settings.ts` — EDIT: expand to Appearance / Workspace / Diff / Language / About using the new primitives.
- `apps/angular/src/app/features/settings/settings.spec.ts` — EDIT: new preference groups + persistence.
- `apps/angular/src/app/core/services/preferences.service.ts` — NEW (added in P5, not in the original manifest): renderer-local `st:` preference signals (`st:motion`, `st:density`, `st:paneWidth`, `st:diffFontSize`, `st:diffWordWrap`), following the `theme.service.ts` / `diff-mode.service.ts` pattern.
- `apps/angular/src/app/core/services/preferences.service.spec.ts` — NEW (added in P5, not in the original manifest).
- `apps/angular/src/app/features/repos/repos-page.ts` — EDIT: inherit the new language (panel header, `st-field`, `st-button`, `st-empty-state`).
- `apps/angular/src/app/features/github-account/github-account.ts` — EDIT: inherit the new language.
- `apps/angular/src/app/features/github-account/ui/account-profile/account-profile.ts` — EDIT: retoken.
- `apps/angular/src/app/features/github-account/ui/repo-list/repo-list.ts` — EDIT: retoken, `st-repo-card` alignment.
- `apps/angular/src/app/features/remote/ui/pull-dialog/pull-dialog.ts` — EDIT: retoken via `st-modal`/`st-field`/`st-button`.
- `apps/angular/src/app/features/remote/ui/push-dialog/push-dialog.ts` — EDIT: retoken.
- `apps/angular/src/app/features/remote/ui/fetch-dialog/fetch-dialog.ts` — EDIT: retoken.
- `apps/angular/src/app/features/search/ui/search-workspace.ts` — EDIT: retoken; grouped-by-repo rows on `selectable-row`, mono oid, cyan hit affordance.
- `apps/angular/src/app/shared/ui/modal/modal.ts` — EDIT: retoken, add a focus trap + focus restore, move to the z-scale token.
- `apps/angular/src/app/shared/ui/ref-dialogs/*.ts` — EDIT: retoken the six ref dialogs (`merge`, `branch-create`, `ref-rename`, `ref-delete-confirm`, `tag-create`, `stash-push`) plus `stash-drop-confirm` onto modal + field + button primitives.
- `apps/angular/src/app/shared/ui/git-flow-dialog/git-flow-dialog.ts` — EDIT: retoken.
- `apps/angular/src/app/shared/ui/clone-dialog/clone-dialog.ts` — EDIT: retoken.
- `apps/angular/src/app/core/layout/ui/switch-branch-confirm-dialog/switch-branch-confirm-dialog.ts` — EDIT (added in P5, not in the original manifest): bounded adjacent consistency pass.
- `apps/angular/src/app/features/repo/graph/ui/reset-confirm-dialog.ts` — EDIT (added in P5, not in the original manifest): bounded adjacent consistency pass.
- `libs/ui-kit/src/field/input.ts` / `select.ts` / `textarea.ts` — EDIT (added in P5, not in the original manifest): additive `testId` input forwarded to the inner native control with the previous default preserved; `st-input` also gained `readonly`.
- `apps/angular/src/styles/_legacy-aliases.scss` — DELETE (added in P5, not in the original manifest): shim retired once its last 11 `var(--muted, #8a8a9a)` consumers were removed from the P5 dialogs.
- `apps/angular/src/styles.scss` — EDIT (added in P5, not in the original manifest): remove the `_legacy-aliases` `@use`.

**P6 — responsive, a11y & motion — SHIPPED 2026-10-16**
- `libs/ui-kit/src/styles/utilities.scss` — EDIT: add the ≤1600 / ≤1100 / ≤800 breakpoint utilities (hide date/byline, stacked nav chips, full-width drawer strip).
- `apps/angular/src/app/core/layout/layout.scss` — EDIT: responsive rules for the rail/drawer/split collapse.
- `apps/angular/src/locale/messages.json` — REGENERATE: new `$localize` ids from the facelift.
- `apps/angular/src/locale/messages.es.json` — REGENERATE: Spanish renderings for every new string.
- `apps/angular/src/app/core/i18n/i18n-runtime.spec.ts` — EDIT: guard that the new ids resolve in both locales.

### 8.3 Risks, gates & confidence notes

- **Overall confidence: 0.78.**
- **P2 (shell rebuild) is the riskiest phase** — largest single diff, most specs touched, and the only phase that *deletes* working components (`shell-header`, `shell-toolbar`, `sidebar-left`). Mitigation: land it strictly on top of the P0 tokens so a revert is a stylesheet revert, and keep each retired component for exactly one phase for parity checks.
- **D3 / decision #2 is the one gate (confidence 0.65):** retiring the toolbar row entirely rather than keeping a slim 40px action row. It is above the hard 0.5 floor, so it does not block P0/P1, but the orchestrator should echo it with the operator before P2 starts.
- **P4 behaviour change:** flipping Monaco's `renderSideBySide` default is a behavioural change, not a paint change — ship it with the Settings toggle and keep side-by-side one click away.
- **P3 store touch:** the scroll/selection restore is the only P3 change that alters store behaviour, so gate it on the existing `graph-page.spec.ts` and `graph.store.spec.ts`.
- **Confirmed codebase facts relied upon:** Tailwind has no config, no PostCSS pipeline and no dependency (inert directives); `index.html` loads no font files (Inter is not shipped); `layout.html` mounts 10+ dialogs on `st-modal`; `git:watch`/`fs:changed` re-homing is already documented in `docs/slices/renderer-slice.md` under ADR-0030.
- **Nothing outside `apps/angular/**` and `libs/ui-kit/**` is touched.** No Go core, no contracts/proto, no Electron shell/IPC, no IPC contract change.
