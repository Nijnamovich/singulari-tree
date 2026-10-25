import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  ButtonComponent,
  EmptyStateComponent,
  IconComponent,
  InputComponent,
  PopoverComponent,
  RepoCardComponent,
  type RepoCardView,
} from '@singularitree/ui-kit';
import type { AppError } from '@core/services/ipc-bridge.service';

/**
 * Dumb repository drawer (plan §4.7): local repository list with search, a
 * pin/unpin toggle (replacing the old close control) and an "add" affordance.
 *
 * Pinned = docked inline at `--st-size-drawer` with a left hairline. Unpinned +
 * `open` = a floating 280px popover at every width (Escape / outside-click /
 * focus-out close it). Data is supplied by the shell from the LOCAL `RepoState`;
 * the component only filters locally and emits selection / add intents.
 */
@Component({
  selector: 'st-repo-drawer',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    ButtonComponent,
    EmptyStateComponent,
    IconComponent,
    InputComponent,
    PopoverComponent,
    RepoCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'st-drawer-host',
    'data-testid': 'repo-drawer',
    '[class.st-drawer-host--pinned]': 'pinned()',
    '[class.st-drawer-host--floating]': '!pinned() && open()',
  },
  template: `
    @if (pinned()) {
      <div class="st-drawer st-drawer--pinned">
        <ng-container [ngTemplateOutlet]="body" />
      </div>
    } @else if (open()) {
      <div class="st-drawer__anchor">
        <st-popover [open]="open()" (closed)="closed.emit()">
          <div class="st-drawer st-drawer--floating">
            <ng-container [ngTemplateOutlet]="body" />
          </div>
        </st-popover>
      </div>
    }

    <ng-template #body>
      <div class="st-drawer__head">
        <span class="st-drawer__title" i18n>Local repositories</span>
        <span class="st-drawer__spacer"></span>
        <st-button
          variant="icon"
          size="sm"
          data-testid="repo-drawer-pin"
          [attr.aria-pressed]="pinned()"
          [attr.title]="pinned() ? unpinTitle : pinTitle"
          (click)="pinToggled.emit()"
        >
          <st-icon [name]="pinned() ? 'pin' : 'pin-off'" />
          <span class="st-drawer__sr">{{ pinned() ? unpinTitle : pinTitle }}</span>
        </st-button>
      </div>
      <div class="st-drawer__search">
        <st-input
          type="search"
          data-testid="repo-drawer-search"
          [value]="search()"
          [placeholder]="messages.searchPlaceholder"
          [ariaLabel]="messages.searchPlaceholder"
          (valueChange)="search.set($event)"
        />
      </div>
      <div class="st-drawer__list">
        @if (loading() && repos().length === 0) {
          <st-empty-state [title]="messages.loadingRepos" data-testid="repo-drawer-loading" />
        } @else if (error(); as err) {
          <st-empty-state tone="error" [message]="err.message" data-testid="repo-drawer-error" />
        } @else if (offline()) {
          <st-empty-state
            icon="🔌"
            [title]="messages.desktopRequired"
            [message]="messages.offlineMessage"
            data-testid="repo-drawer-offline"
          />
        } @else if (filteredRepos().length === 0) {
          @if (search().trim() === '') {
            <st-empty-state
              icon="📭"
              [title]="messages.noRepos"
              [message]="messages.noReposMessage"
              data-testid="repo-drawer-no-repos"
            />
          } @else {
            <st-empty-state [title]="messages.noMatches" data-testid="repo-drawer-no-matches" />
          }
        } @else {
          <div data-testid="repo-drawer-list">
            @for (repo of filteredRepos(); track repo.id) {
              <div class="st-drawer__row" data-testid="repo-drawer-row">
                <st-repo-card
                  [repo]="repo"
                  [selected]="selectedId() === repo.id"
                  (picked)="select(repo.id)"
                />
                <button
                  class="st-drawer__remove"
                  type="button"
                  data-testid="repo-drawer-remove"
                  title="Remove repository"
                  i18n-title
                  [attr.aria-label]="removeAriaLabel(repo)"
                  [disabled]="removingId() === repo.id"
                  (click)="onRemove($event, repo.id)"
                >
                  🗑
                </button>
              </div>
            }
          </div>
        }
        <button class="st-right__add" type="button" (click)="addRequested.emit()" i18n>
          + Add repository
        </button>
      </div>
    </ng-template>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: var(--st-color-surface);
      color: var(--st-color-text);
    }

    :host(.st-drawer-host--pinned) {
      position: relative;
      width: var(--st-size-drawer);
      border-left: var(--st-hairline) solid var(--st-color-border);
      overflow: hidden;
    }

    /* Unpinned + open: a floating panel anchored to the right edge, at all widths. */
    :host(.st-drawer-host--floating) {
      position: fixed;
      top: var(--st-size-topbar);
      right: 0;
      bottom: var(--st-size-statusbar);
      width: 0;
      z-index: var(--st-z-drawer);
      background: transparent;
    }

    .st-drawer__anchor {
      position: static;
    }

    :host(.st-drawer-host--floating) ::ng-deep .st-popover {
      top: 0;
      right: 0;
      min-width: 0;
      width: 280px;
    }

    .st-drawer {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .st-drawer--pinned {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .st-drawer--floating {
      background: var(--st-color-raised);
      border-radius: var(--st-radius-4);
      overflow: hidden;
    }

    .st-drawer__head {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      padding: var(--st-space-3);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      background: var(--st-color-surface-2);
      flex-shrink: 0;
    }

    .st-drawer__title {
      font-size: var(--st-font-12);
      font-weight: 600;
    }

    .st-drawer__spacer {
      flex: 1;
    }

    .st-drawer__search {
      padding: var(--st-space-2) var(--st-space-3);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
    }

    .st-drawer__list {
      flex: 1;
      overflow: auto;
      padding: var(--st-space-2) 0;
      display: flex;
      flex-direction: column;
      gap: var(--st-space-2);
    }

    .st-drawer__row {
      display: flex;
      align-items: center;
      gap: var(--st-space-1);
      margin: 0 var(--st-space-2);
      min-width: 0;
    }

    .st-drawer__row st-repo-card {
      flex: 1;
      min-width: 0;
      margin: 0;
    }

    .st-drawer__remove {
      flex: none;
      background: transparent;
      border: var(--st-hairline) solid transparent;
      color: var(--st-color-muted);
      border-radius: var(--st-radius-2);
      cursor: pointer;
      padding: var(--st-space-1) var(--st-space-2);
      font-size: var(--st-font-12);
      line-height: 1;
    }

    .st-drawer__remove:hover:not(:disabled) {
      color: var(--st-color-text);
      background: color-mix(in srgb, var(--st-color-text) 7%, transparent);
      border-color: var(--st-color-border);
    }

    .st-drawer__remove:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .st-right__add {
      margin: var(--st-space-2) var(--st-space-3);
      background: transparent;
      border: var(--st-hairline) dashed var(--st-color-border);
      color: var(--st-color-muted);
      border-radius: var(--st-radius-2);
      padding: var(--st-space-2);
      cursor: pointer;
    }

    .st-right__add:hover {
      color: var(--st-color-text);
      border-color: var(--st-color-muted);
    }

    /* Accessible name for the icon-only pin toggle. */
    .st-drawer__sr {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
  `,
})
export class RepoDrawer {
  readonly repos = input<readonly RepoCardView[]>([]);
  /** Whether the drawer is docked inline (true) or a floating popover (false). */
  readonly pinned = input(true);
  /** Whether the unpinned floating popover is shown. Ignored while pinned. */
  readonly open = input(false);
  readonly loading = input(false);
  readonly offline = input(false);
  readonly error = input<AppError | null>(null);
  /** Controlled by the parent; this component never mutates the highlight locally. */
  readonly selectedId = input<string | null>(null);
  /** Id of the repository being removed, or null when idle; disables its button. */
  readonly removingId = input<string | null>(null);

