import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type EmptyStateTone = 'neutral' | 'muted' | 'error';

/**
 * Dumb centered empty/placeholder block. Each part (icon, title, message) is
 * rendered only when its input is non-empty.
 */
@Component({
  selector: 'st-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="st-empty-state st-empty-state--{{ tone() }}" data-testid="empty-state">
      @if (icon()) {
        <span class="st-empty-state__icon" data-testid="empty-state-icon">{{ icon() }}</span>
      }
      @if (title()) {
        <span class="st-empty-state__title" data-testid="empty-state-title">{{ title() }}</span>
      }
      @if (message()) {
        <span class="st-empty-state__message" data-testid="empty-state-message">{{ message() }}</span>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .st-empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--st-space-1);
      width: 100%;
      padding: var(--st-space-4);
      font-size: var(--st-font-12);
      text-align: center;
      color: var(--st-color-text);
    }

    .st-empty-state--muted {
      opacity: 0.6;
    }

    .st-empty-state--error {
      color: var(--st-color-danger);
    }

    .st-empty-state__icon {
      font-size: 20px;
      line-height: 1;
    }

    .st-empty-state__title {
      font-weight: 600;
    }

    .st-empty-state__message {
      opacity: 0.7;
    }
  `,
})
export class EmptyStateComponent {
  readonly icon = input('');
  readonly title = input('');
  readonly message = input('');
  readonly tone = input<EmptyStateTone>('neutral');
}
