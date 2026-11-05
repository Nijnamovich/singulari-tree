import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Dumb controlled textarea (plan §4.4 commit message box): the multi-line
 * sibling of `<st-input>`. Re-emits its value on every keystroke; the parent
 * owns the state. `testId` lets a consumer own the inner control's
 * `data-testid` (defaults to `textarea`).
 */
@Component({
  selector: 'st-textarea',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <textarea
      class="st-textarea st-focus-ring"
      [attr.data-testid]="testId() || 'textarea'"
      [rows]="rows()"
      [placeholder]="placeholder()"
      [value]="value()"
      [disabled]="disabled()"
      [attr.aria-label]="ariaLabel() || null"
      (input)="onInput($event)"
    ></textarea>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .st-textarea {
      box-sizing: border-box;
      width: 100%;
      padding: var(--st-space-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: var(--st-color-surface-2);
      color: var(--st-color-text);
      font-family: var(--st-font-ui);
      font-size: var(--st-font-12);
      font-weight: 400;
      line-height: var(--st-leading-ui);
      resize: vertical;
      outline: none;
      transition: border-color var(--st-motion-fast) var(--st-ease);
    }

    .st-textarea:focus-visible {
      border-color: var(--st-color-accent);
    }

    .st-textarea:disabled {
      opacity: 0.45;
      cursor: default;
    }
  `,
})
export class TextareaComponent {
  readonly rows = input(3);
  readonly placeholder = input('');
  readonly value = input('');
  readonly disabled = input(false);
  readonly ariaLabel = input('');
  readonly testId = input('');

  readonly valueChange = output<string>();

  onInput(event: Event): void {
    this.valueChange.emit((event.target as HTMLTextAreaElement).value);
  }
}
