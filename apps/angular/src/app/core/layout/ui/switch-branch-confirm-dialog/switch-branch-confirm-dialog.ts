import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { ModalComponent } from '@shared/ui/modal/modal';
import { ButtonComponent } from '@singularitree/ui-kit';

/**
 * Mode of the branch-switch confirmation:
 * - `confirm`: pre-checkout confirmation shown on every branch selection; the
 *   user can switch normally or tick `force (discard changes)` and switch
 *   forcefully.
 * - `dirty`: the checkout is blocked by tracked working-tree modifications;
 *   the user can force the checkout (discarding them), stash them first, or
 *   cancel.
 * - `untracked`: a forced checkout is still blocked by untracked files; the
 *   user must accept their permanent deletion or cancel.
 */
export type SwitchBranchMode = 'confirm' | 'dirty' | 'untracked';

/**
 * Dumb confirmation dialog for the branch-switch flow.
 *
 * It owns no domain state: the parent supplies the clicked branch display name
 * and the `mode`, and reacts to the emitted actions. Reuses the shared
 * `st-modal` shell (Escape/backdrop `closed` maps to `cancel`). In `confirm`
 * mode the `force (discard changes)` checkbox is read at Switch time and its
 * value is emitted via `confirmed`; in `dirty` mode the same checkbox arms the
 * destructive Force checkout action, so a destructive checkout is always an
 * explicit choice.
 */
@Component({
  selector: 'st-switch-branch-confirm-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal [open]="open()" [title]="title()" (closed)="cancel.emit()">
      <p class="st-switch__message" data-testid="switch-branch-message">
        {{ message() }}
      </p>

      @if (mode() === 'dirty') {
        <p class="st-switch__hint" data-testid="switch-branch-hint">
          <strong>Force checkout</strong> discards ALL uncommitted tracked changes.
          <strong>Save changes</strong> stashes them so you can restore them later.
        </p>
        <label class="st-switch__check">
          <input
            type="checkbox"
            data-testid="switch-branch-force-checkbox"
            [checked]="forceArmed()"
            (change)="onForceArmedChange($event)"
          />
          force (discard changes)
        </label>
      } @else if (mode() === 'confirm') {
        <label class="st-switch__check">
          <input
            type="checkbox"
            data-testid="switch-branch-force-checkbox"
            [checked]="forceArmed()"
            (change)="onForceArmedChange($event)"
          />
          force (discard changes)
        </label>
      } @else {
        <p class="st-switch__warning" data-testid="switch-branch-warning">
          All untracked files and folders will be permanently deleted. Ignored files
          are kept.
        </p>
      }

      <div class="st-switch__footer" st-modal-footer>
        <st-button variant="default" data-testid="switch-branch-cancel" (click)="cancel.emit()">
          Cancel
        </st-button>
        @if (mode() === 'dirty') {
          <st-button variant="default" data-testid="switch-branch-save" (click)="saveChanges.emit()">
            Save changes (stash)
          </st-button>
          <st-button
            variant="danger"
            data-testid="switch-branch-force"
            [disabled]="!forceArmed()"
            (click)="forceCheckout.emit()"
          >
            Force checkout
          </st-button>
        } @else if (mode() === 'confirm') {
          <st-button
            variant="primary"
            data-testid="switch-branch-confirm"
            (click)="confirmed.emit(forceArmed())"
          >
            Switch
          </st-button>
        } @else {
          <st-button variant="danger" data-testid="switch-branch-force" (click)="forceCheckout.emit()">
            Delete untracked files and checkout
          </st-button>
        }
      </div>
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-switch__message {
      margin: 0;
      font-size: var(--st-font-13);
      line-height: var(--st-leading-ui);
      color: var(--st-color-text);
    }

    .st-switch__hint {
      margin: var(--st-space-3) 0 0;
      font-size: var(--st-font-12);
      line-height: var(--st-leading-ui);
      color: var(--st-color-muted);
    }

    .st-switch__warning {
      margin: var(--st-space-3) 0 0;
      font-size: var(--st-font-12);
      line-height: var(--st-leading-ui);
      color: var(--st-color-danger);
    }

    .st-switch__check {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      margin-top: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-switch__footer {
      display: flex;
      gap: var(--st-space-2);
    }
  `,
})
export class SwitchBranchConfirmDialog {
  readonly open = input(false);
  /** Display name of the branch the user is switching to. */
  readonly branchName = input('');
  readonly mode = input<SwitchBranchMode>('dirty');

  /** Force the checkout, discarding tracked changes (or untracked files too). */
  readonly forceCheckout = output<void>();
  /** Stash the working-tree changes first, then retry the checkout. */
  readonly saveChanges = output<void>();
  /** Dismiss the dialog without changing state. */
  readonly cancel = output<void>();
  /** `confirm` mode: switch the branch, carrying the force checkbox value. */
  readonly confirmed = output<boolean>();

  /** True once the user ticked `force (discard changes)`. */
  readonly forceArmed = signal(false);

  /** Exact confirmation copy; the untracked mode swaps in the deletion warning. */
  readonly message = computed(() => {
    const name = this.branchName();
    if (this.mode() === 'untracked') {
      return `Switching your working copy to a branch '${name}' will permanently delete untracked files.`;
    }
    return `Are you sure you want to switch your working copy to a branch '${name}'?`;
  });

  readonly title = computed(() =>
    this.mode() === 'untracked' ? 'Switch branch — untracked files' : 'Switch branch',
  );

  constructor() {
    // Re-arm the destructive action from a clean state on every open / mode
    // change, so a previous confirmation never carries over.
    effect(() => {
      if (this.open()) {
        this.mode();
        this.forceArmed.set(false);
      }
    });
  }

  onForceArmedChange(event: Event): void {
    this.forceArmed.set((event.target as HTMLInputElement).checked);
  }
}
