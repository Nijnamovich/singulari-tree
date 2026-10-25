import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { Commit, CommitStats, Lane, RefLabel } from '@singularitree/contracts/domain';
import { laneColor } from './lane-palette';
import {
  authorName,
  firstLine,
  formatShortDate,
  isMainlineBranch,
  normalizeRefKind,
  shortOidHex,
} from './graph-row.utils';

/** Fixed row height in px — MUST match the CDK virtual-scroll `itemSize`. */
export const GRAPH_ROW_HEIGHT = 28;
/** Width in px of a single lane column inside the SVG graph segment. */
export const LANE_COLUMN_WIDTH = 14;

/**
 * Dumb, presentational commit row: one SVG lane segment + short oid, ref labels,
 * message subject, author and date. Holds no services — the parent owns data.
 *
 * Ref pill colours are keyed on the reference TYPE — head / local branch /
 * mainline branch / remote / tag — never per commit, so `main` and `master`
 * take the mint `--st-color-ref-main` role while every other branch uses
 * `--st-color-ref-branch`.
 */
@Component({
  selector: 'st-graph-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'st-graph-row',
    role: 'button',
    tabindex: '0',
    '[style.height.px]': 'rowHeight',
    '[class.st-graph-row--selected]': 'selected()',
    '[class.st-selection-bar]': 'selected()',
    '[class.st-graph-row--lens-active]': 'lensActive()',
    '[class.st-graph-row--lens-outside]': 'lensState() === "out"',
    '[class.st-graph-row--lens-inside]': 'lensState() === "in"',
    '[attr.data-lens]': 'lensState()',
    '(click)': 'picked.emit()',
    '(keydown.enter)': 'picked.emit()',
  },
  template: `
    <svg
      class="st-graph-row__graph"
      [attr.width]="graphWidth()"
      [attr.height]="rowHeight"
      [attr.viewBox]="'0 0 ' + graphWidth() + ' ' + rowHeight"
      aria-hidden="true"
      focusable="false"
    >
      @if (lane().continues) {
        <line
          class="st-graph-row__lane-line"
          [attr.x1]="laneX()"
          [attr.y1]="0"
          [attr.x2]="laneX()"
          [attr.y2]="rowHeight"
          [attr.stroke]="color()"
          stroke-width="2"
        />
      }
      <circle
        class="st-graph-row__node"
        [attr.cx]="laneX()"
        [attr.cy]="rowHeight / 2"
        r="4"
        [attr.fill]="color()"
      />
    </svg>

    <div class="st-graph-row__content">
      <span class="st-graph-row__oid" data-testid="graph-row-oid">{{ shortOid() }}</span>
      @for (ref of refs(); track ref.kind + ':' + ref.name) {
        <span class="st-graph-row__ref" [class]="refClass(ref)" data-testid="graph-row-ref">{{
          ref.name
        }}</span>
      }
      <span class="st-graph-row__message" [title]="message()" data-testid="graph-row-message">{{
        message()
      }}</span>
      <span class="st-graph-row__author st-hide-at-1100" data-testid="graph-row-author">{{ author() }}</span>
      @if (stats(); as gauge) {
        <span class="st-graph-row__stats" data-testid="graph-row-stats" [title]="statsTitle()">
          <span class="st-graph-row__additions" data-testid="graph-row-additions"
            >+{{ gauge.additions }}</span
          >
          <span class="st-graph-row__deletions" data-testid="graph-row-deletions"
            >−{{ gauge.deletions }}</span
          >
          <span class="st-graph-row__files" data-testid="graph-row-files"
            >{{ gauge.filesChanged }}f</span
          >
        </span>
      }
      <span class="st-graph-row__date st-hide-at-1600" data-testid="graph-row-date">{{ date() }}</span>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      height: var(--st-size-row-graph);
      padding: 0 8px;
      overflow: hidden;
      cursor: pointer;
      font-size: var(--st-font-12);
      line-height: 1;
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      color: var(--st-color-text);
      contain: layout style;
    }

    :host(:hover) {
      background: color-mix(in srgb, var(--st-color-accent) 10%, transparent);
    }

    :host:focus-visible {
      outline: 1px solid var(--st-color-focus);
      outline-offset: -1px;
    }

    /*
     * Branch lens (ADR-0042): rows outside the lensed ref are dimmed; rows
     * inside get a ref-coloured wash + a 1px inset marker. Both are gated on
     * :not(.st-graph-row--selected) so the selected fill/bar always wins.
     */
    :host(.st-graph-row--lens-outside:not(.st-graph-row--selected)) {
      opacity: 0.55;
    }

    :host(.st-graph-row--lens-inside:not(.st-graph-row--selected)) {
      background: color-mix(in srgb, var(--st-color-ref-branch) 10%, transparent);
      box-shadow: inset 1px 0 0 var(--st-color-ref-branch);
    }

    :host(.st-graph-row--selected) {
      background: var(--st-color-selected);
      border-bottom-color: var(--st-color-selected-border);
    }

    .st-graph-row__graph {
      flex: none;
      display: block;
    }

    .st-graph-row__content {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
    }

    .st-graph-row__oid {
      flex: none;
      font-family: var(--st-font-mono);
      opacity: 0.6;
    }

    .st-graph-row__ref {
      flex: none;
      padding: 1px 5px;
      border-radius: var(--st-radius-pill);
      border: 1px solid currentColor;
      font-size: 10px;
      line-height: 14px;
      white-space: nowrap;
    }

    .st-graph-row__ref--head {
      color: var(--st-color-ref-head);
    }

    .st-graph-row__ref--branch {
      color: var(--st-color-ref-branch);
    }

    .st-graph-row__ref--main {
      color: var(--st-color-ref-main);
    }

    .st-graph-row__ref--remote {
      color: var(--st-color-ref-remote);
    }

    .st-graph-row__ref--tag {
      color: var(--st-color-ref-tag);
    }

    .st-graph-row__ref--other {
      color: var(--st-color-text);
      opacity: 0.7;
    }

    .st-graph-row__message {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .st-graph-row__author {
      flex: none;
      margin-left: auto;
      opacity: 0.75;
      white-space: nowrap;
    }

    .st-graph-row__stats {
      flex: none;
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      font-family: var(--st-font-mono);
      font-size: var(--st-font-11);
      white-space: nowrap;
    }

    .st-graph-row__additions {
      color: var(--st-color-add);
    }

    .st-graph-row__deletions {
      color: var(--st-color-remove);
    }

    .st-graph-row__files {
      opacity: 0.5;
    }

    .st-graph-row__date {
      flex: none;
      font-variant-numeric: tabular-nums;
      opacity: 0.5;
      white-space: nowrap;
    }
  `,
})
export class GraphRow {
  readonly commit = input.required<Commit>();
  readonly lane = input.required<Lane>();
  readonly selected = input(false);
  /** True while the graph renders a view-only branch lens (ADR-0042). */
  readonly lensActive = input(false);
  /** True when this commit belongs to the lensed ref (`inRefs` from the core). */
  readonly inLens = input(false);
  /** Highest lane index currently in the viewport; keeps every row's graph column aligned. */
  readonly maxLane = input(0);
  /**
   * Lazily-measured change-size counts for this commit (ADR-0023). Null/absent
   * means "not measured yet": the gauge is omitted rather than zeroed.
   */
  readonly stats = input<CommitStats | null>(null);

