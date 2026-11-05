import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { Repository } from '@contracts/domain';
import { IpcBridge, toAppError, type AppError } from '@core/services/ipc-bridge.service';
import { RepoState } from '@core/services/repo-state.service';
import { ButtonComponent } from '@singularitree/ui-kit';

/** Why the recorded folder could not be opened (mirrors `GraphStore.error().code`). */
export type RelocateReason = 'missing' | 'not-a-repo';

/**
 * Recovery panel for a registered repository whose folder was moved, renamed or
 * deleted (P4.1 polish). The History pane shows it instead of the picker when
 * `GraphStore.openRepository` fails with `REPO_PATH_MISSING` / `NOT_A_GIT_REPO`.
 *
 * It drives three recoveries:
 * - **Relocate** (edit the path or pick a folder): reuses the single shared
 *   `RepoState.relocateRepository`, which repoints the *same* id (never a new
 *   registration) so the cached rows survive.
 * - **Remove repository**: an explicit, `confirm()`-gated action. This is the
 *   operator's stated fallback and the *only* way the registration is dropped —
 *   the app never silently deletes it just because the folder vanished.
 *
 * It injects `IpcBridge` only for the native folder chooser (a shell concern,
 * precedent: `repos-page.ts`) and `RepoState` for the mutations themselves.
 */
