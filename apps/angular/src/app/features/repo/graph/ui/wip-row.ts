import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Synthetic, UI-only row pinned above the virtualized graph, representing the
 * working tree (uncommitted changes). It never triggers a backend call and lives
 * outside `cdk-virtual-scroll-viewport`, so it cannot disturb lane alignment or
 * virtualization math (row height stays exactly one `itemSize`).
 */
@Component({
  selector: 'st-wip-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'st-wip-row',
    role: 'button',
    tabindex: '0',
    // Explicit height binding: the WIP node must occupy exactly one virtual row
    // (28px, matching `GRAPH_ROW_HEIGHT`) so it aligns with the graph lanes.
    '[style.height.px]': 'rowHeight',
    '[class.st-wip-row--selected]': 'selected()',
    '(click)': 'picked.emit()',
    '(keydown.enter)': 'picked.emit()',
  },
  template: `
    <svg class="st-wip-row__graph" width="14" height="28" viewBox="0 0 14 28" aria-hidden="true" focusable="false">
      <circle
        class="st-wip-row__node"
        cx="7"
        cy="14"
        r="4"
        fill="none"
        stroke="var(--st-color-muted)"
        stroke-width="2"
        stroke-dasharray="2 2"
      />
    </svg>
    <span class="st-wip-row__label" data-testid="wip-row-label">Uncommitted changes (WIP)</span>
    <span class="st-wip-row__hint">working tree</span>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 8px;
      cursor: pointer;
      font-size: var(--st-font-12);
      line-height: 1;
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      color: var(--st-color-text);
    }

    :host(:hover) {
      background: color-mix(in srgb, var(--st-color-accent) 10%, transparent);
    }

    :host:focus-visible {
      outline: 1px solid var(--st-color-accent);
      outline-offset: -1px;
    }

    :host(.st-wip-row--selected) {
      background: color-mix(in srgb, var(--st-color-accent) 22%, transparent);
    }

    .st-wip-row__graph {
      flex: none;
      display: block;
    }

    .st-wip-row__label {
      font-style: italic;
    }

    .st-wip-row__hint {
      margin-left: auto;
      color: var(--st-color-muted);
      font-size: var(--st-font-11);
    }
  `,
})
export class WipRow {
  /** Same fixed height as `GRAPH_ROW_HEIGHT` so the pinned node aligns with rows. */
  readonly rowHeight = 28;

  readonly selected = input(false);
  readonly picked = output<void>();
}