  readonly picked = output<void>();

  readonly rowHeight = GRAPH_ROW_HEIGHT;

  /**
   * Lens membership exposed as `data-lens` (and used for the host classes):
   * empty without a lens, `in` for a commit reachable from the lensed ref and
   * `out` otherwise.
   */
  readonly lensState = computed<'' | 'in' | 'out'>(() => {
    if (!this.lensActive()) return '';
    return this.inLens() ? 'in' : 'out';
  });

  readonly refs = computed(() => this.commit().refs ?? []);
  readonly statsTitle = computed(() => {
    const gauge = this.stats();
    if (!gauge) return '';
    return `${gauge.additions} additions, ${gauge.deletions} deletions, ${gauge.filesChanged} files changed`;
  });
  readonly shortOid = computed(() => shortOidHex(this.commit().oid?.hex));
  readonly message = computed(() => firstLine(this.commit().message));
  readonly author = computed(() =>
    authorName(this.commit().author?.name, this.commit().committer?.name),
  );
  readonly date = computed(() => formatShortDate(this.commit().committedAt));

  readonly laneX = computed(() => this.lane().index * LANE_COLUMN_WIDTH + LANE_COLUMN_WIDTH / 2);
  readonly graphWidth = computed(
    () => (Math.max(this.maxLane(), this.lane().index) + 1) * LANE_COLUMN_WIDTH,
  );
  readonly color = computed(() => laneColor(this.lane().color));

  refClass(ref: RefLabel): string {
    const kind = normalizeRefKind(ref.kind);
    if (kind === 'branch' && isMainlineBranch(ref.name)) {
      return 'st-graph-row__ref st-graph-row__ref--main';
    }
    return `st-graph-row__ref st-graph-row__ref--${kind}`;
  }
}
