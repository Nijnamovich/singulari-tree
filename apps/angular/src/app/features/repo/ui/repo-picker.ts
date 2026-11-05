import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ButtonComponent, EmptyStateComponent } from '@singularitree/ui-kit';
import { RepoState } from '@core/services/repo-state.service';
import { WorkspacesStore } from '@core/services/workspaces.store';
import { GraphStore } from '../graph/graph.store';

/**
 * First-run empty state for the History pane (plan §4.5/§4.7): an empty-state
 * block, a filesystem-path input plus a recent-repositories list.
 *
 * `repo-page` renders it as the primary-pane fallback whenever no repository is
 * open. Presentation-light wrapper over `GraphStore`: it owns only the typed path
 * and delegates every IPC action to the store. On init it asks the store for the
 * recents.
 */
@Component({
  selector: 'st-repo-picker',
  standalone: true,
  imports: [ButtonComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="st-repo-picker" aria-label="Repository picker" i18n-aria-label>
      <header class="st-repo-picker__intro">
        <span class="st-repo-picker__eyebrow" i18n>History</span>
        <st-empty-state
          icon="📁"
          [title]="messages.title"
          [message]="messages.message"
        />
      </header>

      <div class="st-repo-picker__form">
        <label class="st-repo-picker__label" for="repo-path-input" i18n>Repository path</label>
        <input
          id="repo-path-input"
          type="text"
          class="st-repo-picker__input"
          placeholder="/path/to/repository"
          i18n-placeholder
          aria-label="Repository filesystem path"
          i18n-aria-label
          data-testid="repo-path-input"
          [value]="path()"
          (input)="onInput($event)"
          (keydown.enter)="open()"
        />
        <st-button
          variant="primary"
          data-testid="repo-open"
          [disabled]="!path().trim()"
          (click)="open()"
          i18n
          >Open</st-button
        >
      </div>

      @if (store.error(); as error) {
        <p class="st-repo-picker__error" data-testid="repo-picker-error">{{ error.message }}</p>
      }
      @if (store.offline()) {
        <p class="st-repo-picker__status" data-testid="repo-picker-offline" i18n>
          Git core offline — open a repository inside the desktop app.
        </p>
      }

      <div class="st-repo-picker__recents">
        <h2 class="st-repo-picker__recents-title" i18n>Recent repositories</h2>
        @if (store.recentRepos().length === 0) {
          <p class="st-repo-picker__empty" data-testid="repo-recent-empty" i18n>
            No recent repositories yet.
          </p>
        } @else {
          <ul class="st-repo-picker__list" data-testid="repo-recent">
            @for (repo of store.recentRepos(); track repo.id) {
              <li>
                <button
                  type="button"
                  class="st-repo-picker__recent"
                  data-testid="repo-recent-item"
                  [title]="repo.fsPath"
                  (click)="openPath(repo.fsPath)"
                >
                  {{ repo.name }}
                </button>
              </li>
            }
          </ul>
        }
      </div>
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

    .st-repo-picker {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-4);
      max-width: 520px;
      margin: 0 auto;
      padding: var(--st-space-6) var(--st-space-4);
    }

    .st-repo-picker__intro {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-2);
    }

    .st-repo-picker__eyebrow {
      font-size: var(--st-font-11);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--st-color-muted);
    }

    .st-repo-picker__form {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
    }

    .st-repo-picker__label {
      font-size: var(--st-font-12);
      font-weight: 600;
      color: var(--st-color-muted);
      white-space: nowrap;
    }

    .st-repo-picker__input {
      flex: 1 1 auto;
      min-width: 120px;
      height: var(--st-size-control-md);
      padding: 0 var(--st-space-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: var(--st-color-surface-2);
      color: var(--st-color-text);
      font-family: var(--st-font-ui);
      font-size: var(--st-font-12);
      outline: none;
    }

    .st-repo-picker__input:focus-visible {
      border-color: var(--st-color-accent);
    }

    .st-repo-picker__recents-title {
      margin: 0 0 var(--st-space-2);
      font-size: var(--st-font-11);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--st-color-muted);
    }

    .st-repo-picker__list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--st-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .st-repo-picker__recent {
      padding: var(--st-space-1) var(--st-space-2);
      border-radius: var(--st-radius-pill);
      border: var(--st-hairline) solid var(--st-color-border);
      background: var(--st-color-surface-2);
      color: var(--st-color-text);
      font: inherit;
      cursor: pointer;
    }

    .st-repo-picker__recent:hover {
      border-color: var(--st-color-accent);
    }

    .st-repo-picker__empty,
    .st-repo-picker__status {
      margin: 0;
      color: var(--st-color-muted);
    }

    .st-repo-picker__error {
      margin: 0;
      color: var(--st-color-danger);
    }
  `,
})
export class RepoPicker {
  readonly store = inject(GraphStore);
  readonly repoState = inject(RepoState);
  private readonly workspaces = inject(WorkspacesStore);

  /** Localizable strings bound to the empty-state inputs. */
  readonly messages = {
    title: $localize`Open a repository`,
    message: $localize`Pick a recent repository or paste a filesystem path to load its commit history.`,
  };

  /** Path typed by the user; trimmed before opening. */
  readonly path = signal('');

  constructor() {
    void this.store.loadRecentRepos();
  }

  onInput(event: Event): void {
    this.path.set((event.target as HTMLInputElement).value);
  }

  /** Open the currently typed path (no-op for empty/whitespace). */
  async open(): Promise<void> {
    const value = this.path().trim();
    if (!value) return;
    const repo = await this.store.openRepository(value);
    if (repo) {
      this.workspaces.openTab(repo);
      this.repoState.setActive(repo);
    }
  }

  /** Open a repository picked from the recents list. */
  openPath(fsPath: string): void {
    void this.store.openRepository(fsPath).then((repo) => {
      if (repo) {
        this.workspaces.openTab(repo);
        this.repoState.setActive(repo);
      }
    });
  }
}
