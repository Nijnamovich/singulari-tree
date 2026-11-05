import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import type { MergeResponse } from '@contracts/gitcore';
import { ButtonComponent, InputComponent, SelectComponent } from '@singularitree/ui-kit';
import { ModalComponent } from '@shared/ui/modal/modal';
import type { AppError } from '@core/services/ipc-bridge.service';
import {
  MERGE_STRATEGIES,
  type MergeStrategyName,
  type MergeValue,
} from './ref-dialog.models';

/**
 * Dumb merge dialog (ADR-028).
 *
 * The parent supplies the mergeable refs (local branches), the current branch,
 * the busy flag, an optional error and a conflict result, and reacts to
 * `submitted`. M3 surfaces conflicts instead of resolving them: when a merge
 * produces `hasConflict`, the container shows the conflict notice and refreshes
 * the working tree (no 3-way editor in M3). Reuses the shared `st-modal` shell.
 */
@Component({
  selector: 'st-merge-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent, InputComponent, SelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal [open]="open()" title="Merge into current" [closeOnBackdrop]="!running()" (closed)="cancel()">
      @if (currentBranch()) {
        <p class="st-ref-dialog__current" data-testid="merge-current">
          <span i18n>Current branch</span>: <strong>{{ currentBranch() }}</strong>
        </p>
      }

      <label class="st-ref-dialog__field">
        <span i18n>Branch to merge</span>
        <st-select [testId]="'merge-ref'" [value]="ref()" (valueChange)="ref.set($event)">
          @if (available().length === 0) {
            <option value="" i18n>No other branch</option>
          }
          @for (branch of available(); track branch) {
            <option [value]="branch">{{ branch }}</option>
          }
        </st-select>
      </label>

      <label class="st-ref-dialog__field">
        <span i18n>Strategy</span>
        <st-select
          [testId]="'merge-strategy'"
          [value]="strategy()"
          (valueChange)="onStrategy($event)"
        >
          @for (option of STRATEGIES; track option) {
            <option [value]="option">{{ option }}</option>
          }
        </st-select>
      </label>

      <label class="st-ref-dialog__check">
        <input
          type="checkbox"
          data-testid="merge-nocommit"
          [checked]="noCommit()"
          (change)="onNoCommit($event)"
        />
        <span i18n>Do not commit (leave staged)</span>
      </label>

      <label class="st-ref-dialog__field">
        <span i18n>Message (optional)</span>
        <st-input
          [testId]="'merge-message'"
          [value]="message()"
          (valueChange)="message.set($event)"
        />
      </label>

      @if (conflict()?.hasConflict) {
        <p class="st-ref-dialog__conflict" data-testid="merge-conflict" i18n>
          The merge produced conflicts. Resolve them in the working tree.
        </p>
      }

      @if (error(); as err) {
        <p class="st-ref-dialog__error" data-testid="merge-error">{{ err.message }}</p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="merge-cancel"
        [disabled]="running()"
        (click)="cancel()"
      >
        Cancel
      </st-button>
      <st-button
        st-modal-footer
        variant="primary"
        data-testid="merge-submit"
        [disabled]="!ref() || running()"
        (click)="submit()"
      >
        Merge
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
    }

    .st-ref-dialog__field {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      margin-bottom: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__check {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      margin-bottom: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__check input {
      accent-color: var(--st-color-accent);
    }

    .st-ref-dialog__conflict {
      margin: 0 0 var(--st-space-3);
      color: var(--st-color-warn);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__error {
      margin: 0 0 var(--st-space-3);
      color: var(--st-color-danger);
      font-size: var(--st-font-12);
    }
  `,
})
export class MergeDialog {
  readonly open = input(false);
  /** Selectable refs (local branch names) — the current branch should be excluded. */
  readonly branches = input<readonly string[]>([]);
  readonly currentBranch = input('');
  /** Ref preselected when the dialog opens (the row the menu was opened on). */
  readonly defaultRef = input('');
  readonly running = input(false);
  readonly error = input<AppError | null>(null);
  readonly conflict = input<MergeResponse | null>(null);

  readonly submitted = output<MergeValue>();
  readonly cancelled = output<void>();

  readonly STRATEGIES = MERGE_STRATEGIES;

  readonly ref = signal('');
  readonly strategy = signal<MergeStrategyName>('MERGE');
  readonly noCommit = signal(false);
  readonly message = signal('');

  /** Refs offered for selection: every branch except the current one. */
  readonly available = computed(() =>
    this.branches().filter((branch) => branch !== this.currentBranch()),
  );

  constructor() {
    // Re-seed the form on every open: prefer the requested ref, else the first
    // mergeable one.
    effect(() => {
      if (this.open()) {
        const options = this.available();
        const preferred = this.defaultRef();
        this.ref.set(options.includes(preferred) ? preferred : (options[0] ?? ''));
        this.strategy.set('MERGE');
        this.noCommit.set(false);
        this.message.set('');
      }
    });
  }

  onStrategy(value: string): void {
    this.strategy.set(value as MergeStrategyName);
  }

  onNoCommit(event: Event): void {
    this.noCommit.set((event.target as HTMLInputElement).checked);
  }

  submit(): void {
    if (!this.ref() || this.running()) return;
    this.submitted.emit({
      ref: this.ref(),
      strategy: this.strategy(),
      noCommit: this.noCommit(),
      message: this.message().trim(),
    });
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
