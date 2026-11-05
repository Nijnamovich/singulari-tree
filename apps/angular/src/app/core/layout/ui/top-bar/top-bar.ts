import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BadgeComponent, ButtonComponent, IconComponent } from '@singularitree/ui-kit';

/** One top-bar repository tab: a stable id, its display name and an optional branch byline. */
export interface TopBarTab {
  readonly id: string;
  readonly label: string;
  /** Current branch byline; supplied by the parent for the active tab only. */
  readonly branch?: string;
}

/**
 * Dumb 64px shell top bar (plan §3/§4.1): brand glyph + wordmark, a hairline,
 * the repo tab strip, the live remote-op cluster, a sync pill, the account /
 * settings destinations and the drawer pin toggle. The parent owns every piece
 * of state and routing; this component only renders and emits intents (D3: the
 * retired toolbar's live actions live here, its inert chrome buttons are gone).
 *
 * Emphasis hierarchy (Dark Neon): exactly one action is highlighted — Push, the
 * `primary` variant (turquoise fill + dark contrast text). Pull and Fetch stay
 * secondary; Sync (the active-tab fetch) is neutral with an electric-blue `info`
 * interaction accent on hover/focus. The sync pill is mint (`success`) when clean
 * and amber (`warning`) while a pull is pending. Coral (`danger`) is reserved for
 * repository errors and is never applied here.
 */
