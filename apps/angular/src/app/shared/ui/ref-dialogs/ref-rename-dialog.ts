import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { ButtonComponent, InputComponent } from '@singularitree/ui-kit';
import { ModalComponent } from '@shared/ui/modal/modal';
import type { AppError } from '@core/services/ipc-bridge.service';

/**
 * Dumb rename dialog (ADR-028) for a branch ref.
 *
 * The parent supplies the current name, the busy flag and an optional error,
 * and reacts to `submitted` with the new name. Reuses the shared `st-modal`
 * shell; Escape/backdrop map to `cancelled`.
 */
@Component({
  selector: 'st-ref-rename-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent, InputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal
      [open]="open()"
      title="Rename branch"
      [closeOnBackdrop]="!running()"
      (closed)="cancel()"
    >
      <p class="st-ref-dialog__current" data-testid="ref-rename-current">
        {{ currentName() }}
      </p>
      <label class="st-ref-dialog__field">
        <span i18n>New name</span>
        <st-input
          [testId]="'ref-rename-input'"
          [value]="newName()"
          (keydown.enter)="submit()"
          (valueChange)="newName.set($event)"
        />
      </label>

      @if (error(); as err) {
        <p class="st-ref-dialog__error" data-testid="ref-rename-error">{{ err.message }}</p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="ref-rename-cancel"
        [disabled]="running()"
        (click)="cancel()"
      >
        Cancel
      </st-button>
      <st-button
        st-modal-footer
        variant="primary"
        data-testid="ref-rename-submit"
        [disabled]="!canSubmit() || running()"
        (click)="submit()"
      >
        Rename
      </st-button>
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-ref-dialog__current {
      margin: 0 0 var(--st-space-3);
      font-family: var(--st-font-mono);
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
      word-break: break-all;
    }

    .st-ref-dialog__field {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__error {
      margin: var(--st-space-3) 0 0;
      color: var(--st-color-danger);
      font-size: var(--st-font-12);
    }
  `,
})
export class RefRenameDialog {
  readonly open = input(false);
  readonly currentName = input('');
  readonly running = input(false);
  readonly error = input<AppError | null>(null);

  readonly submitted = output<string>();
  readonly cancelled = output<void>();

  readonly newName = signal('');

  readonly canSubmit = () =>
    this.newName().trim().length > 0 && this.newName().trim() !== this.currentName();

  constructor() {
    // Seed the input with the current name on every open so a previous edit
    // never carries over.
    effect(() => {
      if (this.open()) {
        this.newName.set(this.currentName());
      }
    });
  }

  submit(): void {
    if (!this.canSubmit() || this.running()) return;
    this.submitted.emit(this.newName().trim());
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
