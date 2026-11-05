import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ButtonComponent } from '@singularitree/ui-kit';
import { ModalComponent } from '@shared/ui/modal/modal';
import type { AppError } from '@core/services/ipc-bridge.service';

/**
 * Dumb destructive-confirmation gate for dropping a stash entry (ADR-028).
 *
 * Dropping a stash is irreversible from the UI, so the renderer confirms first.
 * Reuses the shared `st-modal` shell; Escape/backdrop map to `cancelled`.
 */
@Component({
  selector: 'st-stash-drop-confirm-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal [open]="open()" title="Drop stash" i18n-title [closeOnBackdrop]="!running()" (closed)="cancel()">
      <p class="st-stash-dialog__warning" data-testid="stash-drop-warning">
        <span i18n>Drop</span> <strong>{{ label() }}</strong>?
        <span i18n>This cannot be undone from the UI.</span>
      </p>

      @if (message()) {
        <p class="st-stash-dialog__message" data-testid="stash-drop-message">{{ message() }}</p>
      }

      @if (error(); as err) {
        <p class="st-stash-dialog__error" data-testid="stash-drop-error">{{ err.message }}</p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="stash-drop-cancel"
        [disabled]="running()"
        (click)="cancel()"
      >
        <span i18n>Cancel</span>
      </st-button>
      <st-button
        st-modal-footer
        variant="danger"
        data-testid="stash-drop-confirm"
        [disabled]="running()"
        (click)="confirm()"
      >
        <span i18n>Drop</span>
      </st-button>
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-stash-dialog__warning {
      margin: 0;
      font-size: var(--st-font-13);
      line-height: var(--st-leading-ui);
    }

    .st-stash-dialog__message {
      margin: var(--st-space-3) 0 0;
      color: var(--st-color-muted);
      font-size: var(--st-font-12);
    }

    .st-stash-dialog__error {
      margin: var(--st-space-3) 0 0;
      color: var(--st-color-danger);
      font-size: var(--st-font-12);
    }
  `,
})
export class StashDropConfirmDialog {
  readonly open = input(false);
  readonly index = input(0);
  /** Stash message shown for context; empty hides the line. */
  readonly message = input('');
  readonly running = input(false);
  readonly error = input<AppError | null>(null);

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  /** Git-style stash label, e.g. `stash@{0}` (syntax, not prose). */
  readonly label = computed(() => `stash@{${this.index()}}`);

  confirm(): void {
    if (this.running()) return;
    this.confirmed.emit();
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
