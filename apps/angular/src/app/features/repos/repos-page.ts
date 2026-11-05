import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { Repository } from '@contracts/domain';
import { IpcBridge, toAppError, type AppError } from '@core/services/ipc-bridge.service';
import { RepoState } from '@core/services/repo-state.service';
import { WorkspacesStore } from '@core/services/workspaces.store';
import {
  ButtonComponent,
  EmptyStateComponent,
  InputComponent,
  PanelComponent,
} from '@singularitree/ui-kit';

/**
 * Dedicated repository-list page: add, open and remove persisted repositories.
 *
 * Additive to the route-scoped graph: it owns no repository state itself and
 * delegates list/selection to the root `RepoState` plus the open/remove RPCs to
 * the `IpcBridge` (the renderer never talks to Git directly). Opening navigates
 * to `/repo` where the graph is provided.
 *
 * Presentation follows the P5 language (plan §4.10): the page lives in an
 * `st-panel`, the path field is a shared `st-input`, every action is an
 * `st-button`, and the loading/error/offline/empty states are `st-empty-state`.
 * Deviation: the rows are deliberately **not** `[stSelectableRow]` — each row
 * carries its own Open/Remove buttons, so making the row itself activatable
 * would double-fire the open action (the spec asserts `setActive` runs once).
 */
