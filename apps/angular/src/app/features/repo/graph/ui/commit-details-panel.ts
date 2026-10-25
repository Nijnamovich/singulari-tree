import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { Commit, RefLabel, Signature } from '@contracts/domain';
import {
  BadgeComponent,
  ButtonComponent,
  IconComponent,
  InputComponent,
  SelectableRowDirective,
  isMainlineBranch,
  normalizeRefKind,
  shortOidHex,
  ToggleGroupComponent,
  type ToggleOption,
} from '@singularitree/ui-kit';
import { splitCommitMessage } from './commit-message';

/** Delay before the padlock tooltip appears (continuous hover or focus). */
export const TOOLTIP_DELAY_MS = 1000;

/**
 * Maximum tooltip width in px, mirroring `--st-size-pane-min` (320px in
 * `libs/ui-kit/src/styles/tokens.scss`). Used only to clamp the fixed-position
 * bubble inside the viewport; the visual cap stays in the stylesheet.
 */
export const TOOLTIP_MAX_WIDTH = 320;

/**
 * Read-only details panel for the selected commit (plan §4.3, decision #8).
 * Dumb: it only renders the `commit` input (or the WIP placeholder) and emits
 * intents. It holds no services and does not route — the owning page decides
 * what each output means.
 *
 * Two hosts share one surface: the History aside (`repo-page`) and the Commit
 * analyzer embed in File status. The host opts into the pieces it wants through
 * inputs, so the same panel reads as a full overview in History and as a slim
 * header in the analyzer.
 *
 * The panel is three regions: a header (two rows — identity | centred CTA |
 * actions, then the `description | files` switch), a single scrolling content
 * region (the subject, plus either the body or the changed-file list) and a
 * collapsible metadata footer. The host
 * owns the `description | files` mode (`mode` input / `modeChange` output); the
 * panel keeps no mode state, so a pick never mutates what is rendered until the
 * host feeds it back. A commit with no message at all forces `files` (the
 * `description` segment is disabled); a subject-only commit still has a
 * description because the subject is part of it.
 *
 * `showSubject` gates the ENTIRE description sector (subject + body) and
 * `showFiles` the files sector. The History aside and the analyzer's commit
 * variant render the description sector in the panel; only the analyzer's LOCAL
 * variant leaves it off (that page owns the identity). The History aside and the
 * analyzer's commit variant both render the panel's changed-file list; only the
 * local variant leaves it off.
 * `navMode` chooses which contextual action renders in the header — `release`
 * (History's "Close" control) or `history` (the analyzer's "History" shortcut,
 * which also renders in the empty branch). Both carry a delayed tooltip that
 * explains what they do ("collapse panel" / "follow commit").
 * `locked`/`showInGraph` drive the padlock and the analyzer-only reveal action.
 * `filesSelectable` opts a host into making the path rows selectable, so a host
 * whose right pane projects a single file can let the user pick which one.
 */
