import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ButtonComponent } from '@singularitree/ui-kit';
import { ModalComponent } from '@shared/ui/modal/modal';

/**
 * Destructive-confirmation gate for `git reset --hard` (ADR-0021).
 *
 * Core stays headless and executes exactly what it is told, so the renderer must
 * confirm before a hard reset discards the working tree. Dumb: it only renders
 * the warning and emits `confirmed` / `cancelled`; the store performs the RPC.
 */
@Component({
  selector: 'st-reset-confirm-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal
      [open]="open()"
      title="Reset hard — discard changes?"
      [closeOnBackdrop]="!busy()"
      (closed)="cancelled.emit()"
    >
      <p class="st-reset-confirm__warning" data-testid="reset-confirm-warning">
        A hard reset moves HEAD and resets the index, and
        <strong>discards every working-tree change</strong>. This cannot be undone.
      </p>
      <p class="st-reset-confirm__target" data-testid="reset-confirm-oid">
        Target commit: <code>{{ oid() }}</code>
      </p>
      <st-button
        st-modal-footer
        variant="default"
        data-testid="reset-confirm-cancel"
        [disabled]="busy()"
        (click)="cancelled.emit()"
      >
        Cancel
      </st-button>
      <st-button
        st-modal-footer
        variant="danger"
        data-testid="reset-confirm-confirm"
        [disabled]="busy()"
        (click)="confirmed.emit()"
      >
        Reset hard
      </st-button>
    </st-modal>
  `,
  styles: `
    .st-reset-confirm__warning {
      margin: 0 0 var(--st-space-3);
      line-height: var(--st-leading-ui);
    }

    .st-reset-confirm__target {
      margin: 0;
      color: var(--st-color-muted);
    }

    .st-reset-confirm__target code {
      font-family: var(--st-font-mono);
      word-break: break-all;
    }
  `,
})
export class ResetConfirmDialog {
  readonly open = input(false);
  readonly oid = input<string | null>(null);
  readonly busy = input(false);

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
}
