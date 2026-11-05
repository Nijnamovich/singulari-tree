---
last_updated: 2026-10-25
status: active
description: Shipped SingulariTree renderer design system — the Dark Neon / Developer Studio palette in dark and light, the two-tier CSS custom property vocabulary, typography, spacing and geometry, the ui-kit component inventory, and copy-paste usage.
tags:
- design-system
- renderer
- tokens
- theming
- ui-kit
version: 1.8
related:
- renderer-redesign-plan
- renderer-slice
---

# SingulariTree — Dark Neon / Developer Studio — Style Reference

> near-black workbench — blue-tinted dark surfaces, hairline structure, and bright accents reserved for semantic roles

**Theme:** dark (default) + light (`[data-theme='light']`)

SingulariTree's renderer reads as a dense-but-calm desktop instrument: a near-black, slightly blue-tinted workbench where structure comes from 1px hairlines and type weight instead of boxes and gradients, and where bright accents are **reserved for semantic roles** so hierarchy comes from colour *intensity* rather than everything glowing at once. The budget is roughly **~70% dark surfaces** (canvas, chrome, rail, surface), **~20% neutral structure and text** (borders, muted type), and **~10% bright accents** — and the commit graph is the only continuously-drawn, saturated element on screen. Panels are flat and separated by a hairline, list rows stay legible at 12–13px with a mono byline. The system ships as two tiers of CSS custom properties in `libs/ui-kit/src/styles/tokens.scss`: raw primitives (`--st-prim-*`, never referenced by a component) and a semantic layer (`--st-color/space/font/size/radius/motion/z-*`, the only layer components consume). Every semantic token is defined twice — in `:root` (dark defaults) and in a matched `[data-theme='light']` block — so a light value can never silently fall back to a dark one. This is the shipped state of the committed direction in [[renderer-redesign-plan]] §2.

> **P4.2 Dark Neon remap (2026-10-15).** At the operator's request the dark theme moved off the P4.1 navy/indigo ramp onto a near-black, slightly blue-tinted **Dark Neon / Developer Studio** surface ramp — canvas `#171923`, rail `#191d28`, surface `#1f2433`, surface-2 `#262b3b`, raised `#2a3040`, border `#333a4d`, text `#e7ecf7`, muted `#9aa3b8` — with a strict intensity budget (~70% surfaces / ~20% neutral structure and text / ~10% bright accents). Accent roles are now assigned **per meaning**: turquoise `--st-color-accent` (`#37e0d0`) = interaction / selection / focus / graph connections / the primary action / `HEAD` refs; violet `--st-color-ref-branch` (`#a78bfa`) = local branches; the **new** electric blue `--st-color-info` (`#60a5fa`) = navigation / links / history / informational and `origin/*` remotes; amber `--st-color-warn` (`#fbbf24`) = pending changes / warnings / tags; mint `--st-color-add` (`#6ee7b7`) = the mainline ref (the new `--st-color-ref-main`), staged and the sync indicator; coral `--st-color-danger` (`#fb7185`) is **reserved** for errors, failures and conflicts only. `#37e0d0` reads ~11:1 against the `#171923` canvas, comfortably clearing WCAG AA for the 11–13px mono hash/path text that consumes `--st-color-accent` — which is why turquoise, not a darker blue, carries the accent role. Geometry, hairlines, radii, the type scale and the light theme's neutrals, status and diff values are untouched; only the dark colour family — plus the light selection / graph / ref / avatar values, so the two themes stay role-symmetric — moved. The full rationale is written in `tokens.scss`'s header note.

## Tokens — Colors

### Semantic layer (dark + light)

Both values are shown for every token: the dark value is defined in `:root`, the light value in `[data-theme='light']`. Components consume only these names.

**Surface and text**

| Name | Token | Dark | Light | Role |
|------|-------|------|-------|------|
| App canvas | `--st-color-bg` | `#171923` | `#f7f8f7` | shell background, routed region |
| Chrome | `--st-color-chrome` | `#1b1f2b` | `#eceeed` | top bar and status bar |
| Rail | `--st-color-rail` | `#191d28` | `#f0f2f1` | nav rail |
| Surface | `--st-color-surface` | `#1f2433` | `#ffffff` | panels, panes, cards |
| Surface 2 | `--st-color-surface-2` | `#262b3b` | `#f4f6f5` | raised strips, table header, field background |
| Raised | `--st-color-raised` | `#2a3040` | `#ffffff` | popovers, modals |
| Border | `--st-color-border` | `#333a4d` | `#d8dcda` | hairline structure |
| Border strong | `--st-color-border-strong` | `color-mix(border 94%, text)` | `color-mix(border 90%, text)` | pane dividers, focus-adjacent edges |
| Text | `--st-color-text` | `#e7ecf7` | `#14181a` | primary text |
| Muted | `--st-color-muted` | `#9aa3b8` | `#5b6668` | bylines, paths, metadata |

**Accent, info and selection**

