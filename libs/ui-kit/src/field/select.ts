import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Dumb controlled `<select>` (plan §4.9 language picker, P4 ref/PR pickers):
 * projects native `<option>` children and re-emits the picked value. The parent
 * owns the state. `testId` lets a consumer own the inner control's
 * `data-testid` (defaults to `select`).
 */
@Component({
  selector: 'st-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <select
      class="st-select st-focus-ring"
      [attr.data-testid]="testId() || 'select'"
      [value]="value()"
      [disabled]="disabled()"
      [attr.aria-label]="ariaLabel() || null"
      (change)="onChange($event)"
    >
      <ng-content />
    </select>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .st-select {
      box-sizing: border-box;
      width: 100%;
      height: var(--st-size-control-md);
      padding: 0 var(--st-space-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: var(--st-color-surface-2);
      color: var(--st-color-text);
      font-family: var(--st-font-ui);
      font-size: var(--st-font-12);
      font-weight: 400;
      cursor: pointer;
      outline: none;
      transition: border-color var(--st-motion-fast) var(--st-ease);
    }

    .st-select:focus-visible {
      border-color: var(--st-color-accent);
    }

    .st-select:disabled {
      opacity: 0.45;
      cursor: default;
    }
  `,
})
export class SelectComponent {
  readonly value = input('');
  readonly disabled = input(false);
  readonly ariaLabel = input('');
  readonly testId = input('');

  readonly valueChange = output<string>();

  onChange(event: Event): void {
    this.valueChange.emit((event.target as HTMLSelectElement).value);
  }
}