@Component({
  selector: 'st-repo-relocate-panel',
  standalone: true,
  imports: [ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="st-relocate" aria-label="Repository not found" i18n-aria-label>
      <h2 class="st-relocate__name" data-testid="relocate-name">{{ repo().name }}</h2>
      <p class="st-relocate__path" data-testid="relocate-path">{{ repo().fsPath }}</p>
      <p class="st-relocate__reason" data-testid="relocate-reason">{{ reasonText() }}</p>

      @if (editing()) {
        <div class="st-relocate__edit">
          <input
            type="text"
            class="st-relocate__input"
            placeholder="/path/to/repository"
            i18n-placeholder
            aria-label="Repository filesystem path"
            i18n-aria-label
            data-testid="relocate-path-input"
            [value]="draft()"
            [disabled]="disabled()"
            (input)="onInput($event)"
            (keydown.enter)="save()"
          />
          <st-button
            variant="primary"
            size="sm"
            data-testid="relocate-save"
            [disabled]="!canSave()"
            (click)="save()"
            i18n
            >Save</st-button
          >
          <st-button
            variant="ghost"
            size="sm"
            data-testid="relocate-cancel"
            [disabled]="disabled()"
            (click)="cancelEdit()"
            i18n
            >Cancel</st-button
          >
        </div>
      } @else {
        <st-button
          variant="ghost"
          size="sm"
          data-testid="relocate-edit"
          [disabled]="disabled()"
          (click)="startEdit()"
          i18n
          >Edit path</st-button
        >
      }

      <div class="st-relocate__actions">
        <st-button
          variant="default"
          size="sm"
          data-testid="relocate-browse"
          [disabled]="disabled()"
          (click)="browse()"
          i18n
          >Choose folder…</st-button
        >
        <st-button
          variant="danger"
          size="sm"
          data-testid="relocate-remove"
          [disabled]="disabled()"
          (click)="remove()"
          i18n
          >Remove repository</st-button
        >
      </div>

      @if (error(); as err) {
        <p class="st-relocate__error" data-testid="relocate-error">{{ err.message }}</p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      color: var(--st-color-text);
      font-size: var(--st-font-12);
    }

    .st-relocate {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-3);
      max-width: 520px;
      margin: 0 auto;
      padding: var(--st-space-6) var(--st-space-4);
    }

    .st-relocate__name {
      margin: 0;
      font-size: var(--st-font-13);
      font-weight: 600;
    }

    /* The recorded path is diagnostic: mono + muted + wrapping so a deep path is
       never truncated into something the user cannot recognise. */
    .st-relocate__path {
      margin: 0;
      font-family: var(--st-font-mono);
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
      word-break: break-all;
    }

    .st-relocate__reason {
      margin: 0;
      color: var(--st-color-text);
    }

    .st-relocate__edit {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
    }

    .st-relocate__input {
      flex: 1 1 auto;
      min-width: 120px;
      height: var(--st-size-control-md);
      padding: 0 var(--st-space-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: var(--st-color-surface-2);
      color: var(--st-color-text);
      font-family: var(--st-font-mono);
      font-size: var(--st-font-12);
      outline: none;
    }

    .st-relocate__input:focus-visible {
      border-color: var(--st-color-accent);
    }

    .st-relocate__actions {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
    }

    .st-relocate__error {
      margin: 0;
      color: var(--st-color-danger);
    }
  `,
})
export class RepoRelocatePanel {
  private readonly repoState = inject(RepoState);
  private readonly bridge = inject(IpcBridge);

  readonly repo = input.required<Repository>();
  readonly reason = input.required<RelocateReason>();
  /** Disables every control while the owning page reopens the graph. */
  readonly busy = input(false);

  readonly relocated = output<Repository>();
  readonly removed = output<void>();

  /** Edit-mode disclosure; the input is hidden until the user asks for it. */
  readonly editing = signal(false);
  /** Draft path being edited (prefilled from the recorded path). */
  readonly draft = signal('');
  /** Local failure of a relocate/remove (mirrors the store error verbatim). */
  readonly error = signal<AppError | null>(null);
  /** True while the native folder dialog is open. */
  readonly choosing = signal(false);
  /** True while a relocate/remove call is in flight. */
  readonly working = signal(false);

  /** Every control is inert while busy, browsing or mutating. */
  readonly disabled = computed(() => this.busy() || this.choosing() || this.working());
  /** Save needs a non-blank draft and an idle panel. */
  readonly canSave = computed(() => this.draft().trim().length > 0 && !this.disabled());

  /** Named, per-reason state line — the user must see *why* the folder failed. */
  readonly reasonText = computed(() =>
    this.reason() === 'not-a-repo'
      ? $localize`The folder recorded for this repository is not a Git repository.`
      : $localize`The folder recorded for this repository could not be found.`,
  );

  onInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  startEdit(): void {
    if (this.disabled()) return;
    this.draft.set(this.repo().fsPath);
    this.error.set(null);
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.error.set(null);
  }

  /** Save the edited path as the repository's new location. */
  save(): void {
    const fsPath = this.draft().trim();
    if (!fsPath || this.disabled()) return;
    void this.relocate(fsPath);
  }

  /**
   * Open the native folder chooser and adopt the chosen path. A cancelled or
   * empty result is ignored (never treated as a blank relocation).
   */
  async browse(): Promise<void> {
    if (this.disabled()) return;
    this.choosing.set(true);
    this.error.set(null);
    try {
      const res = await this.bridge.invoke('chooseDirectory', {});
      if (res.canceled || !res.path) return;
      await this.relocate(res.path);
    } catch (err) {
      const appError = toAppError(err);
      // A missing bridge is already surfaced structurally (the store sets
      // `reposOffline`); anything else is a real chooser failure worth naming.
      if (appError.code !== 'IPC_UNAVAILABLE') this.error.set(appError);
    } finally {
      this.choosing.set(false);
    }
  }

  private async relocate(fsPath: string): Promise<void> {
    this.working.set(true);
    this.error.set(null);
    try {
      const repo = await this.repoState.relocateRepository(this.repo().id, fsPath);
      if (!repo) {
        // Never swallow the reason (REPO_PATH_IN_USE, NOT_A_GIT_REPO, …): the
        // store records it on `reposError`, and the user must see it.
        this.surfaceStoreError();
        return;
      }
      this.editing.set(false);
      this.relocated.emit(repo);
    } finally {
      this.working.set(false);
    }
  }

  /**
   * Remove the repository registration. Explicit and `confirm()`-gated — the
   * folder on disk is never touched, and the registration is only dropped
   * because the user asked for it (never silently on a failed open).
   */
  remove(): void {
    if (this.disabled()) return;
    if (!confirmRemoveRepository(this.repo().name)) return;
    void this.doRemove();
  }

  private async doRemove(): Promise<void> {
    this.working.set(true);
    this.error.set(null);
    try {
      const ok = await this.repoState.removeRepository(this.repo().id);
      if (!ok) {
        this.surfaceStoreError();
        return;
      }
      this.removed.emit();
    } finally {
      this.working.set(false);
    }
  }

  /** Copy the store's recorded failure (or offline state) into the error line. */
  private surfaceStoreError(): void {
    const stored = this.repoState.reposError();
    if (stored) {
      this.error.set(stored);
      return;
    }
    this.error.set({
      code: 'IPC_UNAVAILABLE',
      message: $localize`Git core offline — the repository could not be updated.`,
    });
  }
}

/**
 * Confirm dropping a repository registration. Stubbable in tests (mirrors
 * `confirmFileDiscard` in `changes-panel.ts`). The folder itself is untouched.
 */
function confirmRemoveRepository(name: string): boolean {
  return typeof confirm === 'function'
    ? confirm(
        $localize`Remove the repository "${name}" from SingulariTree? The folder is left untouched.`,
      )
    : true;
}
