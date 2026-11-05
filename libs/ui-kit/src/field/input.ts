import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export type InputType = 'text' | 'search' | 'password';

/**
 * Dumb controlled text field (plan §4.2 branch filter, §4.5 search, §4.7 repo
 * search): wraps a native `<input>` and re-emits its value on every keystroke.
 * The parent owns the state — `value` is written back into the field, so the
 * control stays a pure function of its input.
 * `testId` lets a consumer own the inner control's `data-testid` (defaults to
 * `input`); `readonly` renders the field read-only (surface kept, text dimmed).
 */
@Component({
  selector: 'st-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <input
      class="st-input st-focus-ring"
      [attr.data-testid]="testId() || 'input'"
      [type]="type()"
      [placeholder]="placeholder()"
      [value]="value()"
      [disabled]="disabled()"
      [readonly]="readonly()"
      [attr.aria-label]="ariaLabel() || null"
      (input)="onInput($event)"
    />
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .st-input {
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
      outline: none;
      transition: border-color var(--st-motion-fast) var(--st-ease);
    }

    .st-input:focus-visible {
      border-color: var(--st-color-accent);
    }

    .st-input:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .st-input[readonly] {
      color: var(--st-color-muted);
      cursor: default;
    }
  `,
})
export class InputComponent {
  readonly type = input<InputType>('text');
  readonly placeholder = input('');
  readonly value = input('');
  readonly disabled = input(false);
  readonly ariaLabel = input('');
  readonly testId = input('');
  readonly readonly = input(false);

  readonly valueChange = output<string>();

  onInput(event: Event): void {
    this.valueChange.emit((event.target as HTMLInputElement).value);
  }
}