@Component({
  selector: 'st-repos-page',
  standalone: true,
  imports: [ButtonComponent, EmptyStateComponent, InputComponent, PanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-panel class="st-repos-page" data-testid="repos-page" aria-label="Repositories">
      <div header class="st-repos-page__head">
        <span class="st-eyebrow">Local repositories</span>
        <h1 class="st-repos-page__title">Repositories</h1>
      </div>

      <div class="st-repos-page__body">
        <div class="st-repos-page__add">
          <span class="st-repos-page__label">Repository path</span>
          <st-input
            [testId]="'repos-add-input'"
            placeholder="/path/to/repository"
            ariaLabel="Repository filesystem path"
            [value]="path()"
            (valueChange)="onInput($event)"
            (keydown.enter)="add()"
          />
          <st-button
            data-testid="repos-browse"
            [disabled]="browsing()"
            (click)="browse()"
          >
            Browse…
          </st-button>
          <st-button
            data-testid="repos-add"
            [disabled]="!path().trim() || adding()"
            (click)="add()"
          >
            Add repository
          </st-button>
        </div>

        @if (repoState.reposLoading() && repoState.repos().length === 0) {
          <st-empty-state data-testid="repos-loading" title="Loading repositories…" tone="muted" />
        } @else if (error(); as err) {
          <st-empty-state data-testid="repos-error" tone="error" [message]="err.message" />
        } @else if (offline()) {
          <st-empty-state
            data-testid="repos-offline"
            tone="muted"
            message="Git core offline — manage repositories inside the desktop app."
          />
        } @else if (repoState.repos().length === 0) {
          <st-empty-state
            data-testid="repos-empty"
            tone="muted"
            message="No repositories yet. Add one to get started."
          />
        } @else {
          <ul class="st-repos-page__list">
            @for (repo of repoState.repos(); track repo.id) {
              <li class="st-repos-page__row" data-testid="repos-row">
                <span class="st-repos-page__name">{{ repo.name }}</span>
                <span class="st-repos-page__path">{{ repo.fsPath }}</span>
                <st-button size="sm" data-testid="repos-open" (click)="open(repo)">
                  Open
                </st-button>
                <st-button
                  variant="danger"
                  size="sm"
                  data-testid="repos-remove"
                  [disabled]="isRemoving(repo.id)"
                  (click)="remove(repo.id)"
                >
                  Remove
                </st-button>
              </li>
            }
          </ul>
        }
      </div>
    </st-panel>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      overflow: auto;
      color: var(--st-color-text);
    }

    .st-repos-page {
      margin: var(--st-space-4);
    }

    .st-repos-page__head {
      display: flex;
      flex-direction: column;
      /* Eyebrow over title: leading alone separates the two lines. */
      gap: 0;
      min-width: 0;
    }

    .st-repos-page__title {
      margin: 0;
      font-size: var(--st-font-13);
      font-weight: 600;
      line-height: var(--st-leading-tight);
    }

    .st-repos-page__body {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-3);
      padding: var(--st-space-3);
    }

    .st-repos-page__add {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
    }

    .st-repos-page__label {
      font-size: var(--st-font-12);
      font-weight: 600;
      white-space: nowrap;
    }

    .st-repos-page__add st-input {
      flex: 1 1 auto;
      min-width: 120px;
    }

    .st-repos-page__list {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .st-repos-page__row {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      height: var(--st-size-row-tree);
      padding: 0 var(--st-space-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: var(--st-color-surface);
      color: var(--st-color-text);
    }

    .st-repos-page__name {
      font-size: var(--st-font-13);
      font-weight: 600;
      white-space: nowrap;
    }

    .st-repos-page__path {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--st-font-mono);
      font-size: var(--st-font-11);
      color: var(--st-color-muted);
    }
  `,
})
export class ReposPage implements OnInit {
  readonly repoState = inject(RepoState);
  private readonly workspaces = inject(WorkspacesStore);
  private readonly bridge = inject(IpcBridge);
  private readonly router = inject(Router);

  /** Path typed by the user; trimmed before opening. */
  readonly path = signal('');
  /** True while an `openRepository` add is in flight. */
  readonly adding = signal(false);
  /** True while the native folder dialog is open. */
  readonly browsing = signal(false);
  /** Last add failure (non-offline). */
  readonly addError = signal<AppError | null>(null);
  /** True when add failed because the Electron bridge is absent. */
  readonly addOffline = signal(false);
  /** Last Browse failure (non-IPC). */
  readonly browseError = signal<AppError | null>(null);

  /** A local add/browse error takes precedence over the list-load error. */
  readonly error = computed<AppError | null>(
    () => this.addError() ?? this.browseError() ?? this.repoState.reposError(),
  );
  /** The page is offline when either the list or the last add could not reach the core. */
  readonly offline = computed(() => this.repoState.reposOffline() || this.addOffline());

  ngOnInit(): void {
    // Refresh the persisted list so the page is self-sufficient when deep-linked.
    void this.repoState.loadRepositories();
  }

  /** Template entry point for the `st-input` primitive's `valueChange` output. */
  onInput(value: string): void {
    this.path.set(value);
  }

  /**
   * Open the native folder picker and adopt the chosen path (enables Add).
   *
   * Degrades gracefully when the bridge is absent or the dialog fails: the
   * typed state is left untouched. `IPC_UNAVAILABLE` is silent (matching the
   * toolbar's offline behavior); any other failure is surfaced as a
   * non-fatal error while keeping the typed state unchanged.
   */
  async browse(): Promise<void> {
    if (this.browsing()) return;
    this.browsing.set(true);
    this.browseError.set(null);
    try {
      const res = await this.bridge.invoke('chooseDirectory', {});
      if (!res.canceled && res.path) this.path.set(res.path);
    } catch (err) {
      const appError = toAppError(err);
      if (appError.code !== 'IPC_UNAVAILABLE') {
        this.browseError.set(appError);
      }
    } finally {
      this.browsing.set(false);
    }
  }

  /** True while `id` is being removed (drives the per-row disabled state). */
  isRemoving(id: string): boolean {
    return this.repoState.removingId() === id;
  }

  /** Register `repo` as a tab, activate it and route to the graph page. */
  open(repo: Repository): void {
    this.workspaces.openTab(repo);
    this.repoState.setActive(repo);
    void this.router.navigate(['/repo']);
  }

  /** Open the typed path, register it as a tab, activate it and route to the graph. */
  async add(): Promise<void> {
    const fsPath = this.path().trim();
    if (!fsPath) return;

    this.addError.set(null);
    this.addOffline.set(false);
    this.adding.set(true);
    try {
      const repo = await this.bridge.invoke('openRepository', { fsPath });
      this.workspaces.openTab(repo);
      this.repoState.setActive(repo);
      void this.router.navigate(['/repo']);
    } catch (err) {
      const appError = toAppError(err);
      if (appError.code === 'IPC_UNAVAILABLE') {
        this.addOffline.set(true);
      } else {
        this.addError.set(appError);
      }
    } finally {
      this.adding.set(false);
    }
  }

  /** Remove a repository; the page stays open even when the active one is removed. */
  async remove(id: string): Promise<void> {
    await this.repoState.removeRepository(id);
  }
}
