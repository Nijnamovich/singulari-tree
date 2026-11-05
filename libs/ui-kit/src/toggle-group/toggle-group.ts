import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** One segment of the control: a stable value plus its visible label. */
export interface ToggleOption {
  readonly value: string;
  readonly label: string;
  /**
   * Optional count rendered as a small accent-tinted pill after the label
   * (e.g. the pending-file count on the "Local" variant segment). Hidden when
   * absent or zero; capped at `99+`.
   */
  readonly count?: number;
  /**
   * Per-segment disabled state, independent of the group-level `disabled`
   * input. Use it to express "this segment is unavailable for the current
   * data" (e.g. the description segment of a commit with no body) while the
   * other segment stays selectable.
   */
  readonly disabled?: boolean;
}

/**
 * Dumb segmented control (plan §4.9 theme/language/motion, P4 diff mode and the
 * file-status variant bar). One option is selected at a time; the parent owns
 * the state and receives `valueChange` on pick.
 */
@Component({
  selector: 'st-toggle-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="st-toggle-group" role="group" [attr.aria-label]="ariaLabel() || null" data-testid="toggle-group">
      @for (option of options(); track option.value) {
        <button
          type="button"
          class="st-toggle-group__segment st-focus-ring--inset"
          [class.st-toggle-group__segment--active]="option.value === value()"
          [attr.aria-pressed]="option.value === value()"
          [attr.data-testid]="'toggle-segment-' + option.value"
          [disabled]="disabled() || option.disabled === true"
          (click)="valueChange.emit(option.value)"
        >
          {{ option.label }}
          @if (option.count !== undefined && option.count > 0) {
            <span
              class="st-toggle-group__count st-tabular-nums"
              data-testid="toggle-segment-count"
              >{{ badgeCount(option.count) }}</span
            >
          }
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: inline-block;
    }

    .st-toggle-group {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      background: var(--st-color-surface-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
    }

    .st-toggle-group__segment {
      display: inline-flex;
      align-items: center;
      gap: var(--st-space-1);
      padding: 0 var(--st-space-2);
      height: var(--st-size-control-sm);
      border: 0;
      border-radius: var(--st-radius-1);
      background: transparent;
      color: var(--st-color-muted);
      font-family: var(--st-font-ui);
      font-size: var(--st-font-12);
      font-weight: 400;
      white-space: nowrap;
      cursor: pointer;
      transition:
        background-color var(--st-motion-fast) var(--st-ease),
        color var(--st-motion-fast) var(--st-ease);
    }

    /* Segment count pill (e.g. pending files on the "Local" segment): accent
       tint, never stretches or wraps its segment. */
    .st-toggle-group__count {
      display: inline-flex;
      align-items: center;
      flex: none;
      padding: 0 var(--st-space-1);
      border-radius: var(--st-radius-pill);
      background: var(--st-color-accent-soft);
      color: var(--st-color-accent);
      font-size: var(--st-font-10);
      line-height: 14px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .st-toggle-group__segment--active {
      background: var(--st-color-surface);
      color: var(--st-color-text);
    }

    .st-toggle-group__segment:disabled {
      opacity: 0.4;
      cursor: default;
    }
  `,
})
export class ToggleGroupComponent {
  readonly options = input<readonly ToggleOption[]>([]);
  readonly value = input('');
  readonly disabled = input(false);
  /** Optional accessible name for the segmented group (a11y). */
  readonly ariaLabel = input('');

  readonly valueChange = output<string>();

  /** Formats a segment's count pill, capping long values: `100` → `99+`. */
  badgeCount(count: number): string {
    return count > 99 ? '99+' : String(count);
  }
}
