import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';
import { ButtonComponent, InputComponent } from '@singularitree/ui-kit';
import { ModalComponent } from '@shared/ui/modal/modal';
import type { AppError } from '@core/services/ipc-bridge.service';

/**
 * Dumb stash-push dialog (ADR-028).
 *
 * Collects an optional message for `stashPush`; the parent owns the store call
 * and the busy/error state. An empty message lets the core pick a default.
 * Reuses the shared `st-modal` shell; Escape/backdrop map to `cancelled`.
 */
@Component({
  selector: 'st-stash-push-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent, InputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal
      [open]="open()"
      title="Stash current changes"
      i18n-title
      [closeOnBackdrop]="!running()"
      (closed)="cancel()"
    >
      <label class="st-stash-dialog__field">
        <span i18n>Message (optional)</span>
        <st-input
          [testId]="'stash-push-message'"
          [value]="message()"
          (valueChange)="message.set($event)"
        />
      </label>

      @if (error(); as err) {
        <p class="st-stash-dialog__error" data-testid="stash-push-error">{{ err.message }}</p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="stash-push-cancel"
        [disabled]="running()"
        (click)="cancel()"
      >
        <span i18n>Cancel</span>
      </st-button>
      <st-button
        st-modal-footer
        variant="primary"
        data-testid="stash-push-submit"
        [disabled]="running()"
        (click)="submit()"
      >
        <span i18n>Stash</span>
      </st-button>
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-stash-dialog__field {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      margin-bottom: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-stash-dialog__error {
      margin: 0 0 var(--st-space-3);
      color: var(--st-color-danger);
      font-size: var(--st-font-12);
    }
  `,
})
export class StashPushDialog {
  readonly open = input(false);
  readonly running = input(false);
  readonly error = input<AppError | null>(null);

  readonly submitted = output<string>();
  readonly cancelled = output<void>();

  readonly message = signal('');

  constructor() {
    // Clear the field on every open so a previous message never carries over.
    effect(() => {
      if (this.open()) this.message.set('');
    });
  }

  submit(): void {
    if (this.running()) return;
    this.submitted.emit(this.message().trim());
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