  readonly pinToggled = output<void>();
  readonly closed = output<void>();
  readonly repoSelected = output<string>();
  readonly removeRequested = output<string>();
  readonly addRequested = output<void>();

  readonly pinTitle = $localize`Pin`;
  readonly unpinTitle = $localize`Unpin`;

  readonly search = signal('');

  /** Localizable strings bound to `<st-empty-state>` inputs. */
  readonly messages = {
    loadingRepos: $localize`Loading repositories…`,
    desktopRequired: $localize`Desktop app required`,
    offlineMessage: $localize`Git core offline — run inside the desktop app.`,
    noRepos: $localize`No repositories`,
    noReposMessage: $localize`No local repositories yet. Add one to get started.`,
    noMatches: $localize`No matches`,
    searchPlaceholder: $localize`Search repositories…`,
  };

  readonly filteredRepos = computed<readonly RepoCardView[]>(() => {
    const term = this.search().trim().toLowerCase();
    if (!term) return this.repos();
    return this.repos().filter(
      (repo) =>
        repo.name.toLowerCase().includes(term) ||
        (repo.subtitle ?? '').toLowerCase().includes(term),
    );
  });

  select(id: string): void {
    this.repoSelected.emit(id);
  }

  /** Translated `aria-label` for a repository's remove control. */
  removeAriaLabel(repo: RepoCardView): string {
    return $localize`Remove ${repo.name}:name:`;
  }

  /**
   * Emit a removal intent for `id`. Stops propagation so the click never also
   * selects the card underneath the trash control.
   */
  onRemove(event: Event, id: string): void {
    event.stopPropagation();
    this.removeRequested.emit(id);
  }
}
