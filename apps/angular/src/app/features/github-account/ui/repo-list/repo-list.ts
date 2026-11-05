import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { GitHubRepo } from '@contracts/auth';
import type { AppError } from '@core/services/ipc-bridge.service';
import { ButtonComponent, EmptyStateComponent, RepoCardComponent } from '@singularitree/ui-kit';
import type { RepoCardView } from '@singularitree/ui-kit';
import { toRepoCardView } from '../../repo-card-view';

/**
 * Dumb GitHub repository list. Renders exactly one state, evaluated in order:
 * terminal error → offline → not authenticated → loading (first page) → empty →
 * populated list. A pagination error (error set with already-loaded repos) keeps
 * the list visible and renders an inline error line instead of the terminal state.
 * It only maps `GitHubRepo` payloads to `RepoCardView`; the parent owns loading.
 */
@Component({
  selector: 'st-repo-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, EmptyStateComponent, RepoCardComponent],
  template: `
    @if (error() && repos().length === 0) {
      <st-empty-state
        tone="error"
        title="Could not load repositories"
        [message]="error()!.message"
        data-testid="gh-repos-error"
      />
    } @else if (offline()) {
      <st-empty-state
        icon="🔌"
        title="Desktop app required"
        message="GitHub core offline — run inside the desktop app."
        data-testid="gh-repos-offline"
      />
    } @else if (!authenticated()) {
      <st-empty-state
        icon="🐙"
        title="Not connected"
        message="Connect a GitHub account to list its repositories."
        data-testid="gh-not-connected"
      />
    } @else if (loading() && repos().length === 0) {
      <st-empty-state title="Loading repositories…" data-testid="gh-repos-loading" />
    } @else if (repos().length === 0) {
      <st-empty-state
        icon="📭"
        title="No repositories"
        message="This account has no repositories."
        data-testid="gh-repos-empty"
      />
    } @else {
      <ul class="st-repo-list__repos" data-testid="gh-repos">
        @for (card of cards(); track card.id) {
          <li class="st-repo-list__item">
            <st-repo-card [repo]="card" />
          </li>
        }
      </ul>

      @if (error(); as failure) {
        <p class="st-repo-list__error" data-testid="gh-repos-error-inline">{{ failure.message }}</p>
      }

      @if (hasMore()) {
        <st-button
          data-testid="gh-load-more"
          [disabled]="loading()"
          (click)="loadMore.emit()"
        >
          Load more
        </st-button>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      color: var(--st-color-text);
    }

    .st-repo-list__repos {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      max-width: 640px;
    }

    .st-repo-list__item {
      display: block;
    }

    .st-repo-list__repos + st-button {
      margin-top: var(--st-space-2);
    }

    .st-repo-list__error {
      margin: var(--st-space-2) 0 0;
      font-size: var(--st-font-12);
      color: var(--st-color-danger);
    }
  `,
})
export class RepoList {
  readonly repos = input<readonly GitHubRepo[]>([]);
  readonly loading = input(false);
  readonly offline = input(false);
  readonly authenticated = input(false);
  readonly hasMore = input(false);
  readonly error = input<AppError | null>(null);

  readonly loadMore = output<void>();

  readonly cards = computed<RepoCardView[]>(() => this.repos().map(toRepoCardView));
}