| Name | Token | Dark | Light | Role |
|------|-------|------|-------|------|
| Accent | `--st-color-accent` | `#37e0d0` | `#0f7f7c` | turquoise — interaction, selection, focus, graph connections, primary action, `HEAD` refs |
| Accent soft | `--st-color-accent-soft` | `color-mix(accent 14%)` | `color-mix(accent 12%)` | active nav fill, accent badges, hover menu items |
| Accent contrast | `--st-color-accent-contrast` | `#10241f` | `#ffffff` | text on accent fills |
| Focus | `--st-color-focus` | `#37e0d0` | `#0f7f7c` | `:focus-visible` ring |
| Info | `--st-color-info` | `#60a5fa` | `#1d4ed8` | electric blue — navigation, links, history, informational; `origin/*` remotes |
| Selected fill | `--st-color-selected` | `#2a3149` | `#e2e6f8` | selected row fill (blue-violet) |
| Selection bar | `--st-color-selected-bar` | `#37e0d0` | `#0f7f7c` | 3px inset selection bar |
| Selected border | `--st-color-selected-border` | `#46517a` | `#a9b4e8` | selected row hairline |

**Status**

| Name | Token | Dark | Light | Role |
|------|-------|------|-------|------|
| Add | `--st-color-add` / `-soft` | `#6ee7b7` / `mix 14%` | `#1c7c3c` / `mix 10%` | mint — `+N` stats, staged, mainline ref, sync indicator, add badge |
| Remove | `--st-color-remove` / `-soft` | `#ffacaf` / `mix 14%` | `#b3261e` / `mix 10%` | `−N` stats, discard (kept lighter than coral so coral stays reserved) |
| Warn | `--st-color-warn` / `-soft` | `#fbbf24` / `mix 14%` | `#8a6100` / `mix 10%` | amber — modified, ahead/behind, pending pull, tags |
| Danger | `--st-color-danger` / `-soft` | `#fb7185` / `mix 14%` | `#b3261e` / `mix 10%` | coral — destructive actions, errors, failures, conflicts only (**RESERVED**) |

**Diff tints**

| Name | Token | Dark | Light | Role |
|------|-------|------|-------|------|
| Insert | `--st-color-diff-insert-bg` / `-fg` | `#17322b` / `#b4f1d6` | `#e6f7ea` / `#14532d` | added lines |
| Delete | `--st-color-diff-delete-bg` / `-fg` | `#3a2229` / `#fdd3d9` | `#fde8e9` / `#7f1d1d` | removed lines |
| Hunk | `--st-color-diff-hunk-bg` / `-fg` | `#1c2634` / `#a9c8ee` | `#e8f4f3` / `#0f5f5c` | hunk headers |
| Gutter | `--st-color-diff-gutter-bg` / `-fg` | `#191d28` / `#8590a3` | `#f4f6f5` / `#626c66` | line-number columns |

**Graph lanes and ref pills**

Lane colours are drawn from the neon hue set; no lane uses the reserved coral hex. Light lanes are the same neon hues darkened for light surfaces. Ref pill colours are keyed on the **reference TYPE** — `head` / local branch / mainline branch / remote / tag — never per commit.

| Name | Token | Dark | Light | Role |
|------|-------|------|-------|------|
| Lane 1 | `--st-color-graph-lane-1` | `#37e0d0` | `#0d9488` | graph lane colour (turquoise) |
| Lane 2 | `--st-color-graph-lane-2` | `#a78bfa` | `#7c3aed` | graph lane colour (violet) |
| Lane 3 | `--st-color-graph-lane-3` | `#fbbf24` | `#d97706` | graph lane colour (amber) |
| Lane 4 | `--st-color-graph-lane-4` | `#6ee7b7` | `#059669` | graph lane colour (mint) |
| Lane 5 | `--st-color-graph-lane-5` | `#fb923c` | `#ea580c` | graph lane colour (orange) |
| Lane 6 | `--st-color-graph-lane-6` | `#60a5fa` | `#2563eb` | graph lane colour (electric blue) |
| Lane 7 | `--st-color-graph-lane-7` | `#a3e635` | `#4d7c0f` | graph lane colour (lime) |
| Lane 8 | `--st-color-graph-lane-8` | `#7dd3fc` | `#0284c7` | graph lane colour (sky) |
| Ref — HEAD | `--st-color-ref-head` | `#37e0d0` | `#0f7f7c` | `HEAD` ref pill |
| Ref — branch | `--st-color-ref-branch` | `#a78bfa` | `#7c3aed` | local branch ref pill |
| Ref — main | `--st-color-ref-main` | `#6ee7b7` | `#047857` | mainline branch ref pill (`main` / `master`) |
| Ref — remote | `--st-color-ref-remote` | `#60a5fa` | `#1d4ed8` | `origin/*` remote ref pill |
| Ref — tag | `--st-color-ref-tag` | `#fbbf24` | `#8a6100` | tag ref pill |

`--st-color-ref-main` is keyed on the reference **type**, not per commit: a branch named `main` or `master` is classified by `isMainlineBranch()` in `libs/ui-kit/src/graph-row/graph-row.utils.ts`, and both `st-graph-row` (`st-graph-row__ref--main`) and `commit-details-panel` (`st-commit-details__ref--main`) share that classification.

**Badges and misc**

Badge fills are a low-alpha mix of the hue with a solid foreground; graph badges reuse `--st-color-graph-lane-N`.

