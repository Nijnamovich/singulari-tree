import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type BadgeVariant =
  | 'neutral'
  | 'branch'
  | 'tag'
  | 'success'
  | 'warning'
  | 'add'
  | 'remove'
  | 'warn'
  | 'danger'
  | 'graph-1'
  | 'graph-2'
  | 'graph-3'
  | 'graph-4'
  | 'graph-5'
  | 'graph-6'
  | 'graph-7'
  | 'graph-8';

/**
 * Dumb pill badge for branch/tag/status labels. Renders projected text only.
 */
@Component({
  selector: 'st-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="st-badge st-badge--{{ variant() }}" data-testid="badge"><ng-content /></span>
  `,
  styles: `
    :host {
      display: inline-block;
    }

    .st-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: var(--st-radius-pill);
      font-size: 10px;
      line-height: 14px;
      white-space: nowrap;
    }

    .st-badge--neutral {
      background: var(--st-color-surface);
      color: var(--st-color-text);
      border: 1px solid var(--st-color-border);
    }

    .st-badge--branch {
      background: var(--st-color-badge-branch-bg);
      color: var(--st-color-badge-branch-fg);
    }

    .st-badge--tag {
      background: var(--st-color-badge-tag-bg);
      color: var(--st-color-badge-tag-fg);
    }

    .st-badge--success {
      background: var(--st-color-badge-success-bg);
      color: var(--st-color-badge-success-fg);
    }

    .st-badge--warning {
      background: var(--st-color-badge-warning-bg);
      color: var(--st-color-badge-warning-fg);
    }

    .st-badge--add {
      background: var(--st-color-add-soft);
      color: var(--st-color-add);
    }

    .st-badge--remove {
      background: var(--st-color-remove-soft);
      color: var(--st-color-remove);
    }

    .st-badge--warn {
      background: var(--st-color-warn-soft);
      color: var(--st-color-warn);
    }

    .st-badge--danger {
      background: var(--st-color-danger-soft);
      color: var(--st-color-danger);
    }

    /*
     * Graph lane badges mirror the commit-graph lane palette (plan §4.5):
     * the lane colour is the foreground, a low-alpha mix of it the fill.
     */
    .st-badge--graph-1 {
      background: color-mix(in srgb, var(--st-color-graph-lane-1) 18%, transparent);
      color: var(--st-color-graph-lane-1);
    }

    .st-badge--graph-2 {
      background: color-mix(in srgb, var(--st-color-graph-lane-2) 18%, transparent);
      color: var(--st-color-graph-lane-2);
    }

    .st-badge--graph-3 {
      background: color-mix(in srgb, var(--st-color-graph-lane-3) 18%, transparent);
      color: var(--st-color-graph-lane-3);
    }

    .st-badge--graph-4 {
      background: color-mix(in srgb, var(--st-color-graph-lane-4) 18%, transparent);
      color: var(--st-color-graph-lane-4);
    }

    .st-badge--graph-5 {
      background: color-mix(in srgb, var(--st-color-graph-lane-5) 18%, transparent);
      color: var(--st-color-graph-lane-5);
    }

    .st-badge--graph-6 {
      background: color-mix(in srgb, var(--st-color-graph-lane-6) 18%, transparent);
      color: var(--st-color-graph-lane-6);
    }

    .st-badge--graph-7 {
      background: color-mix(in srgb, var(--st-color-graph-lane-7) 18%, transparent);
      color: var(--st-color-graph-lane-7);
    }

    .st-badge--graph-8 {
      background: color-mix(in srgb, var(--st-color-graph-lane-8) 18%, transparent);
      color: var(--st-color-graph-lane-8);
    }
  `,
})
export class BadgeComponent {
  readonly variant = input<BadgeVariant>('neutral');
}
