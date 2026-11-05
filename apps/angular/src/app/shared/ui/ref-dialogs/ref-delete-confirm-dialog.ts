import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ButtonComponent } from '@singularitree/ui-kit';
import { ModalComponent } from '@shared/ui/modal/modal';
import type { AppError } from '@core/services/ipc-bridge.service';

/** Which ref kind is being deleted; only affects the copy. */
export type RefDeleteKind = 'branch' | 'tag';

/**
 * Dumb destructive-confirmation gate for deleting a branch or a tag (ADR-028).
 *
 * Branches additionally offer the `force` flag (`git branch -D`), which the
 * parent can hide for tags. Reuses the shared `st-modal` shell; Escape/backdrop
 * map to `cancelled`. Core stays headless and does exactly what it is told, so
 * the renderer confirms first.
 */
@Component({
  selector: 'st-ref-delete-confirm-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal [open]="open()" [title]="title()" [closeOnBackdrop]="!running()" (closed)="cancel()">
      <p class="st-ref-dialog__warning" data-testid="ref-delete-warning">
        Delete {{ kind() }} <strong>{{ name() }}</strong>? This cannot be undone from the UI.
      </p>

      @if (showForce()) {
        <label class="st-ref-dialog__check">
          <input
            type="checkbox"
            data-testid="ref-delete-force"
            [checked]="force()"
            (change)="onForce($event)"
          />
          <span i18n>Force (delete even if unmerged)</span>
        </label>
      }

      @if (error(); as err) {
        <p class="st-ref-dialog__error" data-testid="ref-delete-error">{{ err.message }}</p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="ref-delete-cancel"
        [disabled]="running()"
        (click)="cancel()"
      >
        Cancel
      </st-button>
      <st-button
        st-modal-footer
        variant="danger"
        data-testid="ref-delete-confirm"
        [disabled]="running()"
        (click)="confirm()"
      >
        Delete
      </st-button>
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-ref-dialog__warning {
      margin: 0;
      font-size: var(--st-font-13);
      line-height: var(--st-leading-ui);
    }

    .st-ref-dialog__check {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      margin-top: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__check input {
      accent-color: var(--st-color-accent);
    }

    .st-ref-dialog__error {
      margin: var(--st-space-3) 0 0;
      color: var(--st-color-danger);
      font-size: var(--st-font-12);
    }
  `,
})
export class RefDeleteConfirmDialog {
  readonly open = input(false);
  readonly kind = input<RefDeleteKind>('branch');
  readonly name = input('');
  readonly showForce = input(true);
  readonly running = input(false);
  readonly error = input<AppError | null>(null);

  readonly confirmed = output<boolean>();
  readonly cancelled = output<void>();

  readonly force = signal(false);

  readonly title = computed(() => (this.kind() === 'tag' ? 'Delete tag' : 'Delete branch'));

  onForce(event: Event): void {
    this.force.set((event.target as HTMLInputElement).checked);
  }

  confirm(): void {
    if (this.running()) return;
    this.confirmed.emit(this.force());
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