| Name | Token | Role |
|------|-------|------|
| Branch badge | `--st-color-badge-branch-bg` / `-fg` | `color-mix(accent 12%)` fill, accent foreground |
| Tag badge | `--st-color-badge-tag-bg` / `-fg` | `color-mix(warn 12%)` fill, warn foreground |
| Success badge | `--st-color-badge-success-bg` / `-fg` | `color-mix(add 12%)` fill, add foreground |
| Warning badge | `--st-color-badge-warning-bg` / `-fg` | `color-mix(warn 12%)` fill, warn foreground |
| Avatar | `--st-color-avatar-bg` / `-fg` | `#2a3040`/`#a78bfa` (dark), `#e7e2fb`/`#5b21b6` (light) |
| Overlay | `--st-color-overlay` | `rgba(15,18,32,.62)` (dark), `rgba(20,24,26,.35)` (light) |

### Tier-1 primitives

Raw, theme-independent values. Never reference these from a component — they exist only so the semantic layer has a single vocabulary to draw from.

```
ink-900 #171923   ink-850 #191d28   ink-800 #1f2433   ink-750 #262b3b
ink-700 #2a3040   ink-600 #333a4d   ink-050 #e7ecf7   ink-300 #9aa3b8
cyan-400 #37e0d0  cyan-500 #1fa79e  cyan-600 #177f79  cyan-700 #0d4f4b
violet-400 #a78bfa blue-400 #60a5fa amber-400 #fbbf24 coral-400 #fb7185 mint-300 #6ee7b7 rose-300 #ffacaf
diff    ins-bg #17322b ins-fg #b4f1d6   del-bg #3a2229 del-fg #fdd3d9   hunk-bg #1c2634 hunk-fg #a9c8ee
graph   lane-1 #37e0d0 lane-2 #a78bfa lane-3 #fbbf24 lane-4 #6ee7b7 lane-5 #fb923c lane-6 #60a5fa lane-7 #a3e635 lane-8 #7dd3fc
avatar  avatar-bg #2a3040 avatar-fg #a78bfa
```

> The neutral primitives are the blue-tinted near-black ramp shipped by the P4.2 Dark Neon remap; the turquoise accent, the other bright accent primitives, the diff tints and the graph lanes belong to the Dark Neon family.

## Tokens — Typography

### Inter — UI and body family · `--st-font-ui`

`Inter, system-ui, -apple-system, sans-serif`. Every non-code surface uses this stack: nav labels, buttons, commit subjects, settings, table headers. No font asset is bundled (the CSP forbids remote fonts), so the stack resolves to `system-ui` on most machines. Weights are quantised to **400 / 500 / 600 / 700** — fractional weights (550/650) resolve unpredictably on the system fallback and are not used.

### Mono — hashes, paths and code · `--st-font-mono`

`Consolas, 'Liberation Mono', ui-monospace, SFMono-Regular, Menlo, monospace`. Mono is reserved for mechanisms where character alignment matters: commit oids (short and full), fs paths, `remote/branch` ref names, diff code and gutter numbers, `+N/−N` counts, keycaps and dates. It is never used for nav labels, buttons, settings labels, commit subjects or table headers.

### Type Scale

Sizes come from the numeric `--st-font-*` tokens; line heights from `--st-leading-tight` (1.25, dense rows), `--st-leading-ui` (1.5, prose and descriptions) and `--st-leading-code` (24px, the 12px mono diff/editor grid).

| Role | Size | Line height | Token | Use |
|------|------|-------------|-------|-----|
| eyebrow | 11px | 1.25 | `--st-font-11` | uppercase group headers (`.st-eyebrow`, `letter-spacing: .08em`, muted) |
| byline / meta | 11px | 1.5 | `--st-font-11` | muted metadata, dates, paths |
| row subject / label | 12px | 1.25 | `--st-font-12` | list rows, controls, table cells |
| body | 13px | 1.5 | `--st-font-13` | shell base size, prose, descriptions |
| brand | 17px | 1.25 | `--st-font-17` | top-bar wordmark; the default `st-icon` render size |
| detail subject | 22px | 1.25 | `--st-font-22` | commit subject in the detail pane |
| code | 12px | 24px | `--st-font-12` + `--st-font-mono` | diff/editor grid (`.st-leading-code`) |

All numeric columns set `font-variant-numeric: tabular-nums` (`.st-tabular-nums`) so dates and counts do not jitter.

## Tokens — Spacing & Shapes

**Base unit:** 4px · **Density:** compact

### Spacing Scale

| Name | Value | Token |
|------|-------|-------|
| 1 | 4px | `--st-space-1` |
| 2 | 8px | `--st-space-2` |
| 3 | 12px | `--st-space-3` |
| 4 | 16px | `--st-space-4` |
| 5 | 20px | `--st-space-5` |
| 6 | 24px | `--st-space-6` |
| 7 | 32px | `--st-space-7` |
| 8 | 40px | `--st-space-8` |

### Border Radius