@Component({
  selector: 'st-top-bar',
  standalone: true,
  imports: [RouterLink, BadgeComponent, ButtonComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="st-topbar">
      <div class="st-topbar__brand">
        <st-icon class="st-topbar__brand-glyph" name="brand" />
        <span class="st-topbar__wordmark">{{ brand() }}</span>
      </div>

      <div class="st-topbar__rule st-hairline--left" aria-hidden="true"></div>

      <div class="st-topbar__tabs" role="tablist">
        @for (tab of tabs(); track tab.id) {
          <span
            class="st-tab st-focus-ring--inset"
            [class.st-tab--active]="tab.id === activeTab()"
            [class.st-selection-bar]="tab.id === activeTab()"
            role="tab"
            tabindex="0"
            [attr.aria-selected]="tab.id === activeTab()"
            [attr.title]="tab.label"
            (click)="tabSelected.emit(tab.id)"
            (keydown.enter)="selectFromKeyboard($event, tab.id)"
            (keydown.space)="selectFromKeyboard($event, tab.id)"
          >
            <span class="st-tab__body">
              <span class="st-tab__label">{{ tab.label }}</span>
              @if (tab.branch) {
                <span class="st-tab__branch st-mono st-hide-at-1100">{{ tab.branch }}</span>
              }
            </span>
            <button
              class="st-tab__close st-focus-ring--inset"
              type="button"
              aria-label="Close tab"
              i18n-aria-label
              (click)="close($event, tab.id)"
            >
              ×
            </button>
          </span>
        }
        <button
          class="st-tab__add st-focus-ring"
          type="button"
          aria-label="Add tab"
          i18n-aria-label
          (click)="addRequested.emit()"
        >
          +
        </button>
      </div>

      <div class="st-topbar__drag"></div>

      <div class="st-topbar__actions">
        <st-button
          variant="ghost"
          size="sm"
          class="st-topbar__action"
          data-testid="top-bar-pull"
          [disabled]="!hasActiveRepo()"
          (click)="pullRequested.emit()"
        >
          <st-icon name="pull" />
          <span i18n>Pull</span>
          @if (pullPending() > 0) {
            <st-badge variant="warning" data-testid="top-bar-pull-badge">{{ pullPending() }}</st-badge>
          }
        </st-button>
        <st-button
          variant="primary"
          size="sm"
          class="st-topbar__action"
          data-testid="top-bar-push"
          [disabled]="!hasActiveRepo()"
          (click)="pushRequested.emit()"
        >
          <st-icon name="push" />
          <span i18n>Push</span>
        </st-button>
        <st-button
          variant="ghost"
          size="sm"
          class="st-topbar__action"
          data-testid="top-bar-fetch"
          [disabled]="!hasActiveRepo()"
          (click)="fetchRequested.emit()"
        >
          <st-icon name="fetch" />
          <span i18n>Fetch</span>
        </st-button>
        <st-button
          variant="info"
          size="sm"
          class="st-topbar__action"
          data-testid="top-bar-sync"
          [disabled]="!canSync()"
          (click)="syncRequested.emit()"
        >
          <st-icon name="fetch-all" />
          <span i18n>Sync</span>
        </st-button>
        <st-button
          variant="ghost"
          size="sm"
          class="st-topbar__action"
          data-testid="top-bar-clone-clipboard"
          (click)="cloneFromClipboardRequested.emit()"
        >
          <st-icon name="clone" />
          <span i18n>Clone from clipboard</span>
        </st-button>
        <st-button
          variant="ghost"
          size="sm"
          class="st-topbar__action"
          data-testid="top-bar-copy-repo-url"
          [disabled]="!hasActiveRepo()"
          (click)="copyRepoUrlRequested.emit()"
        >
          <st-icon name="copy-link" />
          <span i18n>Copy repo URL</span>
        </st-button>
      </div>

      <div class="st-topbar__sync">
        <st-badge
          data-testid="top-bar-sync-pill"
          [variant]="pullPending() > 0 ? 'warning' : 'success'"
        >
          @if (pullPending() > 0) {
            ↓{{ pullPending() }}
          } @else {
            <span i18n>Synced</span>
          }
        </st-badge>
      </div>

      <div class="st-topbar__nav">
        <a
          class="st-topbar__nav-link st-focus-ring"
          routerLink="/github-account"
          data-testid="top-bar-nav-github"
        >
          <st-icon name="github" />
          <span class="st-topbar__sr" i18n>GitHub account</span>
        </a>
        <a
          class="st-topbar__nav-link st-focus-ring"
          routerLink="/settings"
          data-testid="top-bar-nav-settings"
        >
          <st-icon name="settings" />
          <span class="st-topbar__sr" i18n>Settings</span>
        </a>
      </div>

      <div class="st-topbar__drawer">
        <st-button
          variant="icon"
          size="sm"
          data-testid="top-bar-drawer-toggle"
          [attr.id]="drawerToggleId()"
          [attr.tabindex]="-1"
          [attr.aria-expanded]="drawerPinned()"
          [attr.title]="drawerPinned() ? unpinTitle : pinTitle"
          (click)="drawerToggled.emit()"
        >
          <st-icon [name]="drawerPinned() ? 'pin' : 'pin-off'" />
          <span class="st-topbar__sr" i18n>Toggle repositories</span>
        </st-button>
      </div>
    </header>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
    }

    .st-topbar {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      height: var(--st-size-topbar);
      padding: 0 var(--st-space-3);
      background: var(--st-color-chrome);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      color: var(--st-color-text);
      -webkit-app-region: drag;
      user-select: none;
    }

    .st-topbar__brand {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      flex: none;
      color: var(--st-color-accent);
    }

    .st-topbar__brand-glyph {
      flex: none;
    }

    .st-topbar__wordmark {
      font-size: var(--st-font-17);
      font-weight: 600;
      color: var(--st-color-text);
      letter-spacing: 0.2px;
    }

    /* 1px vertical hairline, full bar height, 12px inset. */
    .st-topbar__rule {
      flex: none;
      align-self: stretch;
      margin: var(--st-space-3) 0;
    }

    .st-topbar__tabs {
      display: flex;
      align-items: center;
      gap: var(--st-space-1);
      flex: none;
      max-width: 45%;
      overflow: hidden;
      -webkit-app-region: no-drag;
    }

    .st-tab {
      display: inline-flex;
      align-items: center;
      gap: var(--st-space-1);
      box-sizing: border-box;
      /* Uniform tab geometry: every tab shares one flex-basis and one cap, so a
         short label never renders a stubby tab. When the strip is tight they
         shrink equally (never clip) and the trailing + stays reachable. */
      flex: 1 1 var(--st-size-tab);
      max-width: var(--st-size-tab);
      min-width: 0;
      height: 40px;
      padding: 0 var(--st-space-2) 0 var(--st-space-3);
      /* The hairline is always reserved (transparent when inactive) so the
         active tab's stronger edge cannot shift the 40px geometry. */
      border: var(--st-hairline) solid transparent;
      border-radius: var(--st-radius-2);
      background-color: transparent;
      color: var(--st-color-muted);
      font-size: var(--st-font-13);
      font-weight: 600;
      cursor: pointer;
    }

    /* Inactive hover: the same subtle surface language as .st-hover-surface,
       defined locally from tokens rather than pulling in a new template class. */
    .st-tab:not(.st-tab--active):hover {
      background-color: color-mix(in srgb, var(--st-color-text) 6%, transparent);
      color: var(--st-color-text);
    }

    /* Active: the shared selection treatment — a decisively cyan-tinted fill,
       the selected hairline, full-strength text and the 3px inset cyan
       selection bar (applied by the .st-selection-bar class). */
    .st-tab--active {
      background-color: var(--st-color-selected);
      border-color: var(--st-color-selected-border);
      color: var(--st-color-text);
    }

    .st-tab__body {
      display: flex;
      flex-direction: column;
      /* Absorb the tab's fixed width so the close button stays at the edge. */
      flex: 1 1 auto;
      min-width: 0;
      line-height: var(--st-leading-tight);
    }

    .st-tab__label {
      /* Explicit typography: the active state conveys selection via fill,
         border and colour only, never via a size change. */
      font-size: var(--st-font-13);
      font-weight: 600;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .st-tab__branch {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--st-font-12);
      font-weight: 400;
      color: var(--st-color-muted);
    }

    .st-tab__close {
      flex: none;
      background: transparent;
      border: none;
      color: var(--st-color-muted);
      font-size: var(--st-font-13);
      line-height: 1;
      padding: 0;
      cursor: pointer;
    }

    /* Keep the close affordance clearly visible on the active tab and on hover. */
    .st-tab--active .st-tab__close,
    .st-tab:hover .st-tab__close {
      color: var(--st-color-text);
    }

    .st-tab__close:hover {
      color: var(--st-color-text);
    }

    .st-tab__add {
      flex: none;
      background: transparent;
      border: var(--st-hairline) solid var(--st-color-border);
      color: var(--st-color-muted);
      width: 24px;
      height: 24px;
      border-radius: var(--st-radius-pill);
      cursor: pointer;
    }

    .st-tab__add:hover {
      color: var(--st-color-text);
      border-color: var(--st-color-accent);
    }

    /* Far-right, flexible drag region; interactive clusters opt out. */
    .st-topbar__drag {
      flex: 1 1 auto;
      align-self: stretch;
      min-width: var(--st-space-4);
      -webkit-app-region: drag;
    }

    .st-topbar__actions {
      display: flex;
      align-items: center;
      gap: var(--st-space-1);
      flex: none;
      -webkit-app-region: no-drag;
    }

    .st-topbar__action {
      color: var(--st-color-muted);
    }

    .st-topbar__sync {
      flex: none;
      -webkit-app-region: no-drag;
    }

    .st-topbar__drawer {
      position: relative;
      flex: none;
      -webkit-app-region: no-drag;
    }

    .st-topbar__nav {
      display: flex;
      align-items: center;
      gap: var(--st-space-1);
      flex: none;
      -webkit-app-region: no-drag;
    }

    /* Icon-only destination links, matching the sm icon button's square
       geometry, hairline border and muted glyph. Native anchors (not the
       st-button component) because a RouterLink anchor supplies the href and
       keyboard semantics the account/settings destinations require. */
    .st-topbar__nav-link {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: var(--st-size-control-sm);
      height: var(--st-size-control-sm);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: var(--st-color-surface);
      color: var(--st-color-muted);
      text-decoration: none;
      cursor: pointer;
    }

    .st-topbar__nav-link:hover,
    .st-topbar__nav-link:focus-visible {
      border-color: var(--st-color-accent);
      color: var(--st-color-text);
    }

    /* Accessible name for the icon-only controls. */
    .st-topbar__sr {
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
export class TopBar {
  readonly brand = input('SingulariTree');
  readonly tabs = input<readonly TopBarTab[]>([]);
  /** Id of the active tab, or null when none is active. */
  readonly activeTab = input<string | null>(null);
  /** Whether a repository is active; gates Pull/Push/Fetch/Copy-URL. */
  readonly hasActiveRepo = input(false);
  /** Whether a repository tab is active; gates Sync (the active-tab fetch). */
  readonly canSync = input(false);
  /** Pull-pending (behind) count of the current branch; badges Pull and the sync pill. */
  readonly pullPending = input(0);
  /** Whether the repo drawer is pinned (docked); reflected on the toggle. */
  readonly drawerPinned = input(true);
  /** Element id of the drawer toggle, so the shell can restore focus on close. */
  readonly drawerToggleId = input('st-drawer-toggle');

  readonly tabSelected = output<string>();
  readonly tabClosed = output<string>();
  readonly addRequested = output<void>();
  readonly pullRequested = output<void>();
  readonly pushRequested = output<void>();
  readonly fetchRequested = output<void>();
  readonly syncRequested = output<void>();
  readonly cloneFromClipboardRequested = output<void>();
  readonly copyRepoUrlRequested = output<void>();
  readonly drawerToggled = output<void>();

  readonly pinTitle = $localize`Pin repositories`;
  readonly unpinTitle = $localize`Unpin repositories`;

  /** Enter/Space activation for a tab (role="tab"). */
  selectFromKeyboard(event: Event, id: string): void {
    event.preventDefault();
    this.tabSelected.emit(id);
  }

  /** Close a tab without also selecting it. */
  close(event: Event, id: string): void {
    event.stopPropagation();
    this.tabClosed.emit(id);
  }
}
