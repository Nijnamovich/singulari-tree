import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { ModalComponent } from '@shared/ui/modal/modal';
import { ButtonComponent, InputComponent } from '@singularitree/ui-kit';

/**
 * Clone dialog stub (ADR-025).
 *
 * Prefill only: the shell/renderer validate a git URL and hand it here, but
 * cloning itself is V1.4 onboarding, so the primary action is deliberately
 * inert. The renderer never contacts Git. The parent supplies the prefilled URL
 * (from a `singularitree://clone?url=…` deep link or the clipboard) and an
 * optional validation error; the dialog owns only its editable field.
 */
@Component({
  selector: 'st-clone-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent, InputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal [open]="open()" title="Clone repository" i18n-title (closed)="cancelled.emit()">
      <label class="st-clone-dialog__field">
        <span i18n>Repository URL</span>
        <st-input
          [testId]="'clone-url'"
          [value]="urlValue()"
          [placeholder]="urlPlaceholder"
          (valueChange)="onUrl($event)"
        />
      </label>

      @if (error(); as err) {
        <p class="st-clone-dialog__error" data-testid="clone-error">{{ err }}</p>
      } @else {
        <p class="st-clone-dialog__note" data-testid="clone-note" i18n>
          Cloning is not available yet. This dialog only prefills the URL.
        </p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="clone-cancel"
        (click)="cancelled.emit()"
        i18n
        >Cancel</st-button
      >
      <st-button
        st-modal-footer
        variant="primary"
        data-testid="clone-submit"
        [disabled]="true"
        i18n
        >Clone</st-button
      >
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-clone-dialog__field {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      margin-bottom: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-clone-dialog__note {
      margin: var(--st-space-3) 0 0;
      color: var(--st-color-muted);
      font-size: var(--st-font-12);
    }

    .st-clone-dialog__error {
      margin: var(--st-space-3) 0 0;
      color: var(--st-color-danger);
      font-size: var(--st-font-12);
    }
  `,
})
export class CloneDialog {
  readonly open = input(false);
  /** Prefilled git URL supplied by the caller. */
  readonly url = input('');
  /** Optional validation message (e.g. clipboard did not contain a git URL). */
  readonly error = input<string | null>(null);

  readonly cancelled = output<void>();

  /** Editable copy of the prefilled URL; re-seeded on every open. */
  readonly urlValue = signal('');
  /** Translated placeholder for the URL field. */
  readonly urlPlaceholder = $localize`https://example.com/me/app.git`;

  constructor() {
    effect(() => {
      if (this.open()) this.urlValue.set(this.url());
    });
  }

  onUrl(value: string): void {
    this.urlValue.set(value);
  }
}
