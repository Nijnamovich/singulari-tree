import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BadgeComponent } from '../badge/badge';
import { IconComponent } from '../icon/icon';

/**
 * Dumb navigation-rail item (plan §4.2): an icon + label + optional count pill
 * inside a native `<button>`. The parent owns routing; consumers attach
 * `(click)` on the `<st-nav-item>` host — the inner button's click bubbles up.
 *
 * Active state is one reusable treatment: accent text, an `--st-color-accent-soft`
 * fill, a turquoise `--st-color-accent` border and the 3px inset selection bar
 * (`st-selection-bar`) so a rail item reads exactly like a selected list row.
 * The icon inherits `currentColor`, so the active icon turns turquoise too. The
 * count pill reuses `st-badge` in its neutral variant; it is hidden when the
 * count is 0 or absent.
 */
@Component({
  selector: 'st-nav-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, BadgeComponent],
  host: {
    class: 'st-nav-item-host',
    '[class.st-nav-item-host--disabled]': 'disabled()',
  },
  template: `
    <button
      type="button"
      class="st-nav-item st-selectable-row st-focus-ring--inset"
      data-testid="nav-item"
      [class.st-nav-item--active]="active()"
      [class.st-selection-bar]="active()"
      [disabled]="disabled()"
      [attr.aria-current]="active() ? 'page' : null"
    >
      <st-icon class="st-nav-item__icon" [name]="icon()" />
      <span class="st-nav-item__label" data-testid="nav-item-label">{{ label() }}</span>
      @if (hasCount()) {
        <st-badge class="st-nav-item__count" data-testid="nav-item-count" variant="neutral">{{
          count()
        }}</st-badge>
      }
    </button>
  `,
  styles: `
    :host {
      display: block;
    }

    :host(.st-nav-item-host--disabled) {
      cursor: default;
    }

    .st-nav-item {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      width: 100%;
      height: var(--st-size-row-tree-dense);
      padding: 0 var(--st-space-2);
      /* Transparent hairline border keeps the 24px outer box (border-box) while
         letting the active state paint a turquoise edge. */
      border: var(--st-hairline) solid transparent;
      border-radius: var(--st-radius-2);
      background: transparent;
      color: var(--st-color-muted);
      font-family: var(--st-font-ui);
      font-size: var(--st-font-13);
      font-weight: 400;
      text-align: left;
      cursor: pointer;
      transition:
        background-color var(--st-motion-fast) var(--st-ease),
        color var(--st-motion-fast) var(--st-ease);
    }

    .st-nav-item__icon {
      flex: none;
      color: inherit;
    }

    .st-nav-item__label {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .st-nav-item__count {
      flex: none;
    }

    .st-nav-item--active {
      background: var(--st-color-accent-soft);
      border-color: var(--st-color-accent);
      color: var(--st-color-accent);
    }

    .st-nav-item:disabled {
      opacity: 0.4;
      cursor: default;
    }

    /* A disabled row never paints a hover surface, whatever the utility does. */
    :host(.st-nav-item-host--disabled) .st-nav-item:hover {
      background: transparent;
    }
  `,
})
export class NavItemComponent {
  readonly icon = input('');
  readonly label = input('');
  readonly count = input<number | undefined>(undefined);
  readonly active = input(false);
  readonly disabled = input(false);

  readonly hasCount = computed(() => (this.count() ?? 0) > 0);
}
