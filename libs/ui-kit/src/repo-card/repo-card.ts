import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { BadgeComponent } from '../badge/badge';

export interface RepoCardView {
  id: string;
  name: string;
  subtitle?: string;
  badge?: string;
}

/**
 * Dumb repository card: icon + name (+ optional badge) + optional subtitle.
 * Emits `picked` on click or keyboard Enter; the parent owns navigation.
 */
@Component({
  selector: 'st-repo-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponent],
  host: {
    class: 'st-repo-card',
    role: 'button',
    tabindex: '0',
    'data-testid': 'repo-card',
    '[class.st-repo-card--selected]': 'selected()',
    '(click)': 'picked.emit()',
    '(keydown.enter)': 'picked.emit()',
    '(keydown.space)': 'onSpace($event)',
  },
  template: `
    <span class="st-repo-card__icon" aria-hidden="true">📁</span>
    <span class="st-repo-card__body">
      <span class="st-repo-card__title-row">
        <span class="st-repo-card__name" data-testid="repo-card-name">{{ repo().name }}</span>
        @if (repo().badge) {
          <st-badge variant="branch" data-testid="repo-card-badge">{{ repo().badge }}</st-badge>
        }
      </span>
      @if (repo().subtitle) {
        <span class="st-repo-card__subtitle" data-testid="repo-card-subtitle">{{
          repo().subtitle
        }}</span>
      }
    </span>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      padding: 8px 10px;
      border: 1px solid var(--st-color-border);
      border-radius: var(--st-radius-4);
      background: var(--st-color-surface);
      color: var(--st-color-text);
      cursor: pointer;
      font-size: 12px;
    }

    :host(:hover) {
      border-color: var(--st-color-accent);
    }

    :host:focus-visible {
      outline: 1px solid var(--st-color-focus);
      outline-offset: -1px;
    }

    :host(.st-repo-card--selected) {
      border-color: var(--st-color-accent);
      background: color-mix(in srgb, var(--st-color-accent) 18%, var(--st-color-surface));
    }

    .st-repo-card__icon {
      flex: none;
      font-size: 16px;
      line-height: 1;
    }

    .st-repo-card__body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .st-repo-card__title-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .st-repo-card__name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .st-repo-card__subtitle {
      font-size: var(--st-font-11);
      opacity: 0.6;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
export class RepoCardComponent {
  readonly repo = input.required<RepoCardView>();
  readonly selected = input(false);
  readonly picked = output<void>();

  onSpace(event: Event): void {
    event.preventDefault();
    this.picked.emit();
  }
}
