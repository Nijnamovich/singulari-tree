import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import type { AuthSource } from '@contracts/auth';
import { ButtonComponent } from '@singularitree/ui-kit';
import { GithubAccountStore } from './github-account.store';
import { AccountProfile } from './ui/account-profile/account-profile';
import { RepoList } from './ui/repo-list/repo-list';

/** Human label for the token source (never shown when unauthenticated). */
const SOURCE_LABELS: Record<AuthSource, string> = {
  0: 'unknown',
  1: 'none',
  2: 'gh CLI',
  3: 'OAuth',
  [-1]: 'unknown',
};

/**
 * GitHub account feature page. Account linking + repository listing are served
 * entirely through `GithubAccountStore` (`auth:*` IPC); this container composes
 * the dumb `st-account-profile` / `st-repo-list` views and never talks to GitHub.
 */
@Component({
  selector: 'st-github-account',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, AccountProfile, RepoList],
  template: `
    <section class="st-gh-account">
      <header class="st-gh-account__header">
        <h1 class="st-gh-account__title">GitHub account</h1>
        <st-button data-testid="gh-connect" [disabled]="store.loading()" (click)="connect()">
          {{ store.authenticated() ? 'Reconnect' : 'Connect GitHub' }}
        </st-button>
        @if (store.authenticated()) {
          <st-button
            variant="ghost"
            data-testid="gh-logout"
            [disabled]="store.loading()"
            (click)="logout()"
          >
            Logout
          </st-button>
        }
        @if (store.loading()) {
          <span class="st-gh-account__status" data-testid="gh-loading">Loading…</span>
        }
        @if (store.offline()) {
          <span class="st-gh-account__status" data-testid="gh-offline">
            GitHub core offline — run inside the desktop app.
          </span>
        }
      </header>

      @if (store.error(); as error) {
        <p class="st-gh-account__error" data-testid="gh-error">{{ error.message }}</p>
      }

      <st-account-profile
        [status]="store.status() ?? null"
        [sourceLabel]="sourceLabel($safeNavigationMigration(store.status()?.source))"
      />

      @if (rateLimit(); as limit) {
        <p class="st-gh-account__rate" data-testid="gh-rate-limit">
          Rate limit ({{ limit.resource || 'core' }}): {{ limit.remaining }}/{{ limit.limit }}
        </p>
      }

      <h2 class="st-gh-account__subtitle">Repositories</h2>
      <st-repo-list
        [repos]="store.repos()"
        [loading]="store.loading()"
        [offline]="store.offline()"
        [authenticated]="store.authenticated()"
        [hasMore]="store.hasMore()"
        [error]="store.error()"
        (loadMore)="loadMore()"
      />
    </section>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      overflow: auto;
      padding: var(--st-space-4);
      color: var(--st-color-text);
    }

    .st-gh-account__header {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      flex-wrap: wrap;
    }

    .st-gh-account__title {
      margin: 0;
      font-size: var(--st-font-22);
      font-weight: 600;
      line-height: var(--st-leading-tight);
    }

    .st-gh-account__subtitle {
      margin: var(--st-space-4) 0 var(--st-space-2);
      font-size: var(--st-font-13);
      font-weight: 600;
    }

    .st-gh-account__status {
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
    }

    .st-gh-account__error {
      margin: var(--st-space-2) 0 0;
      font-size: var(--st-font-12);
      color: var(--st-color-danger);
    }

    .st-gh-account__rate {
      margin: var(--st-space-2) 0 0;
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
    }
  `,
})
export class GithubAccount implements OnInit {
  readonly store = inject(GithubAccountStore);

  /** Prefer the list-response rate limit, fall back to the one on the status. */
  readonly rateLimit = computed(() => this.store.rateLimit() ?? this.store.status()?.rateLimit);

  async ngOnInit(): Promise<void> {
    await this.store.refreshStatus();
    if (this.store.authenticated()) {
      await this.store.loadRepos();
    }
  }

  async connect(): Promise<void> {
    await this.store.connect();
    if (this.store.authenticated()) {
      await this.store.loadRepos();
    }
  }

  async loadMore(): Promise<void> {
    await this.store.loadMore();
  }

  async logout(): Promise<void> {
    await this.store.logout();
  }

  sourceLabel(source: AuthSource | undefined): string {
    if (source === undefined) return 'unknown';
    return SOURCE_LABELS[source] ?? 'unknown';
  }
}