| Element | Value | Token |
|---------|-------|-------|
| micro chips | 3px | `--st-radius-1` |
| controls (nav items, inputs, toggles) | 4px | `--st-radius-2` |
| cards and panels | 5px | `--st-radius-3` |
| popovers, drawer | 8px | `--st-radius-4` |
| pills (badges, ref pills) | 999px | `--st-radius-pill` |

### Geometry

| Token | Value | Role |
|-------|-------|------|
| `--st-hairline` | 1px | the single structural separator (panels never use shadows) |
| `--st-size-topbar` | 64px | shell top bar |
| `--st-size-statusbar` | 31px | shell status bar |
| `--st-size-rail` | 224px | nav rail |
| `--st-size-rail-collapsed` | 40px | collapsed nav rail |
| `--st-size-drawer` | 264px | repo drawer (pinned) |
| `--st-size-detail-pane` | 380px | pinned detail pane in a split |
| `--st-size-pane-min` | 320px | minimum pane and popover width |
| `--st-size-row-graph` | 28px | commit-graph row (frozen — must equal `GRAPH_ROW_HEIGHT`) |
| `--st-size-row-tree` | 28px | tree/file row — overridden at runtime by the density preference (28px comfortable / 24px compact via `:root[data-st-density=…]`); the only token density touches, so `--st-size-row-graph` and `--st-size-row-tree-dense` stay unaffected |
| `--st-size-row-tree-dense` | 24px | dense tree row, nav item, split detail header |
| `--st-size-control-sm` | 24px | small control (icon buttons, toggle segments) |
| `--st-size-control-md` | 28px | medium control (buttons, inputs) |
| `--st-size-control-lg` | 32px | large control |
| `--st-size-tab` | 220px | repo tab base/max width in the shell top bar (uniform tab geometry) |
| `--st-size-selection-bar-w` | 3px | inset selection bar width |

### Motion

| Token | Value | Use |
|-------|-------|-----|
| `--st-motion-fast` | 120ms | hover/press colour and border transitions |
| `--st-motion-base` | 180ms | popover open, pane mode swap |
| `--st-motion-slow` | 240ms | drawer width |
| `--st-ease` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | the single easing curve |

