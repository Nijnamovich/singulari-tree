import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ConflictOperation, ConflictState } from '@core/services/repo-state.service';

/**
 * Dumb notice shown when a merge, cherry-pick or revert produced conflicts
 * (ADR-028, ADR-0042).
 *
 * Every one of those operations leaves the tree conflicted and there is no
 * in-app resolver: the banner tells the user which operation conflicted and
 * that resolved files must be committed. The parent owns the conflict state and
 * the dismiss side effect; this component only renders.
 */
@Component({
  selector: 'st-merge-conflict-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (conflict()?.hasConflict) {
      <div class="st-merge-conflict" role="alert" data-testid="merge-conflict-banner">
        @if (operation() === 'cherry-pick') {
          <p class="st-merge-conflict__message" data-testid="merge-conflict-message" i18n>
            The cherry-pick produced conflicts. Resolve them in the working tree, then commit.
          </p>
        } @else if (operation() === 'revert') {
          <p class="st-merge-conflict__message" data-testid="merge-conflict-message" i18n>
            The revert produced conflicts. Resolve them in the working tree, then commit.
          </p>
        } @else {
          <p class="st-merge-conflict__message" data-testid="merge-conflict-message" i18n>
            The merge produced conflicts. Resolve them in the working tree, then commit.
          </p>
        }
        <button
          class="st-merge-conflict__dismiss"
          type="button"
          data-testid="merge-conflict-dismiss"
          title="Dismiss"
          i18n-title
          (click)="dismiss.emit()"
        >
          ✕
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .st-merge-conflict {
      display: flex;
      align-items: flex-start;
      gap: var(--st-space-2);
      padding: var(--st-space-2) var(--st-space-3);
      background: var(--st-color-warn-soft);
      border-bottom: 1px solid var(--st-color-warn);
      color: var(--st-color-warn);
      font-size: 12.5px;
    }

    .st-merge-conflict__message {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-weight: 600;
    }

    .st-merge-conflict__dismiss {
      flex: none;
      background: transparent;
      border: 1px solid var(--st-color-warn);
      color: var(--st-color-warn);
      border-radius: 4px;
      cursor: pointer;
      padding: var(--st-hairline) var(--st-space-2);
      line-height: 1.4;
    }

    .st-merge-conflict__dismiss:hover {
      background: var(--st-color-warn-soft);
    }
  `,
})
export class MergeConflictBanner {
  /** The conflict, including which operation produced it. */
  readonly conflict = input<ConflictState | null>(null);
  /** Which operation's sentence to render; defaults to the merge copy. */
  readonly operation = input<ConflictOperation>('merge');
  readonly dismiss = output<void>();
}
