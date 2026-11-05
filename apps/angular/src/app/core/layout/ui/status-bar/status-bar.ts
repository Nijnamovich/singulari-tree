import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LiveRegionComponent, LiveRegionService } from '@singularitree/ui-kit';

/**
 * Dumb 31px shell status bar (plan §3/§4.8): a mono `repo · branch · short-hash`
 * context, the sync + online indicators, and the single polite live region.
 *
 * The parent supplies every segment; missing ones are omitted from the joined
 * label. The right zone is a content slot so the shell can mount the
 * per-repository fetch status next to the live region.
 */
@Component({
  selector: 'st-status-bar',
  standalone: true,
  imports: [LiveRegionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <footer class="st-statusbar">
      <div class="st-statusbar__zone st-statusbar__zone--left">
        @if (label(); as text) {
          <span class="st-statusbar__context st-mono" data-testid="status-bar-context">{{ text }}</span>
        }
      </div>

      <div class="st-statusbar__zone st-statusbar__zone--center">
        <span class="st-statusbar__sync st-mono st-tabular-nums" data-testid="status-bar-sync">
          @if (behind() > 0) {
            <span class="st-statusbar__behind" data-testid="status-bar-behind">↓{{ behind() }}</span>
          }
          @if (ahead() > 0) {
            <span class="st-statusbar__ahead" data-testid="status-bar-ahead">↑{{ ahead() }}</span>
          }
          @if (behind() === 0 && ahead() === 0) {
            <span class="st-statusbar__in-sync" data-testid="status-bar-in-sync" i18n>In sync</span>
          }
        </span>
        <span
          class="st-statusbar__dot"
          [class.st-statusbar__dot--offline]="offline()"
          data-testid="status-bar-online-dot"
          [attr.aria-label]="offline() ? offlineLabel : onlineLabel"
        ></span>
      </div>

      <div class="st-statusbar__zone st-statusbar__zone--right">
        <ng-content />
        <st-live-region [message]="liveRegion.message()" />
      </div>
    </footer>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
    }

    .st-statusbar {
      display: flex;
      align-items: center;
      height: var(--st-size-statusbar);
      background: var(--st-color-chrome);
      border-top: var(--st-hairline) solid var(--st-color-border);
      color: var(--st-color-muted);
      font-size: var(--st-font-11);
    }

    .st-statusbar__zone {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      height: 100%;
      padding: 0 var(--st-space-3);
      min-width: 0;
    }

    /* Hairline separators between zones. */
    .st-statusbar__zone--center {
      margin-left: auto;
      border-left: var(--st-hairline) solid var(--st-color-border);
    }

    .st-statusbar__zone--right {
      border-left: var(--st-hairline) solid var(--st-color-border);
      flex: none;
    }

    .st-statusbar__context {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .st-statusbar__behind,
    .st-statusbar__ahead {
      color: var(--st-color-warn);
    }

    .st-statusbar__dot {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: var(--st-radius-pill);
      background: var(--st-color-add);
    }

    .st-statusbar__dot--offline {
      background: var(--st-color-danger);
    }
  `,
})
export class StatusBar {
  readonly repo = input('');
  readonly branch = input('');
  /** Short HEAD oid. The shell passes '' until `RepoState` exposes one. */
  readonly shortHash = input('');
  /** Commits ahead of upstream; 0 when unknown. */
  readonly ahead = input(0);
  /** Commits behind upstream (pull-pending). */
  readonly behind = input(0);
  readonly offline = input(false);

  private readonly liveRegion = inject(LiveRegionService);

  readonly onlineLabel = $localize`Git core online`;
  readonly offlineLabel = $localize`Git core offline`;

  /** `repo · branch · shortHash`, omitting any segment the parent did not supply. */
  readonly label = computed<string>(() =>
    [this.repo(), this.branch(), this.shortHash()]
      .filter((segment) => segment.length > 0)
      .join(' · '),
  );
}
