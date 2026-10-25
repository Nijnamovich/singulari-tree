import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { AppError } from '@core/services/ipc-bridge.service';
import type { RepoFetchState } from '../../remote-models';

/**
 * Dumb status line for the renderer-orchestrated per-repository fetch (ADR-024).
 *
 * Compacted in P2 to a single line that renders inside the shell status-bar
 * live region next to the 31px bar. It now reports the ONE repository being
 * fetched. The title settles with the reported state (`Fetching repository`,
 * `Repository up to date` or `Fetch failed`); the name, the failed count, the
 * last error and the dismiss control stay beside it. The parent owns the store
 * state and the dismiss intent; the fake N/M fan-out aggregate is gone.
 */
@Component({
  selector: 'st-fetch-all-status',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="st-fetch-all" data-testid="fetch-all-status">
        <span class="st-fetch-all__title" data-testid="fetch-all-title">{{ title() }}</span>
        @if (repoName()) {
          <span class="st-fetch-all__name" data-testid="fetch-all-repo-name">{{ repoName() }}</span>
        }
        @if (failedCount() > 0) {
          <span class="st-fetch-all__failed st-tabular-nums" data-testid="fetch-all-failed">
            <span class="st-fetch-all__failed-icon" aria-hidden="true">✕</span>{{ failedCount() }}
          </span>
        }
        @if (error(); as err) {
          <span class="st-fetch-all__error" data-testid="fetch-all-error">{{ err.message }}</span>
        }
        <button
          type="button"
          class="st-fetch-all__dismiss"
          data-testid="fetch-all-dismiss"
          i18n
          (click)="dismissed.emit()"
        >
          Dismiss
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      /* Cap the repository name so the one-line status stays readable. */
      --st-fetch-status-name-max: 220px;
    }

    .st-fetch-all {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      min-width: 0;
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
    }

    .st-fetch-all__title {
      font-weight: 600;
      color: var(--st-color-text);
      white-space: nowrap;
    }

    .st-fetch-all__name {
      max-width: var(--st-fetch-status-name-max);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--st-color-text);
    }

    .st-fetch-all__failed {
      display: inline-flex;
      align-items: center;
      gap: var(--st-space-1);
      color: var(--st-color-remove);
    }

    .st-fetch-all__failed-icon {
      font-size: var(--st-font-11);
    }

    .st-fetch-all__error {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--st-color-danger);
    }

    .st-fetch-all__dismiss {
      margin-left: var(--st-space-2);
      padding: 1px 8px;
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: var(--st-font-11);
      cursor: pointer;
    }

    .st-fetch-all__dismiss:hover {
      color: var(--st-color-text);
    }
  `,
})
export class FetchAllStatus {
  /** Whether the line is visible (pending, or showing a settled fetch). */
  readonly open = input(false);
  /** Display name of the repository being fetched, or '' when unknown. */
  readonly repoName = input('');
  /** Per-repository status keyed by repo id (one repository at a time). */
  readonly status = input<Readonly<Record<string, RepoFetchState>>>({});
  /** Last fetch failure, or null. */
  readonly error = input<AppError | null>(null);

  readonly dismissed = output<void>();

  /** Number of repositories whose last fetch attempt failed. */
  readonly failedCount = computed<number>(
    () => Object.values(this.status()).filter((state) => state === 'failed').length,
  );

  private readonly fetchingLabel = $localize`Fetching repository`;
  private readonly upToDateLabel = $localize`Repository up to date`;
  private readonly failedLabel = $localize`Fetch failed`;

  /**
   * State of the reported repository. The store keeps at most one entry in the
   * map; the priority guards a transient mixed map without adding an input.
   */
  readonly state = computed<RepoFetchState | null>(() => {
    const states = Object.values(this.status());
    if (states.includes('pending')) return 'pending';
    if (states.includes('failed')) return 'failed';
    return states.includes('success') ? 'success' : null;
  });

  /** Title settles with the reported state instead of claiming a fetch forever. */
  readonly title = computed<string>(() => {
    switch (this.state()) {
      case 'success':
        return this.upToDateLabel;
      case 'failed':
        return this.failedLabel;
      default:
        return this.fetchingLabel;
    }
  });
}