Two guards in `utilities.scss` neutralise the whole set: the `prefers-reduced-motion: reduce` guard is scoped to `:root:not([data-st-motion='on'])`, so an explicit user `on` survives an OS "reduce"; and a `:root[data-st-motion='off']` guard neutralises unconditionally, with no media query. `PreferencesService` enforces the Settings `auto | on | off` choice at runtime by writing `<html data-st-motion>` (mirroring `ThemeService`'s `data-theme`) — `auto` removes the attribute and follows the OS, `on` opts back in, `off` kills motion. There is no motion on selection change, scroll, or graph rows.

Density is enforced the same way: `PreferencesService` writes `<html data-st-density="compact|comfortable">` synchronously at construction and from an `effect()` on every change (both values explicit — there is no "follow the OS" state, so the attribute is never removed). The sole consumer is the `:root[data-st-density=…]` override of `--st-size-row-tree` (24px compact / 28px comfortable), which flips every file/tree row consumer at once while the frozen graph row and the dense-row token stay untouched. Motion and density are the **two runtime-enforced preferences**; the other `st:` keys (`paneWidth`, `diffFontSize`, `diffWordWrap`) are consumed through component inputs, not by the service.

### Z-index scale

`--st-z-sticky` 10 · `--st-z-rail` 15 · `--st-z-backdrop` 30 · `--st-z-drawer` 35 · `--st-z-popover` 40 · `--st-z-menu` 45 · `--st-z-modal` 100 · `--st-z-toast` 120.

### Utilities

`libs/ui-kit/src/styles/utilities.scss` carries the shared classes that express the direction: `.st-focus-ring` (2px ring, offset 2px) and `.st-focus-ring--inset` (offset −1px, for rows); `.st-hairline` plus its `--top/--left/--right` variants; `.st-eyebrow`; `.st-mono` and `.st-tabular-nums`; `.st-hover-surface`; the selection pair `.st-selectable-row` / `.st-selection-bar`; and the responsive breakpoint utilities `.st-hide-at-1600` / `.st-hide-at-1100` / `.st-hide-at-800` (each `display: none` inside its `max-width` query) plus `.st-chip-strip` (the ≤1100 wrapping chip row).

## Components

All shipped primitives live under `libs/ui-kit/src/` and are exported from the barrel `libs/ui-kit/src/index.ts`.

### `st-button`
**Role:** the single action element

Variants `default | primary | ghost | danger | info | icon`; sizes `sm` (24px) `md` (30px). `default` is a bordered surface button; `primary` fills with `--st-color-accent` and uses `--st-color-accent-contrast` text and carries the **one permitted glow** in the system (`0 2px 10px` turquoise at 22%); `ghost` is transparent; `danger` is transparent with `--st-color-danger` (coral) text; `info` is neutral/muted at rest and takes the electric-blue `--st-color-info` border and label only while hovered or focused; `icon` is square and sized by `--st-size-control-sm|md`. Focus uses a 2px `--st-color-focus` outline. `ariaLabel` is forwarded to the inner native button; `pressed` (`boolean | null`) is forwarded as `aria-pressed` for toggle chips and is omitted when null; `ariaDescribedby` (`string | null`) is forwarded as `aria-describedby` — the commit-details padlock and the two contextual nav controls (the "Close" control in History and the "History" control in the analyzer) use it to point at their ~1 s delayed tooltips — and is omitted when null.

### `st-badge`
**Role:** pill label for branch, tag, status and graph state

Variants `neutral | branch | tag | success | warning | add | remove | warn | danger | graph-1 … graph-8`. Pill radius, 10px type. Status fills are a low-alpha mix of the hue; the foreground is the solid hue. The `branch` badge uses the turquoise accent; `tag` uses amber; `success` uses mint; `warning` uses amber.

### `st-icon`
**Role:** decorative inline glyph

A dumb renderer over an inline-SVG registry (`icon/icons.ts`): 24×24 viewBox, `stroke-width: 1.8`, `stroke: currentColor`, rendered at 17px (`--st-font-17`) by default. Always `aria-hidden` — the accessible name belongs to the host control. An unknown `name` renders nothing and is never an error. The registry also carries the padlock pair `lock` / `lock-open` (the commit-details selection lock; `pin` / `pin-off` stay untouched for the drawer's pin model).

### `st-nav-item`
**Role:** navigation-rail entry

Icon + label + optional count pill (a neutral `st-badge`, hidden when the count is 0). The active state is the shared selection treatment: `--st-color-accent` text, a faint `--st-color-accent-soft` fill, a turquoise `--st-color-accent` hairline border and the 3px inset selection bar, with `aria-current="page"`. The icon inherits `currentColor`, so the active icon turns turquoise too. The border is always reserved (`transparent` when inactive) and the global `box-sizing: border-box` keeps the 24px (`--st-size-row-tree-dense`) outer box.

### `st-panel`
**Role:** pane container with a sticky section header

Two slots: an element marked `[header]` composes the header strip (eyebrow + title + optional badge); the default slot is the body. Surface background, 1px border, `--st-radius-3`. The header is sticky by default.

### `st-input` / `st-textarea` / `st-select`
**Role:** controlled form fields

The parent owns the state; each control re-emits its value on input/change. Surface-2 background, hairline border, `--st-radius-2`, and a border-to-accent focus state. `st-input` is `text | search | password`; `st-textarea` is the commit-message box; `st-select` projects native `<option>` children. All three accept an additive `testId` input, forwarded to the inner native control with the previous default preserved; `st-input` also accepts `readonly` (used by the read-only remote-URL displays).

### `st-toggle-group`
**Role:** segmented control

`options[]` + `value` + `valueChange`, one segment active at a time. Surface-2 track, 24px segments, the active segment raised to the surface colour. An option may carry an optional per-segment `count` (a small accent-tinted pill after the label, hidden when absent or zero and capped at `99+`, tabular-nums — e.g. the pending-file count on the variant bar's "Local" segment) and an optional per-segment `disabled` (a single segment can be disabled while the group stays enabled — the commit-details switch disables `description` for a commit with no message at all (a subject-only commit stays selectable)); a whole-group `disabled` input is also available. Used for theme, language, density and variant bars, and as a two-segment **view switch**: the commit-details panel header carries `commit-details-view-switch` (description | files) on **both** hosts — History and the Commit analyzer — driving the route-scoped `CommitViewModeService`.

### `[stSelectableRow]`
**Role:** the one reusable selectable-row pattern

An attribute directive, host-agnostic: it adds `.st-selectable-row`, the selected fill, the 3px `.st-selection-bar` and the inset focus ring to whatever element it sits on, owns `tabindex`, and emits `rowActivated` on click or Enter/Space. It deliberately styles no geometry, so the same pattern is shared by the nav rail, history rows, the file list and search hits.

### `st-popover`
**Role:** floating layer

Renders a backdrop and a raised panel only while `open`. Closes on Escape, backdrop click, or focus leaving the subtree, each emitting `closed`; anchoring and focus restoration are the consumer's job. Raised background, `--st-radius-4`, minimum width `--st-size-pane-min`.

### `st-live-region`
**Role:** assistive-technology announcer

A visually-hidden `role="status"` region with `politeness` `polite | assertive`. The root-scoped `LiveRegionService` owns the message and `announce()` is the single mutation point, so fetch progress and ambient notices all publish through one region.

### `st-workspace-split`
**Role:** two-pane workspace primitive

A pinned detail pane plus a flexible primary pane — never two equal columns. Elements marked `[detail]` project into the pinned pane (rendered only while `showDetail` is true); the default slot is the primary pane. Panel width defaults to `--st-size-detail-pane`.

An opt-in `resizable` divider sits at the detail pane's right edge. `detailWidth` (`string | null`) carries an explicit CSS length — a pixel value (`420px`) becomes an inline width, `null` falls back to `var(--st-size-detail-pane)` (380px); `resizable` (default `false`) renders the handle; `detailWidthResized` emits a pixel number once per settled drag and per keyboard step. Drag and keyboard are clamped to `[320, max(320, host width − 320)]` — 320px mirrors `--st-size-pane-min` and is the floor for **both** panes. The handle is a `role="separator"` (`aria-orientation="vertical"`, `aria-valuemin/max/now`, `tabindex="0"`, a `$localize` "Resize detail pane" label): ArrowLeft/ArrowRight step ±16px (Shift ±64), Home = 320, End = max. A constructor `effect()` drops a local drag override whenever the external `detailWidth` input changes, so a restore or reset always wins. The divider is `display: none` inside the ≤800px block (the sanctioned `width: 100% !important` collapse still beats any inline width). The component stays dumb — the app host binds the persisted `st:paneWidth` in and persists the emitted width out.

### `st-empty-state`
**Role:** centered empty / placeholder block

Optional `icon`, `title` and `message`; tone `neutral | muted | error`. Renders each part only when its input is non-empty.

### `st-repo-card`
**Role:** repository row in the drawer and repos page

Icon + name (+ optional branch badge) + optional subtitle. Emits `picked` on click or keyboard; selected state uses the accent border and fill.

### `st-graph-row`
**Role:** one presentational commit row

A fixed 28px row (`GRAPH_ROW_HEIGHT`, matching `--st-size-row-graph`) holding an inline-SVG lane segment, the short oid, ref pills, the message subject, the author, a `+N/−N/f` stats gauge and a `tabular-nums` date. Ref pills are keyed on the reference TYPE — `head` (`--st-color-ref-head`, turquoise), local branch (`--st-color-ref-branch`, violet), mainline branch (`--st-color-ref-main`, mint — `main`/`master` via `isMainlineBranch()`), remote (`--st-color-ref-remote`, electric blue) and tag (`--st-color-ref-tag`, amber). Lane colour comes from `--st-color-graph-lane-N`; the SVG lane width is dynamic (`(maxLane + 1) × 14px`). The selected row uses the `--st-color-selected` fill, the `--st-color-selected-border` bottom hairline and the 3px `.st-selection-bar`; hover tints the row with a 10% accent wash.

### `st-diff-viewer`
**Role:** read-only diff surface that optionally carries host-supplied inline per-hunk actions

Mounts a lazily-loaded Monaco `DiffEditor` when a real textual diff is available, and a plain tokenized grid fallback otherwise (a 4-column insert/delete/context grid, shown before the chunk loads, in tests, or if initialization fails). Distinct notices cover truncated, error, loading, binary, conflict and empty diffs. Monaco renders read-only `plaintext` models with the `--st-font-mono` family and is unified by default (`renderSideBySide: false`). Font size and soft wrap are inputs driven by the persisted preferences — `fontSize` (number, `11 | 12 | 13`, default `12`) and `wordWrap` (boolean, default `false`) — with the line height exactly 2× the font size via the exported pure helper `diffLineHeight(fontSize) => fontSize * 2` (11→22, 12→24, 13→26, matching `--st-leading-code`). Both reach Monaco in `createDiffEditor` and follow it live through `editor.updateOptions` only — never a remount — and the non-Monaco 4-column fallback grid carries the same values as a `data-wrap="on|off"` attribute plus inline `font-size`/`line-height` (wrapped = `white-space: pre-wrap` + `word-break: break-all`; unwrapped = `white-space: pre` with a `max-content` last grid track so long lines overflow and scroll horizontally). Two token-derived custom themes — `singularitree-dark` and `singularitree-light` in `libs/ui-kit/src/diff-viewer/monaco-theme.ts`, mirroring the `--st-color-*` diff, gutter and surface values in both themes — are registered by the lazy loader (`defineTheme`) before it hands back the module, and `setTheme` follows the current `data-theme` so the editor never flashes the built-in theme. The layout persists through `DiffModeService` (`st:diffMode`, default `unified`); the file-status diff-pane header toggle (`st-toggle-group`, Unified / Side by side) flips it live.

**Inline-action mode (opt-in, additive).** The primitive is read-only *by default* — it renders a diff and emits nothing about it. A host that needs per-hunk affordances passes `hunkActions` (`HunkActionSlot[]`); when that input is non-null the viewer replaces Monaco with **its own 5-column tokenized grid** (`checkbox | old-num | new-num | sign | text`) — per-hunk action buttons on each hunk's header row and a checkbox on every changed line — and emits `hunkAction` (`{hunkIndex, actionKey}`) and `hunkLineToggle` (`{hunkIndex, lineIndex}`). Monaco does not mount in this mode (an already-mounted editor is disposed), and the grid carries the same `data-wrap` / `fontSize` / 2× line-height contract as the read-only fallback. The component stays dumb: it owns no selection and no store, knows no RPC, and adds no label beyond its own line-checkbox name — the host supplies each `HunkActionSpec` (`key`, `icon`, `label`, `disabled?`) and holds the line selection. `hunkIndex` indexes `diff().hunks` and `lineIndex` indexes `hunk.lines`, both resolved by the pure `hunkGridSegments(diff)` walk in `hunks-to-texts.ts` (the same row layout `diffToGridRows` produces — never a second diff), so the emitted addresses are exactly the `hunk_index` / `line_indices` the core's per-hunk RPCs take. Decision record: [[adr-0035-commit-details-redesign-and-inline-hunk-actions]]. With the input left at its `null` default the rendering is the read-only surface described above, unchanged.

### `st-modal` (app-level, not ui-kit)
**Role:** shared dialog shell

Lives at `apps/angular/src/app/shared/ui/modal/modal.ts` — the application layer, not the ui-kit barrel. It renders on `--st-color-raised` over a `--st-color-overlay` backdrop at `--st-z-modal`, with `--st-radius-4` corners and hairline structure (the elevation shadow was removed), and a 180ms fade+rise open motion. It owns a **focus trap + focus restore**: focus moves into the dialog on open and returns to the previously focused element on every close path, with Tab/Shift+Tab cycling inside.

## Do's and Don'ts

### Do
- Consume only the semantic layer in components; reach for `--st-color-*`, `--st-space-*`, `--st-font-*`, `--st-size-*`, `--st-radius-*`, `--st-motion-*` and `--st-z-*`.
- Define every semantic name in both `:root` and `[data-theme='light']` so neither theme can fall back into the other.
- Separate panels with 1px hairlines (`--st-color-border`) — structure comes from lines and type weight, not boxes.
- Reserve `--st-color-accent` for its interaction role set: interaction, selection, focus, graph connections, the primary action and `HEAD` refs. Branch, remote, tag and mainline roles belong to their own tokens (`--st-color-ref-branch`, `--st-color-ref-remote`, `--st-color-ref-tag`, `--st-color-ref-main`).
- Keep the ~70/20/10 intensity budget: most of the screen is the dark surface ramp, a fifth is neutral structure and text, and bright accents stay rare.
- Reserve `--st-color-danger` (coral) for errors, failures and conflicts only; the lighter `--st-color-remove` carries the `−N`/discard role so coral is never borrowed.
- Use `.st-selectable-row` + `.st-selection-bar` for selection everywhere so "what is selected" reads the same in the rail, the history list, the file list, search hits and drawer cards.
- Keep the graph row at 28px and set numeric columns to `.st-tabular-nums`.
- Use mono only for hashes, paths, refs, diff code and gutters, counts and keycaps.
- Use the inset focus ring (offset −1px) inside rows and nav items; the standard 2px ring elsewhere.

### Don't
- Do not add `var(--st-x, #hex)` (or `rgba()`/any value) fallbacks — a fallback is a theming bug; every token must exist in both blocks. The P4.1 pass removed the last 87 of them from the renderer; keep it that way.
- Do not reference a `--st-prim-*` primitive from a component.
- Do not introduce colours outside the semantic set, or gradients; the primary button's glow is the only permitted glow.
- Do not use box-shadow for elevation. Exactly two shadows exist: the inset selection bar, and the single primary-button glow (`0 2px 10px` turquoise at 22%) on `variant="primary"`.
- Do not use mono for nav labels, buttons, settings labels, commit subjects or table headers.
- Do not use fractional font weights — 400 / 500 / 600 / 700 only.
- Do not animate selection changes, scrolling, or graph rows.
- Do not mix radii: controls are 4px, cards and panels 5px, popovers and the drawer 8px.

## Surfaces

| Level | Name | Token | Dark | Light | Purpose |
|-------|------|-------|------|-------|---------|
| 0 | Canvas | `--st-color-bg` | `#171923` | `#f7f8f7` | the routed region and app background |
| 1 | Chrome | `--st-color-chrome` | `#1b1f2b` | `#eceeed` | top bar and status bar |
| 1 | Rail | `--st-color-rail` | `#191d28` | `#f0f2f1` | nav rail |
| 2 | Surface | `--st-color-surface` | `#1f2433` | `#ffffff` | panels, panes, cards, inputs |
| 2 | Surface 2 | `--st-color-surface-2` | `#262b3b` | `#f4f6f5` | sticky strips, table header, field background |
| 3 | Raised | `--st-color-raised` | `#2a3040` | `#ffffff` | popovers and modals above the surface |
| — | Overlay | `--st-color-overlay` | `rgba(15,18,32,.62)` | `rgba(20,24,26,.35)` | modal and drawer backdrop |

## Layout

The shell is one flex column (`.st-shell`) with the body absorbing slack:

```
[1] top bar          64px    brand | repo tabs ......... remote ops | sync | menu | drawer toggle
[2] banners          auto    checkout-error · merge-conflict   (conditional)
[3] body             flex    nav rail 224 | workspace (pinned detail 380 + flexible primary) | drawer 264
[4] status bar       31px    repo · branch · short-hash | sync/online | live region
```

The nav rail is `--st-size-rail` wide (`224px`, collapses to `40px`), the repo drawer is `--st-size-drawer` (`264px`), and a workspace split pins its detail pane at `--st-size-detail-pane` (`380px`) beside a flexible primary pane. Scrollbars are 8px and use `--st-color-border` for the thumb.

## Agent Prompt Guide

**Quick Color Reference**
- canvas: `--st-color-bg`
- chrome (top/status bar): `--st-color-chrome`
- rail: `--st-color-rail`
- panel / card: `--st-color-surface`
- field / raised strip: `--st-color-surface-2`
- border / hairline: `--st-color-border`
- text: `--st-color-text` · muted: `--st-color-muted`
- accent (interaction, selection, focus, primary action, HEAD): `--st-color-accent`
- info (navigation, links, history, remotes): `--st-color-info`
- focus ring: `--st-color-focus`
- selection fill / bar: `--st-color-selected` / `--st-color-selected-bar`
- refs: branch `--st-color-ref-branch` · main `--st-color-ref-main` · remote `--st-color-ref-remote` · tag `--st-color-ref-tag`
- add: `--st-color-add` · warn: `--st-color-warn` · danger (reserved): `--st-color-danger`

**Example Component Prompts**

1. Create a nav-rail item: a `st-nav-item` with an icon, a 13px label, and an optional neutral count pill. Active state uses `--st-color-accent` text, a `--st-color-accent-soft` fill, a turquoise `--st-color-accent` hairline border and the 3px inset `.st-selection-bar`; the row is `--st-size-row-tree-dense` tall with `--st-radius-2` corners and the active icon inherits turquoise.

2. Create a history row: `st-graph-row` at 28px (`--st-size-row-graph`), with an inline SVG lane coloured by `--st-color-graph-lane-N`, a mono short oid at 60% opacity, ref pills (`head` turquoise / branch violet / main mint / remote electric blue / tag amber), a 12px subject, an auto-margin author at 75% opacity, a mono `+N/−N/f` gauge (`--st-color-add` / `--st-color-remove`) and a `tabular-nums` date at 50% opacity.

3. Create a panel: an `st-panel` on `--st-color-surface` with a 1px `--st-color-border` border and `--st-radius-3`. Its sticky header holds an `.st-eyebrow` group label (11px, 600, uppercase, `.08em`) and a 13px title; the body is `--st-space-3` padded.

4. Create a floating menu: a `st-popover` whose panel uses `--st-color-raised`, a hairline border and `--st-radius-4`; it opens with `--st-motion-base` on `--st-ease` and closes on Escape, backdrop click, or focus-out, returning focus to its trigger.

5. Create a primary action: a `st-button` with `variant="primary"` — `--st-color-accent` fill, `--st-color-accent-contrast` text, the single permitted `0 2px 10px` turquoise glow at 22%, 30px tall, `--st-radius-2` corners, and a 2px `--st-color-focus` ring on focus.

## Quick Start

Every value below is consumed from the semantic layer; a component never hardcodes a colour or a size. Copy the shape and swap the surface.

### CSS Custom Properties — consumption

```css
/* A flat panel separated by a hairline, never a shadow. */
.my-panel {
  background: var(--st-color-surface);
  color: var(--st-color-text);
  border: var(--st-hairline) solid var(--st-color-border);
  border-radius: var(--st-radius-3);
  padding: var(--st-space-3);
}

/* A dense, selectable row with the shared selection treatment. */
.my-row {
  display: flex;
  align-items: center;
  height: var(--st-size-row-tree);
  padding: 0 var(--st-space-2);
  color: var(--st-color-text);
  cursor: pointer;
  transition: background-color var(--st-motion-fast) var(--st-ease);
}
.my-row:hover {
  background: color-mix(in srgb, var(--st-color-text) 6%, transparent);
}
.my-row.is-selected {
  background: var(--st-color-selected);
  /* The hairline is subtle; the 3px inset bar is the primary "what is selected" signal. */
  border-color: var(--st-color-selected-border);
  box-shadow: inset var(--st-size-selection-bar-w) 0 0 var(--st-color-selected-bar);
}
.my-row:focus-visible {
  outline: 2px solid var(--st-color-focus);
  outline-offset: -1px;
}

/* A mono, right-aligned, non-jittering metadata column. */
.my-meta {
  font-family: var(--st-font-mono);
  font-size: var(--st-font-11);
  font-variant-numeric: tabular-nums;
  color: var(--st-color-muted);
}

/* The one primary action — the only glow in the system. */
.my-primary {
  height: var(--st-size-control-md);
  padding: 0 var(--st-space-3);
  border-radius: var(--st-radius-2);
  background: var(--st-color-accent);
  color: var(--st-color-accent-contrast);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--st-color-accent) 22%, transparent);
}
```

### The two-tier token layer

The full source is `libs/ui-kit/src/styles/tokens.scss`. Its shape is fixed — primitives first, then every semantic name defined twice:

```css
:root {
  /* Tier 1 — raw primitives, theme-independent. */
  --st-prim-cyan-400: #37e0d0;

  /* Tier 2 — semantic, dark defaults. */
  --st-color-bg: #171923;
  --st-color-surface: #1f2433;
  --st-color-accent: var(--st-prim-cyan-400);
}

[data-theme='light'] {
  /* Every semantic name is repeated — never a partial set. */
  --st-color-bg: #f7f8f7;
  --st-color-surface: #ffffff;
  --st-color-accent: #0f7f7c;
}
```

## References

- Visual direction and shell IA: [[renderer-redesign-plan]] (§2 visual direction, §3 shell layout)
- Renderer slice ownership: [[renderer-slice]]
- Token source: `libs/ui-kit/src/styles/tokens.scss`
- Shared utility classes: `libs/ui-kit/src/styles/utilities.scss`
- Component barrel: `libs/ui-kit/src/index.ts`