@Component({
  selector: 'st-commit-details-panel',
  standalone: true,
  imports: [
    BadgeComponent,
    ButtonComponent,
    IconComponent,
    InputComponent,
    SelectableRowDirective,
    ToggleGroupComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isWip()) {
      <section class="st-commit-details" data-testid="commit-details-wip">
        <h2 class="st-commit-details__title">Working tree</h2>
        <p class="st-commit-details__empty">Uncommitted changes (WIP) — stage and commit to add a node.</p>
        @if (showCta()) {
          <st-button
            variant="primary"
            data-testid="commit-details-review"
            (click)="reviewChanges.emit()"
            i18n
            >Review changes</st-button
          >
        }
      </section>
    } @else {
      <!--
        Three regions: a fixed header, the only scrolling content region and a
        fixed footer. The footer is a SIBLING of the content, so the changed-file
        list can never paint over the metadata.
      -->
      <section
        class="st-commit-details"
        [attr.data-testid]="commit() ? 'commit-details' : null"
      >
        <header class="st-commit-details__header" data-testid="commit-details-header">
          <!--
            Row 1: identity | centred CTA | action group. It wraps at the narrow
            pane widths the detail host allows; the identity shrinks and
            truncates while the CTA and the actions never do.
          -->
          <div class="st-commit-details__header-row">
            <div class="st-commit-details__identity">
              @if (commit()) {
                <span
                  class="st-commit-details__short-oid"
                  data-testid="commit-details-short-oid"
                  >{{ shortOid() }}</span
                >
                @if (branchChip(); as branch) {
                  <st-badge variant="branch" data-testid="commit-details-branch">{{ branch }}</st-badge>
                }
              }
            </div>

            <!--
              Center slot: flexes to fill the gap between identity and actions so
              the primary CTA centers in the panel regardless of how wide either
              side grows.
            -->
            <div class="st-commit-details__header-center">
              @if (commit() && showCta()) {
                <st-button
                  variant="primary"
                  data-testid="commit-details-review"
                  (click)="reviewChanges.emit()"
                  i18n
                  >Review changes</st-button
                >
              }
            </div>

            <div class="st-commit-details__actions">
              <!--
                Padlock: press-to-pin the selected commit so the aside survives a
                graph reload. Disabled whenever there is no real commit to pin
                (empty state) or the synthetic WIP row is selected. The wrapper
                owns the hover/focus timer for the explanatory tooltip.
              -->
              <span
                #lockAnchor
                class="st-commit-details__lock"
                (mouseenter)="onLockEnter()"
                (mouseleave)="onLockLeave()"
                (focusin)="onLockFocus()"
                (focusout)="onLockBlur()"
              >
                <st-button
                  variant="icon"
                  size="sm"
                  data-testid="commit-details-lock"
                  [pressed]="locked()"
                  [disabled]="!canLock()"
                  [ariaLabel]="lockLabel()"
                  [ariaDescribedby]="tooltipId"
                  (click)="lockToggle.emit()"
                >
                  <st-icon [name]="locked() ? 'lock' : 'lock-open'" />
                </st-button>
              </span>

              @if (commit() && navMode() === 'release') {
                <st-button
                  variant="ghost"
                  size="sm"
                  data-testid="commit-details-release"
                  [ariaDescribedby]="navTooltipId"
                  (mouseenter)="onNavEnter($event)"
                  (mouseleave)="onNavLeave()"
                  (focusin)="onNavFocus($event)"
                  (focusout)="onNavBlur()"
                  (click)="release.emit()"
                >
                  <st-icon name="close" />
                  <span i18n>Close</span>
                </st-button>
              } @else if (navMode() === 'history') {
                <st-button
                  variant="ghost"
                  size="sm"
                  data-testid="commit-details-history"
                  [ariaDescribedby]="navTooltipId"
                  (mouseenter)="onNavEnter($event)"
                  (mouseleave)="onNavLeave()"
                  (focusin)="onNavFocus($event)"
                  (focusout)="onNavBlur()"
                  (click)="openHistory.emit()"
                >
                  <st-icon name="history" />
                  <span i18n>History</span>
                </st-button>
              }

              @if (commit() && showInGraph()) {
                <st-button
                  variant="icon"
                  size="sm"
                  data-testid="commit-details-show-in-graph"
                  [ariaLabel]="showInGraphLabel"
                  (click)="revealInGraph.emit()"
                >
                  <st-icon name="brand" />
                </st-button>
              }
            </div>
          </div>

          <!--
            Row 2: the exclusive description | files switch stays INSIDE the
            header, aligned to the start. The HOST owns the mode: the panel only
            renders effectiveMode() and emits modeChange, so a pick never
            mutates anything locally.
          -->
          @if (commit() && showViewSwitch()) {
            <div class="st-commit-details__header-switch">
              <st-toggle-group
                data-testid="commit-details-view-switch"
                [ariaLabel]="viewSwitchLabel"
                [options]="modeOptions()"
                [value]="effectiveMode()"
                (valueChange)="onModePick($event)"
              />
            </div>
          }
        </header>

        <!--
          Content: the ONLY scrolling region. The subject h1 is the commit's
          identity and stays rendered in both modes; the body or the changed
          files are swapped beside it (exactly one is in the DOM at a time).
        -->
        <div class="st-commit-details__content" data-testid="commit-details-content">
          @if (commit(); as selected) {
            @if (showSubject()) {
              <div class="st-commit-details__description-block">
                @if (subject()) {
                  <h1
                    class="st-commit-details__subject"
                    [class.st-commit-details__subject--collapsed]="effectiveMode() === 'files'"
                    data-testid="commit-details-subject"
                  >
                    {{ subject() }}
                  </h1>
                }

                @if (effectiveMode() === 'description' && description()) {
                  <p class="st-commit-details__description" data-testid="commit-details-description">
                    {{ description() }}
                  </p>
                }
              </div>
            }

            @if (showFiles() && effectiveMode() === 'files') {
              <!--
                Changed files: a bordered block that owns the whole sector in
                files mode. Paths only — no hunks, no diff, no stats. The body
                keeps its own filter, both empty states and the list; the header
                keeps only the heading (the exclusive switch lives in the header
                above).
              -->
              <section class="st-commit-details__files">
                <header class="st-commit-details__files-header">
                  <p
                    class="st-commit-details__files-heading"
                    data-testid="commit-details-files-heading"
                    [attr.id]="filesHeadingId"
                  >
                    {{ filesHeading() }}
                  </p>
                </header>

                <div
                  class="st-commit-details__files-body"
                  role="region"
                  [attr.aria-labelledby]="filesHeadingId"
                >
                  <st-input
                    type="search"
                    testId="commit-details-files-filter"
                    [value]="fileFilter()"
                    [placeholder]="filterPlaceholder"
                    [ariaLabel]="filterLabel"
                    (valueChange)="fileFilter.set($event)"
                  />

                  @if (!changedFiles().length) {
                    <p
                      class="st-commit-details__files-empty"
                      data-testid="commit-details-files-empty"
                      i18n
                    >
                      No changed files.
                    </p>
                  } @else if (!filteredFiles().length) {
                    <!--
                      Distinct from the no-files line: files exist, the filter
                      simply matches none of them.
                    -->
                    <p
                      class="st-commit-details__files-empty"
                      data-testid="commit-details-files-filter-empty"
                      i18n
                    >
                      No files match the filter.
                    </p>
                  } @else {
                    <ul class="st-commit-details__files-list">
                      @for (path of filteredFiles(); track path) {
                        @if (filesSelectable()) {
                          <!--
                            Host opted into picking: the row carries the shared
                            selectable-row directive so the host can project that
                            single file's diff. Still paths only — no hunks, no
                            stats.
                          -->
                          <li
                            stSelectableRow
                            class="st-commit-details__file-path st-commit-details__file-path--selectable st-mono"
                            data-testid="commit-details-file-path"
                            [attr.data-path]="path"
                            [attr.data-selected]="path === selectedPath()"
                            [selected]="path === selectedPath()"
                            (rowActivated)="fileSelect.emit(path)"
                          >
                            {{ path }}
                          </li>
                        } @else {
                          <li
                            class="st-commit-details__file-path st-mono"
                            data-testid="commit-details-file-path"
                          >
                            {{ path }}
                          </li>
                        }
                      }
                    </ul>
                  }
                </div>
              </section>
            }
          } @else {
            <p class="st-commit-details__empty" data-testid="commit-details-empty">
              Select a commit to see its details.
            </p>
          }
        </div>

        <!--
          Metadata footer: collapsed by default. Author/Date/Commit/Parents/Refs
          + committer live behind the disclosure so they never compete with the
          message; while collapsed the markup is not in the DOM at all.
        -->
        @if (commit(); as selected) {
          <footer class="st-commit-details__footer" data-testid="commit-details-footer">
            <button
              type="button"
              class="st-commit-details__footer-toggle"
              data-testid="commit-details-footer-toggle"
              [attr.aria-expanded]="footerExpanded()"
              (click)="toggleFooter()"
            >
              <st-icon [name]="footerExpanded() ? 'chevron-down' : 'chevron-right'" [size]="14" />
              <span i18n>Metadata</span>
            </button>

            @if (footerExpanded()) {
              <div class="st-commit-details__meta-block" data-testid="commit-details-meta">
                @if (refs().length) {
                  <div class="st-commit-details__refs" data-testid="commit-details-refs">
                    @for (ref of refs(); track ref.kind + ':' + ref.name) {
                      <span class="st-commit-details__ref" [class]="refClass(ref)">{{ ref.name }}</span>
                    }
                  </div>
                }

                <dl class="st-commit-details__meta">
                  <dt>Author</dt>
                  <dd class="st-commit-details__author">
                    <span
                      class="st-commit-details__avatar"
                      data-testid="commit-details-avatar"
                      aria-hidden="true"
                      >{{ authorInitials() }}</span
                    >
                    <span data-testid="commit-details-author">{{ authorLabel() }}</span>
                  </dd>
                  <dt>Date</dt>
                  <dd data-testid="commit-details-date">{{ selected.committedAt }}</dd>
                  <dt i18n>Commit</dt>
                  <dd class="st-commit-details__oid" data-testid="commit-details-oid">
                    {{ selected.oid?.hex ?? 'unknown' }}
                  </dd>
                  <dt>Parents</dt>
                  <dd data-testid="commit-details-parents">
                    @if (parents().length) {
                      @for (parent of parents(); track parent.hex) {
                        <span class="st-commit-details__oid">{{ parent.hex }}</span>
                      }
                    } @else {
                      <span>(root commit)</span>
                    }
                  </dd>
                  <dt>Refs</dt>
                  <dd data-testid="commit-details-ref-summary">{{ refSummary() }}</dd>
                </dl>

                <p class="st-commit-details__committer" data-testid="commit-details-committer">
                  {{ signature(selected.committer) }}
                </p>
              </div>
            }
          </footer>
        }

        <!--
          Tooltip lives outside the scroll region and uses position: fixed, so
          no ancestor overflow can clip it. It is ALWAYS in the DOM: the
          padlock's aria-describedby must resolve before the delayed bubble
          appears, so a screen reader gets the explanation immediately. The
          hidden modifier only fades it out of sight (never out of the
          accessibility tree).
        -->
        <div
          class="st-commit-details__tooltip"
          [class.st-commit-details__tooltip--hidden]="!tooltipVisible()"
          role="tooltip"
          [id]="tooltipId"
          data-testid="commit-details-lock-tooltip"
          [style.left.px]="tooltipLeft()"
          [style.top.px]="tooltipTop()"
        >
          {{ lockTooltip }}
        </div>

        <!--
          Contextual nav tooltip: same contract as the padlock one — always in
          the DOM so aria-describedby resolves from the first render, hidden
          visually (never from the a11y tree) until the delayed reveal. The
          guard mirrors EXACTLY when a nav control renders (the release control
          needs a commit, the History control renders even in the empty branch),
          so the bubble never exists without the control that describes it.
        -->
        @if ((commit() && navMode() === 'release') || navMode() === 'history') {
          <div
            class="st-commit-details__tooltip"
            [class.st-commit-details__tooltip--hidden]="!navTooltipVisible()"
            role="tooltip"
            [id]="navTooltipId"
            data-testid="commit-details-nav-tooltip"
            [style.left.px]="navTooltipLeft()"
            [style.top.px]="navTooltipTop()"
          >
            {{ navTooltipLabel() }}
          </div>
        }
      </section>
    }
  `,
  styles: `
    /* The host is a fixed-height flex column: it never scrolls, the content
       region does. */
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      max-height: 100%;
      overflow: hidden;
      padding: var(--st-space-3);
      color: var(--st-color-text);
      font-size: var(--st-font-12);
    }

    .st-commit-details {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--st-space-3);
      min-height: 0;
    }

    /* Header: two rows — identity | centred CTA | actions, then the switch. */
    .st-commit-details__header {
      flex: none;
      display: flex;
      flex-direction: column;
      gap: var(--st-space-2);
    }

    /* Row 1 wraps at the narrow pane widths the detail host allows. */
    .st-commit-details__header-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--st-space-2);
    }

    /* Shrinks and truncates instead of squeezing the CTA/actions out. */
    .st-commit-details__identity {
      display: flex;
      flex: 0 1 auto;
      align-items: center;
      gap: var(--st-space-2);
      min-width: 0;
      overflow: hidden;
    }

    .st-commit-details__identity st-badge {
      flex: none;
    }

    .st-commit-details__header-center {
      flex: 1 1 auto;
      display: flex;
      justify-content: center;
    }

    /* The CTA label never wraps; the center slot gives it the remaining width. */
    .st-commit-details__header-center st-button {
      flex: none;
    }

    /* Row 2: fixed height and aligned to the header's start edge. */
    .st-commit-details__header-switch {
      flex: none;
      align-self: flex-start;
    }

    /* The only scrolling region: a long description or a long file list
       scrolls here and never pushes the footer out of the panel. */
    .st-commit-details__content {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: var(--st-space-3);
    }

    .st-commit-details__actions {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
    }

    .st-commit-details__lock {
      display: inline-flex;
      flex: none;
    }

    .st-commit-details__short-oid {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-family: var(--st-font-mono);
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
    }

    .st-commit-details__title {
      margin: 0;
      font-size: var(--st-font-13);
      font-weight: 600;
    }

    .st-commit-details__description-block {
      flex: none;
      display: flex;
      flex-direction: column;
      gap: var(--st-space-2);
    }

    .st-commit-details__subject {
      min-width: 0;
      margin: 0;
      font-size: var(--st-font-22);
      font-weight: 600;
      line-height: var(--st-leading-tight);
      word-break: break-word;
    }

    /* Collapsed: the subject clamps to a single line in files mode so the list
       keeps the vertical budget. */
    .st-commit-details__subject--collapsed {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .st-commit-details__description {
      margin: 0;
      font-size: var(--st-font-13);
      line-height: var(--st-leading-ui);
      color: var(--st-color-muted);
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Changed files: an outer bordered block carrying the header row + a
       bordered body. The content region owns the scroll, so the block grows
       naturally and never overlays the footer. */
    .st-commit-details__files {
      flex: none;
      display: flex;
      flex-direction: column;
      gap: var(--st-space-2);
      padding: var(--st-space-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-3);
      background: var(--st-color-surface);
    }

    .st-commit-details__files-header {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
    }

    .st-commit-details__files-heading {
      margin: 0;
      font-size: var(--st-font-11);
      font-weight: 600;
      color: var(--st-color-muted);
    }

    /* Inset body: its own surface + border so it reads as a distinct region.
       No height cap: the content region is the only scroller. */
    .st-commit-details__files-body {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-2);
      padding: var(--st-space-2) var(--st-space-3);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: var(--st-color-surface-2);
    }

    .st-commit-details__files-list {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    /* Paths only: mono, no hunks and no diff. */
    .st-commit-details__file-path {
      font-size: var(--st-font-12);
      color: var(--st-color-text);
      word-break: break-all;
    }

    /* Host-opted-in picking: the shared selectable-row directive owns the
       hover/selected treatment; this only adds the inline-row geometry. */
    .st-commit-details__file-path--selectable {
      padding: var(--st-space-1);
      border-radius: var(--st-radius-1);
    }

    .st-commit-details__files-empty {
      margin: 0;
      font-size: var(--st-font-11);
      color: var(--st-color-muted);
    }

    /* Footer: fixed sibling of the content region. */
    .st-commit-details__footer {
      flex: none;
      display: flex;
      flex-direction: column;
      gap: var(--st-space-2);
    }

    .st-commit-details__footer-toggle {
      display: inline-flex;
      align-items: center;
      gap: var(--st-space-1);
      align-self: flex-start;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--st-color-muted);
      font-family: var(--st-font-ui);
      font-size: var(--st-font-11);
      font-weight: 600;
      cursor: pointer;
    }

    .st-commit-details__footer-toggle:hover {
      color: var(--st-color-text);
    }

    .st-commit-details__footer-toggle:focus-visible {
      outline: 2px solid var(--st-color-focus);
      outline-offset: 2px;
    }

    /* Metadata: hairline-separated and dimmed so it never competes with the
       message above. */
    .st-commit-details__meta-block {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-2);
      padding-top: var(--st-space-3);
      border-top: var(--st-hairline) solid var(--st-color-border);
      opacity: 0.75;
      color: var(--st-color-muted);
    }

    .st-commit-details__refs {
      display: flex;
      flex-wrap: wrap;
      gap: var(--st-space-1);
    }

    .st-commit-details__ref {
      padding: var(--st-hairline) var(--st-space-2);
      border-radius: var(--st-radius-pill);
      border: var(--st-hairline) solid currentColor;
      font-size: var(--st-font-10);
    }

    .st-commit-details__ref--head {
      color: var(--st-color-ref-head);
    }

    .st-commit-details__ref--main {
      color: var(--st-color-ref-main);
    }

    .st-commit-details__ref--branch {
      color: var(--st-color-ref-branch);
    }

    .st-commit-details__ref--remote {
      color: var(--st-color-ref-remote);
    }

    .st-commit-details__ref--tag {
      color: var(--st-color-ref-tag);
    }

    .st-commit-details__ref--other {
      color: var(--st-color-muted);
    }

    .st-commit-details__meta {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: var(--st-space-1) var(--st-space-3);
      margin: 0;
    }

    .st-commit-details__meta dt {
      color: var(--st-color-muted);
    }

    .st-commit-details__meta dd {
      margin: 0;
      word-break: break-all;
    }

    .st-commit-details__author {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
    }

    .st-commit-details__avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--st-color-avatar-bg);
      color: var(--st-color-avatar-fg);
      font-size: var(--st-font-10);
      font-weight: 600;
    }

    .st-commit-details__oid {
      display: block;
      font-family: var(--st-font-mono);
      color: var(--st-color-muted);
    }

    .st-commit-details__committer {
      margin: 0;
      font-size: var(--st-font-11);
      color: var(--st-color-muted);
      word-break: break-all;
    }

    /* Fixed so the pane's overflow: auto can never clip the padlock tooltip.
       Long copy wraps at the pane-minimum width; the floating layer uses the
       same radius role as the st-popover component. */
    .st-commit-details__tooltip {
      position: fixed;
      z-index: var(--st-z-popover);
      max-width: var(--st-size-pane-min);
      padding: var(--st-space-2) var(--st-space-3);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-4);
      background: var(--st-color-raised);
      color: var(--st-color-text);
      font-size: var(--st-font-11);
      line-height: var(--st-leading-ui);
      white-space: normal;
      overflow-wrap: anywhere;
    }

    /* Hidden only visually: opacity keeps the description in the a11y tree. */
    .st-commit-details__tooltip--hidden {
      opacity: 0;
      pointer-events: none;
    }

    .st-commit-details__empty {
      margin: 0;
      color: var(--st-color-muted);
    }
  `,
})
export class CommitDetailsPanel {
  private readonly destroyRef = inject(DestroyRef);

  readonly commit = input<Commit | null>(null);
  readonly isWip = input(false);
  /**
   * Opt-in primary CTA. Only the Repository/History host (`repo-page`) wires the
   * intent; screens that merely reuse this read-only panel (e.g. File status)
   * leave it at the default so no inert button leaks in.
   */
  readonly showCta = input(false);
  /**
   * Whether the ENTIRE description sector renders inside the panel: the subject
   * `h1` AND the body (in `description` mode). The History aside (`repo-page`)
   * and the File-status commit (analyzer) variant both pass `true`; only the
   * File-status LOCAL variant passes `false` because that page owns the screen
   * identity in its left column.
   */
  readonly showSubject = input(true);
  /**
   * Gates the inline changed-files sector. The History aside and the analyzer's
   * commit variant opt in (the analyzer's Files tab IS this block); only the
   * analyzer's LOCAL variant leaves it off.
   */
  readonly showFiles = input(false);
  /**
   * HOST-OWNED shared view mode. The panel keeps no mode state of its own: it
   * renders exactly this value (forced to `files` when the commit has no
   * message) and emits `modeChange` when the user picks a segment.
   */
  readonly mode = input<'description' | 'files'>('description');
  /**
   * Whether the header renders the `description | files` switch. It renders
   * only where the host opts in: BOTH the History aside (`repo-page`) and the
   * analyzer's commit variant opt in; the analyzer's local variant and the
   * empty/WIP states never render it.
   */
  readonly showViewSwitch = input(false);
  /**
   * Which contextual action the header's action group renders: `release` (the
   * History "Close" control), `history` (the analyzer shortcut back to the graph,
   * also shown in the empty branch) or `none`.
   */
  readonly navMode = input<'none' | 'release' | 'history'>('none');
  /** Pressed state of the padlock (the graph lock pins the selected commit). */
  readonly locked = input(false);
  /** Analyzer-only action: reveal the commit in the graph. */
  readonly showInGraph = input(false);
  /**
   * Changed-file paths of the selected commit. Rendered read-only in the
   * changed-files block — paths only, never a diff. Default empty so a host
   * that does not wire it simply shows the empty-state line.
   */
  readonly changedFiles = input<readonly string[]>([]);
  /**
   * Host opt-in: when true each row becomes a selectable row emitting
   * `fileSelect`, so a host whose right pane projects ONE file can let the user
   * pick it. Default false keeps History's plain, inert path rows.
   */
  readonly filesSelectable = input(false);
  /** Path the host's right pane is currently showing (selectable mode only). */
  readonly selectedPath = input<string | null>(null);

  /** Single primary intent: the owning page routes it to `/repo/file-status`. */
  readonly reviewChanges = output<void>();
  /** Toggle the graph lock (pin/release the selected commit). */
  readonly lockToggle = output<void>();
  /** Release the pinned selection (History host). */
  readonly release = output<void>();
  /** Return to the graph from the analyzer embed. */
  readonly openHistory = output<void>();
  /** The user picked a changed-file path (only when `filesSelectable`). */
  readonly fileSelect = output<string>();
  /** Reveal the commit in the graph (analyzer). */
  readonly revealInGraph = output<void>();
  /** The user picked a segment: the host owns the mode and feeds it back. */
  readonly modeChange = output<'description' | 'files'>();

  /**
   * The mode actually rendered. A commit with no message at all (empty subject
   * AND body) can never land in `description` (the segment is disabled and the
   * mode is forced to `files`). A subject-only commit still has a description —
   * the subject is part of it — so `description` stays selectable.
   */
  readonly effectiveMode = computed<'description' | 'files'>(() =>
    this.hasMessage() ? this.mode() : 'files',
  );

  /**
   * Segments of the exclusive view switch. The `description` segment is
   * disabled when the commit has no message; the `files` segment carries the
   * changed-file count.
   */
  readonly modeOptions = computed<readonly ToggleOption[]>(() => [
    {
      value: 'description',
      label: this.descriptionSegmentLabel,
      disabled: !this.hasMessage(),
    },
    { value: 'files', label: this.filesSegmentLabel, count: this.changedFiles().length },
  ]);

  private readonly descriptionSegmentLabel = $localize`Description`;
  private readonly filesSegmentLabel = $localize`Files`;

  /** Shared accessible name of the exclusive view switch. */
  readonly viewSwitchLabel = $localize`Description or changed files`;

  /** Live filter text for the changed-file list (owned here; the panel is dumb). */
  readonly fileFilter = signal('');

  /** Stable id linking the changed-files heading to the region it labels. */
  readonly filesHeadingId = 'st-commit-details-files-heading';

  /** Filter field placeholder + accessible name. */
  readonly filterPlaceholder = $localize`Filter changed files`;
  readonly filterLabel = $localize`Filter changed files`;

  /** Accessible name of the analyzer-only "show in graph" action. */
  readonly showInGraphLabel = $localize`Show in graph`;

  /**
   * The padlock can only pin a real commit: the empty state has nothing to pin
   * and the synthetic WIP row is not a commit.
   */
  readonly canLock = computed(() => this.commit() !== null && !this.isWip());

  /** Pressed-state label of the padlock. */
  readonly lockLabel = computed(() =>
    this.locked() ? $localize`Unlock commit` : $localize`Lock commit`,
  );

  /** Plain localized explanation of what the padlock does (no interpolation). */
  readonly lockTooltip = $localize`Locking pins this commit: the details panel keeps showing it after the graph reloads, and while the lock is on, selecting a different commit is refused.`;

  /** Stable tooltip id referenced by the padlock's `aria-describedby`. */
  readonly tooltipId = 'st-commit-details-lock-tooltip';

  /** Stable id shared by the contextual nav control's tooltip. */
  readonly navTooltipId = 'st-commit-details-nav-tooltip';

  /**
   * Copy of the contextual nav tooltip: the release control collapses the panel,
   * the analyzer's History control follows the commit back into the graph.
   */
  readonly navTooltipLabel = computed(() => {
    if (this.navMode() === 'release') return $localize`collapse panel`;
    if (this.navMode() === 'history') return $localize`follow commit`;
    return '';
  });

  // -- padlock tooltip (delayed, continuous hover/focus) --------------------
  private readonly lockAnchor = viewChild<ElementRef<HTMLElement>>('lockAnchor');
  private tooltipTimer: ReturnType<typeof setTimeout> | null = null;
  readonly tooltipVisible = signal(false);
  readonly tooltipLeft = signal(0);
  readonly tooltipTop = signal(0);

  // -- contextual nav tooltip (same delayed contract) -----------------------
  private navTooltipTimer: ReturnType<typeof setTimeout> | null = null;
  readonly navTooltipVisible = signal(false);
  readonly navTooltipLeft = signal(0);
  readonly navTooltipTop = signal(0);

  /** Footer starts collapsed: the metadata markup is not in the DOM. */
  readonly footerExpanded = signal(false);

  constructor() {
    // A different commit invalidates whatever the tooltip described.
    effect(() => {
      this.commit();
      this.hideLockTooltip();
      this.hideNavTooltip();
    });
    // A different nav action describes a different tooltip: never carry the
    // previous copy/bubble over.
    effect(() => {
      this.navMode();
      this.hideNavTooltip();
    });
    this.destroyRef.onDestroy(() => {
      this.clearTooltipTimer();
      this.clearNavTooltipTimer();
    });
  }

  readonly refs = computed(() => this.commit()?.refs ?? []);
  readonly parents = computed(() => this.commit()?.parents ?? []);

  /** First 7 hex characters of the commit oid (git's default abbreviation). */
  readonly shortOid = computed(() => shortOidHex(this.commit()?.oid?.hex));

  /** Subject/body split on the first blank line (plan §4.3). */
  private readonly messageParts = computed(() => splitCommitMessage(this.commit()?.message ?? ''));
  readonly subject = computed(() => this.messageParts().subject);
  readonly description = computed(() => this.messageParts().description);

  /** Whether the commit carries ANY message (a subject or a trimmed body). */
  readonly hasMessage = computed(
    () => this.subject().length > 0 || this.description().length > 0,
  );

  /**
   * Normalized filter query: trimmed and lowercased once so both the "active"
   * check and the match test agree.
   */
  private readonly normalizedFilter = computed(() => this.fileFilter().trim().toLowerCase());

  readonly filterActive = computed(() => this.normalizedFilter().length > 0);

  /**
   * The visible file paths. Case-insensitive **substring** match via
   * `String#includes` — never a RegExp, so filter metacharacters (`*`, `[`, `]`,
   * `.`) stay literal and a path is never matched by an unintended pattern.
   */
  readonly filteredFiles = computed(() => {
    const query = this.normalizedFilter();
    if (!query) return this.changedFiles();
    return this.changedFiles().filter((path) => path.toLowerCase().includes(query));
  });

  /**
   * `N changed files` heading (singular/plural aware). While a filter is active
   * it reads `N of M changed files` so the user sees both the match count and
   * the total.
   */
  readonly filesHeading = computed(() => {
    const total = this.changedFiles().length;
    if (this.filterActive()) {
      return $localize`${this.filteredFiles().length} of ${total} changed files`;
    }
    return total === 1 ? $localize`1 changed file` : $localize`${total} changed files`;
  });

  /** Announce a segment pick; the host owns the mode. */
  onModePick(value: string): void {
    if (value !== 'description' && value !== 'files') return;
    this.modeChange.emit(value);
  }

  toggleFooter(): void {
    this.footerExpanded.update((expanded) => !expanded);
  }

  // -- padlock tooltip ------------------------------------------------------

  onLockEnter(): void {
    this.scheduleTooltip();
  }

  onLockFocus(): void {
    this.scheduleTooltip();
  }

  onLockLeave(): void {
    this.hideLockTooltip();
  }

  onLockBlur(): void {
    this.hideLockTooltip();
  }

  private scheduleTooltip(): void {
    this.clearTooltipTimer();
    this.tooltipTimer = setTimeout(() => {
      this.tooltipTimer = null;
      this.positionTooltip();
      this.tooltipVisible.set(true);
    }, TOOLTIP_DELAY_MS);
  }

  private hideLockTooltip(): void {
    this.clearTooltipTimer();
    this.tooltipVisible.set(false);
  }

  private clearTooltipTimer(): void {
    if (this.tooltipTimer !== null) {
      clearTimeout(this.tooltipTimer);
      this.tooltipTimer = null;
    }
  }

  /** Anchor the tooltip below the padlock, clamped inside the viewport. */
  private positionTooltip(): void {
    const rect = this.lockAnchor()?.nativeElement.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const maxWidth = TOOLTIP_MAX_WIDTH;
    const viewportWidth = typeof window === 'undefined' ? rect.left + maxWidth : window.innerWidth;
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - maxWidth - margin));
    this.tooltipLeft.set(left);
    this.tooltipTop.set(rect.bottom + 6);
  }

  // -- contextual nav tooltip -----------------------------------------------

  onNavEnter(event: Event): void {
    this.scheduleNavTooltip(event.currentTarget as HTMLElement | null);
  }

  onNavFocus(event: Event): void {
    this.scheduleNavTooltip(event.currentTarget as HTMLElement | null);
  }

  onNavLeave(): void {
    this.hideNavTooltip();
  }

  onNavBlur(): void {
    this.hideNavTooltip();
  }

  /**
   * Schedule the bubble. The anchor element is captured NOW, at dispatch time:
   * `event.currentTarget` is only valid WHILE the event is being dispatched, so
   * reading it a second later (inside the timer) would always yield `null` and
   * the bubble would land in the viewport's corner instead of under the
   * control.
   */
  private scheduleNavTooltip(anchor: HTMLElement | null): void {
    this.clearNavTooltipTimer();
    this.navTooltipTimer = setTimeout(() => {
      this.navTooltipTimer = null;
      this.positionNavTooltip(anchor);
      this.navTooltipVisible.set(true);
    }, TOOLTIP_DELAY_MS);
  }

  private hideNavTooltip(): void {
    this.clearNavTooltipTimer();
    this.navTooltipVisible.set(false);
  }

  private clearNavTooltipTimer(): void {
    if (this.navTooltipTimer !== null) {
      clearTimeout(this.navTooltipTimer);
      this.navTooltipTimer = null;
    }
  }

  /**
   * Anchor the nav tooltip below the control that triggered it. The anchor is
   * the `st-button` host captured at dispatch time, so no extra template ref is
   * needed.
   */
  private positionNavTooltip(anchor: HTMLElement | null): void {
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect) return;
    const margin = 8;
    const maxWidth = TOOLTIP_MAX_WIDTH;
    const viewportWidth = typeof window === 'undefined' ? rect.left + maxWidth : window.innerWidth;
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - maxWidth - margin));
    this.navTooltipLeft.set(left);
    this.navTooltipTop.set(rect.bottom + 6);
  }

  /** Head ref when present, otherwise the first ref (plan §4.3 branch chip). */
  readonly branchChip = computed<string | null>(() => {
    const refs = this.refs();
    if (!refs.length) return null;
    const head = refs.find((ref) => ref.kind === 'head');
    return (head ?? refs[0]).name;
  });

  /** `Name <email>` for the author line, or an em dash when absent. */
  readonly authorLabel = computed(() => {
    const author = this.commit()?.author;
    return author ? `${author.name} <${author.email}>` : '—';
  });

  /**
   * Up-to-two-letter initials for the avatar: the first letters of the first
   * two whitespace-separated words, uppercased. `?` when there is no author.
   */
  readonly authorInitials = computed(() => {
    const name = this.commit()?.author?.name?.trim();
    if (!name) return '?';
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('');
    return initials || '?';
  });

  signature(sig: Signature | undefined): string {
    return sig ? `${sig.name} <${sig.email}> · ${sig.when}` : '—';
  }

  refSummary(): string {
    const refs = this.refs();
    if (!refs.length) return '—';
    return refs.map((ref) => `${ref.name} (${ref.kind})`).join(', ');
  }

  /**
   * Classes for one ref pill. A mainline local branch (`main`/`master`) reads
   * mint (`--main`); every other ref keeps its per-kind colour
   * (`--head`/`--branch`/`--remote`/`--tag`/`--other`), matching `st-graph-row`.
   */
  refClass(ref: RefLabel): string {
    const kind = normalizeRefKind(ref.kind);
    if (kind === 'branch' && isMainlineBranch(ref.name)) {
      return 'st-commit-details__ref st-commit-details__ref--main';
    }
    return `st-commit-details__ref st-commit-details__ref--${kind}`;
  }
}
