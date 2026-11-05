import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { AuthStatus } from '@contracts/auth';
import { BadgeComponent, EmptyStateComponent } from '@singularitree/ui-kit';

/**
 * Dumb GitHub account profile. Renders the signed-in identity (avatar, login,
 * source badge, name, email) or an empty state when there is no status. It holds
 * no services and never talks to the backend.
 */
@Component({
  selector: 'st-account-profile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponent, EmptyStateComponent],
  template: `
    @if (status(); as account) {
      <div class="st-account-profile__profile" data-testid="gh-profile">
        @if (account.avatarUrl) {
          <img
            class="st-account-profile__avatar"
            [src]="account.avatarUrl"
            [alt]="account.accountLogin"
          />
        }
        <div class="st-account-profile__identity">
          <p class="st-account-profile__login">
            {{ account.accountLogin || 'Not connected' }}
            <st-badge variant="neutral">{{ sourceLabel() }}</st-badge>
          </p>
          @if (account.name) {
            <p class="st-account-profile__name">{{ account.name }}</p>
          }
          <p class="st-account-profile__email" data-testid="gh-email">
            {{ account.email || 'no disponible' }}
          </p>
        </div>
      </div>
    } @else {
      <st-empty-state
        title="Not connected"
        message="Connect a GitHub account to see its profile."
      />
    }
  `,
  styles: `
    :host {
      display: block;
      color: var(--st-color-text);
    }

    .st-account-profile__profile {
      display: flex;
      align-items: center;
      gap: var(--st-space-3);
      margin-top: var(--st-space-3);
    }

    .st-account-profile__avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
    }

    .st-account-profile__identity p {
      margin: 0;
    }

    .st-account-profile__login {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      font-size: var(--st-font-13);
      font-weight: 600;
    }

    .st-account-profile__name,
    .st-account-profile__email {
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
    }
  `,
})
export class AccountProfile {
  readonly status = input<AuthStatus | null>(null);
  readonly sourceLabel = input('');
}
