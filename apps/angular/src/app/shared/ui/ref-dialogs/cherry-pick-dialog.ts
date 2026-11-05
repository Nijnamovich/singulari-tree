import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { Commit } from '@contracts/domain';
import { ButtonComponent, InputComponent, SelectComponent } from '@singularitree/ui-kit';
import { ModalComponent } from '@shared/ui/modal/modal';
import type { AppError } from '@core/services/ipc-bridge.service';
import type { ConflictState } from '@core/services/repo-state.service';
import type { CherryPickValue } from './ref-dialog.models';

/**
 * Dumb cherry-pick dialog (ADR-0042).
 *
 * The parent supplies the selectable refs, the current branch, the clicked
 * commit as the source default, the busy flag, an optional error and the
 * RESOLVED preview (commit/loading/error) of the revision the user typed. This
 * component owns only the form: the source text (debounced so the parent
 * resolves one preview per settled value), the two flags and the submit gate.
 *
 * There is no confirmation step: the preview IS the confirmation. The primary
 * action stays disabled until the source resolves to a commit, so the user can
 * never pick a revision they have not seen. A conflict keeps the dialog open
 * with a warn row (no in-app resolver).
 */
@Component({
  selector: 'st-cherry-pick-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent, InputComponent, SelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal
      [open]="open()"
      title="Cherry-pick commit"
      i18n-title
      [closeOnBackdrop]="!running()"
      (closed)="cancel()"
    >
      <p class="st-ref-dialog__current" data-testid="cherry-current">
        <span i18n>Current branch</span>: <strong>{{ currentBranch() || '—' }}</strong>
      </p>

      <label class="st-ref-dialog__field">
        <span i18n>Source</span>
        <st-input
          class="st-ref-dialog__mono"
          [testId]="'cherry-source'"
          [value]="source()"
          [disabled]="running()"
          placeholder="sha, branch, remote branch, tag or revision"
          i18n-placeholder
          (valueChange)="onSourceInput($event)"
        />
      </label>

      <label class="st-ref-dialog__field">
        <span i18n>Pick a ref</span>
        <st-select
          [testId]="'cherry-pick-source'"
          [value]="picked()"
          [disabled]="running()"
          [ariaLabel]="pickAriaLabel"
          (valueChange)="onPick($event)"
        >
          <option value="" i18n>Pick…</option>
          @if (localOptions().length > 0) {
            <optgroup label="Local branches" i18n-label>
              @for (branch of localOptions(); track branch) {
                <option [value]="branch">{{ branch }}</option>
              }
            </optgroup>
          }
          @if (remoteOptions().length > 0) {
            <optgroup label="Remote branches" i18n-label>
              @for (branch of remoteOptions(); track branch) {
                <option [value]="branch">{{ branch }}</option>
              }
            </optgroup>
          }
          @if (tagOptions().length > 0) {
            <optgroup label="Tags" i18n-label>
              @for (tag of tagOptions(); track tag) {
                <option [value]="tag">{{ tag }}</option>
              }
            </optgroup>
          }
        </st-select>
      </label>

      @if (previewLoading()) {
        <p class="st-ref-dialog__hint" data-testid="cherry-preview-loading" i18n>
          Resolving revision…
        </p>
      }

      @if (preview(); as commit) {
        <div class="st-ref-dialog__preview" data-testid="cherry-preview">
          <p class="st-ref-dialog__preview-subject" data-testid="cherry-preview-subject">
            {{ subject(commit) }}
          </p>
          <p class="st-ref-dialog__preview-meta">
            <span class="st-ref-dialog__sha" data-testid="cherry-preview-sha">{{
              shortSha(commit)
            }}</span>
            <span data-testid="cherry-preview-author">{{ commit.author?.name ?? '' }}</span>
            <span data-testid="cherry-preview-date">{{ commit.committedAt }}</span>
          </p>
        </div>
      }

      @if (previewError(); as previewFailure) {
        <p class="st-ref-dialog__error" data-testid="cherry-preview-error">
          {{ previewErrorMessage(previewFailure) }}
        </p>
      }

      <label class="st-ref-dialog__check">
        <input
          type="checkbox"
          data-testid="cherry-record-origin"
          [checked]="recordOrigin()"
          [disabled]="running()"
          (change)="onRecordOrigin($event)"
        />
        <span i18n>Append source commit reference (-x)</span>
      </label>

      <label class="st-ref-dialog__check">
        <input
          type="checkbox"
          data-testid="cherry-no-commit"
          [checked]="noCommit()"
          [disabled]="running()"
          (change)="onNoCommit($event)"
        />
        <span i18n>Do not commit (leave staged)</span>
      </label>

      @if (conflict()?.operation === 'cherry-pick' && conflict()?.hasConflict) {
        <p class="st-ref-dialog__conflict" data-testid="cherry-conflict" i18n>
          The cherry-pick produced conflicts. Resolve them in the working tree, then commit.
        </p>
      }

      @if (error(); as failure) {
        <p class="st-ref-dialog__error" data-testid="cherry-error">
          {{ submitErrorMessage(failure) }}
        </p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="cherry-cancel"
        [disabled]="running()"
        (click)="cancel()"
      >
        <span i18n>Cancel</span>
      </st-button>
      <st-button
        st-modal-footer
        variant="primary"
        data-testid="cherry-submit"
        [disabled]="!canSubmit()"
        (click)="submit()"
      >
        <span i18n>Cherry-pick</span>
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

    /* Revisions are typed/pasted: render them in the mono face. */
    :host ::ng-deep .st-ref-dialog__mono input {
      font-family: var(--st-font-mono);
    }

    .st-ref-dialog__hint {
      margin: 0 0 var(--st-space-3);
      color: var(--st-color-muted);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__preview {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      margin-bottom: var(--st-space-3);
      padding: var(--st-space-2) var(--st-space-3);
      background: var(--st-color-surface-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-3);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__preview-subject {
      margin: 0;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .st-ref-dialog__preview-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--st-space-2);
      margin: 0;
      color: var(--st-color-muted);
      font-size: var(--st-font-11);
    }

    .st-ref-dialog__sha {
      font-family: var(--st-font-mono);
    }

    .st-ref-dialog__check {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      margin-bottom: var(--st-space-2);
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
export class CherryPickDialog {
  /** Debounce applied to the typed source before the parent previews it. */
  private static readonly SOURCE_DEBOUNCE_MS = 250;

  /** Localized accessible name for the ref picker. */
  readonly pickAriaLabel = $localize`Pick a ref`;

  readonly open = input(false);
  readonly currentBranch = input('');
  readonly branches = input<readonly string[]>([]);
  readonly remoteBranches = input<readonly string[]>([]);
  readonly tags = input<readonly string[]>([]);
  /** Source preselected when the dialog opens (the clicked commit oid). */
  readonly defaultSource = input('');
  readonly running = input(false);
  readonly error = input<AppError | null>(null);
  /** The shared conflict state; only a `cherry-pick` conflict matters here. */
  readonly conflict = input<ConflictState | null>(null);
  /** Resolved source commit, or null while unresolved/blank. */
  readonly preview = input<Commit | null>(null);
  readonly previewLoading = input(false);
  readonly previewError = input<AppError | null>(null);

  readonly submitted = output<CherryPickValue>();
  /** Fired once per SETTLED source value (debounced ~250 ms). */
  readonly sourceChange = output<string>();
  readonly cancelled = output<void>();

  readonly source = signal('');
  readonly recordOrigin = signal(false);
  readonly noCommit = signal(false);
  /** Ref picked from the select, mirrored back so the control shows it. */
  readonly picked = signal('');
  /**
   * The last source value handed to the parent. Submit requires it to match the
   * field, so an un-debounced keystroke can never act on a stale preview.
   */
  private readonly settledSource = signal('');

  /** Local branches offered by the picker: the current branch is excluded. */
  readonly localOptions = computed(() =>
    this.branches().filter((branch) => branch !== this.currentBranch()),
  );
  readonly remoteOptions = computed(() => this.remoteBranches());
  readonly tagOptions = computed(() => this.tags());

  /** True once the current source has a resolved commit and no pending/failed resolve. */
  readonly resolved = computed(
    () => this.preview() !== null && !this.previewLoading() && this.previewError() === null,
  );

  readonly canSubmit = computed(
    () =>
      !this.running() &&
      this.source().trim().length > 0 &&
      this.source().trim() === this.settledSource() &&
      this.resolved(),
  );

  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // Re-seed on every open: default source (the clicked oid) or blank, both
    // flags off, and an IMMEDIATE preview request for a non-empty default.
    effect(() => {
      if (!this.open()) return;
      const seeded = this.defaultSource() ?? '';
      this.source.set(seeded);
      this.recordOrigin.set(false);
      this.noCommit.set(false);
      this.picked.set('');
      this.clearTimer();
      const trimmed = seeded.trim();
      this.settledSource.set(trimmed);
      if (trimmed) this.sourceChange.emit(seeded);
    });

    this.destroyRef.onDestroy(() => this.clearTimer());
  }

  onSourceInput(value: string): void {
    this.source.set(value);
    // A hand-typed revision is no longer the picked ref.
    this.picked.set('');
    this.scheduleSourceChange(value);
  }

  /** Writing a picked ref into the field and previewing it through the same debounce. */
  onPick(value: string): void {
    if (!value) return;
    this.source.set(value);
    this.picked.set(value);
    this.scheduleSourceChange(value);
  }

  onRecordOrigin(event: Event): void {
    this.recordOrigin.set((event.target as HTMLInputElement).checked);
  }

  onNoCommit(event: Event): void {
    this.noCommit.set((event.target as HTMLInputElement).checked);
  }

  submit(): void {
    if (!this.canSubmit()) return;
    this.submitted.emit({
      source: this.source().trim(),
      recordOrigin: this.recordOrigin(),
      noCommit: this.noCommit(),
    });
  }

  cancel(): void {
    this.clearTimer();
    this.cancelled.emit();
  }

  /** Short sha of the previewed commit. */
  shortSha(commit: Commit): string {
    return (commit.oid?.hex ?? '').slice(0, 7);
  }

  /** First line of the previewed commit message. */
  subject(commit: Commit): string {
    return (commit.message.split('\n')[0] ?? '').trim();
  }

  /**
   * Plain sentence for a failed preview. `ResolveRevision` is read-only, so the
   * only refusal the user can act on there is an unresolvable revision; anything
   * else falls back to the core's message.
   */
  previewErrorMessage(error: AppError): string {
    switch (error.code) {
      case 'COMMIT_NOT_FOUND':
        return $localize`No commit matches that revision.`;
      default:
        return error.message;
    }
  }

  /**
   * Localized sentence for a failed submit. The core publishes typed
   * `details.reason` tokens for its validation refusals and stable codes for the
   * rest, so resolve them in that order and only then fall back to the raw
   * message the core sent.
   */
  submitErrorMessage(error: AppError): string {
    const reason = error.details?.['reason'];
    switch (reason) {
      case 'invalid-source':
        return $localize`That revision cannot be used.`;
      case 'merge-commit':
        return $localize`Merge commits cannot be cherry-picked yet.`;
      case 'in-progress':
        return $localize`Another operation is in progress. Finish or abort it first.`;
      case 'empty':
        return $localize`That change is already applied, so nothing was picked.`;
      case 'overwrite-local-changes':
        return $localize`Local changes would be overwritten. Commit or stash them first.`;
    }

    switch (error.code) {
      case 'COMMIT_NOT_FOUND':
        return $localize`No commit matches that revision.`;
      case 'DETACHED_HEAD':
        return $localize`Cannot cherry-pick on a detached HEAD.`;
      default:
        return error.message;
    }
  }

  private scheduleSourceChange(value: string): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.settledSource.set(value.trim());
      this.sourceChange.emit(value);
    }, CherryPickDialog.SOURCE_DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
