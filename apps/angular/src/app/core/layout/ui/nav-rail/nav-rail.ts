import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { BadgeComponent, IconComponent, InputComponent, NavItemComponent } from '@singularitree/ui-kit';
import type { Stash } from '@contracts/domain';
import type { AppError } from '@core/services/ipc-bridge.service';

interface WorkspaceItem {
  readonly kind: string;
  readonly label: string;
  /** `st-icon` registry name. */
  readonly icon: string;
}

/** One REMOTES group: a remote config name plus its known remote branches. */
interface RemoteGroup {
  readonly remote: string;
  readonly branches: string[];
}

/** Open per-row context menu state for a branch or tag row. */
interface RowMenu {
  readonly x: number;
  readonly y: number;
  readonly kind: 'branch' | 'tag';
  readonly name: string;
}

/**
 * Dumb 224px navigation rail (plan §3/§4.2): active-repo header, the workspace
 * switcher, local branches (filter + context menu), remote references, tags,
 * stashes, git-flow and the collapse control.
 *
 * The ref lists are supplied by the parent (root `RepoState`); the component
 * renders explicit loading/offline/empty states instead of inventing data. Every
 * behavior of the retired `sidebar-left` is preserved (`dblclick`/Enter/Space
 * checkout, row context menus, the current-branch delete guard, "+" intents).
 *
 * Ref colour roles (Dark Neon, styles only): local branches read violet
 * (`--st-color-ref-branch`), with the current branch's label lifted to
 * full-strength text on top of the shared selection bar + fill; remote
 * references read electric blue (`--st-color-ref-remote`); tags and stash
 * messages read amber (`--st-color-ref-tag`); the active-repo header's branch
 * byline reads violet. The current-branch pull-pending badge stays amber
 * (`warning`). Geometry, hover and the disabled/empty states are unchanged.
 */
@Component({
  selector: 'st-nav-rail',
  standalone: true,
  imports: [BadgeComponent, IconComponent, InputComponent, NavItemComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.st-rail--collapsed]': 'collapsed()',
  },
  template: `
    @if (!collapsed()) {
      @if (repoName() || repoPath()) {
        <div class="st-rail__repo" data-testid="st-rail-repo-header">
          @if (repoName()) {
            <span class="st-rail__repo-name">{{ repoName() }}</span>
          }
          @if (currentBranch()) {
            <span class="st-rail__repo-branch st-mono">{{ currentBranch() }}</span>
          }
          @if (repoPath()) {
            <span class="st-rail__repo-path st-mono">{{ repoPath() }}</span>
          }
        </div>
      }

      <div class="st-rail__section">
        <button
          class="st-rail__head st-eyebrow"
          type="button"
          [attr.aria-expanded]="workspaceExpanded()"
          (click)="workspaceExpanded.set(!workspaceExpanded())"
        >
          <st-icon
            class="st-rail__chevron"
            [name]="workspaceExpanded() ? 'chevron-down' : 'chevron-right'"
          />
          <span i18n>Workspace</span>
        </button>
        @if (workspaceExpanded()) {
          <ul class="st-rail__list st-chip-strip">
            @for (item of WORKSPACE; track item.kind) {
              <li
                class="st-rail__item"
                [class.st-rail__item--active]="activeWorkspace() === item.kind"
                [attr.data-testid]="'st-sidebar-workspace-' + item.kind"
                (click)="selectWorkspace(item.kind)"
              >
                <st-nav-item
                  [icon]="item.icon"
                  [label]="item.label"
                  [count]="countFor(item.kind)"
                  [active]="activeWorkspace() === item.kind"
                />
              </li>
            }
          </ul>
        }
      </div>

      <div class="st-rail__section">
        <div class="st-rail__headrow">
          <button
            class="st-rail__head st-eyebrow"
            type="button"
            [attr.aria-expanded]="branchesExpanded()"
            (click)="branchesExpanded.set(!branchesExpanded())"
          >
            <st-icon
              class="st-rail__chevron"
              [name]="branchesExpanded() ? 'chevron-down' : 'chevron-right'"
            />
            <span i18n>Local branches</span>
          </button>
          <button
            class="st-rail__add"
            type="button"
            data-testid="st-sidebar-add-branch"
            title="New branch"
            i18n-title
            (click)="newBranchRequested.emit()"
          >
            <st-icon name="plus" />
          </button>
        </div>
        @if (branchesExpanded()) {
          @if (loading()) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-loading" i18n>Loading…</p>
          } @else if (offline()) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-offline" i18n>Git core offline</p>
          } @else if (error(); as err) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-error">{{ err.message }}</p>
          } @else {
            <div class="st-rail__filter">
              <st-input
                type="search"
                data-testid="st-rail-branch-filter"
                [value]="branchFilter()"
                [placeholder]="branchFilterPlaceholder"
                [ariaLabel]="branchFilterPlaceholder"
                (valueChange)="branchFilter.set($event)"
              />
            </div>
            @if (branches().length === 0) {
              <p class="st-rail__empty" data-testid="st-sidebar-branches-empty" i18n>No branches</p>
            } @else {
              <ul class="st-rail__list" data-testid="st-sidebar-branches">
                @for (branch of filteredBranches(); track branch) {
                  <li
                    class="st-rail__row st-selectable-row st-focus-ring--inset"
                    [class.st-selection-bar]="branch === currentBranch()"
                    data-testid="st-sidebar-branch"
                    role="button"
                    tabindex="0"
                    (dblclick)="selectBranch(branch)"
                    (keydown)="onBranchKeydown($event, branch)"
                    (contextmenu)="onBranchContextMenu($event, branch)"
                  >
                    <span
                      class="st-rail__row-label st-rail__row-label--branch"
                      [class.st-rail__row-label--current]="branch === currentBranch()"
                      >{{ branch }}</span
                    >
                    @if (branch === currentBranch() && currentBranchBehind() > 0) {
                      <st-badge
                        variant="warning"
                        data-testid="st-sidebar-branch-badge"
                      >{{ currentBranchBehind() }}</st-badge>
                    }
                  </li>
                }
              </ul>
            }
          }
        }
      </div>

      <div class="st-rail__section">
        <button
          class="st-rail__head st-eyebrow"
          type="button"
          [attr.aria-expanded]="remotesExpanded()"
          (click)="remotesExpanded.set(!remotesExpanded())"
        >
          <st-icon
            class="st-rail__chevron"
            [name]="remotesExpanded() ? 'chevron-down' : 'chevron-right'"
          />
          <span i18n>Remote references</span>
        </button>
        @if (remotesExpanded()) {
          @if (loading()) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-loading" i18n>Loading…</p>
          } @else if (offline()) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-offline" i18n>Git core offline</p>
          } @else if (error(); as err) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-error">{{ err.message }}</p>
          } @else if (remoteGroups().length === 0) {
            <p class="st-rail__empty" data-testid="st-sidebar-remotes-empty" i18n>No remotes</p>
          } @else {
            <div data-testid="st-sidebar-remotes">
              @for (group of remoteGroups(); track group.remote) {
                <ul class="st-rail__list">
                  <li class="st-rail__sub st-mono">{{ group.remote }}</li>
                  @for (branch of group.branches; track branch) {
                    <li
                      class="st-rail__row st-rail__row--sub st-rail__row--mono st-rail__row--remote st-selectable-row st-focus-ring--inset"
                      data-testid="st-sidebar-remote-branches"
                      role="button"
                      tabindex="0"
                      (dblclick)="selectRemoteBranch(group.remote, branch)"
                      (keydown)="onRemoteBranchKeydown($event, group.remote, branch)"
                    >
                      {{ branch }}
                    </li>
                  }
                </ul>
              }
            </div>
          }
        }
      </div>

      <div class="st-rail__section">
        <div class="st-rail__headrow">
          <button
            class="st-rail__head st-eyebrow"
            type="button"
            [attr.aria-expanded]="tagsExpanded()"
            (click)="tagsExpanded.set(!tagsExpanded())"
          >
            <st-icon
              class="st-rail__chevron"
              [name]="tagsExpanded() ? 'chevron-down' : 'chevron-right'"
            />
            <span i18n>Tags</span>
          </button>
          <button
            class="st-rail__add"
            type="button"
            data-testid="st-sidebar-add-tag"
            title="New tag"
            i18n-title
            (click)="newTagRequested.emit()"
          >
            <st-icon name="plus" />
          </button>
        </div>
        @if (tagsExpanded()) {
          @if (loading()) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-loading" i18n>Loading…</p>
          } @else if (offline()) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-offline" i18n>Git core offline</p>
          } @else if (error(); as err) {
            <p class="st-rail__empty" data-testid="st-sidebar-refs-error">{{ err.message }}</p>
          } @else if (tags().length === 0) {
            <p class="st-rail__empty" data-testid="st-sidebar-tags-empty" i18n>No tags</p>
          } @else {
            <ul class="st-rail__list" data-testid="st-sidebar-tags">
              @for (tag of tags(); track tag) {
                <li
                  class="st-rail__row st-rail__row--sub st-rail__row--tag st-selectable-row st-focus-ring--inset"
                  data-testid="st-sidebar-tag"
                  (contextmenu)="onTagContextMenu($event, tag)"
                >
                  {{ tag }}
                </li>
              }
            </ul>
          }
        }
      </div>

      <div class="st-rail__section">
        <div class="st-rail__headrow">
          <button
            class="st-rail__head st-eyebrow"
            type="button"
            [attr.aria-expanded]="stashesExpanded()"
            (click)="stashesExpanded.set(!stashesExpanded())"
          >
            <st-icon
              class="st-rail__chevron"
              [name]="stashesExpanded() ? 'chevron-down' : 'chevron-right'"
            />
            <span i18n>Stashes</span>
          </button>
          <button
            class="st-rail__add"
            type="button"
            data-testid="st-sidebar-stash-push"
            title="Stash current changes"
            i18n-title
            (click)="stashPushRequested.emit()"
          >
            <st-icon name="plus" />
          </button>
        </div>
        @if (stashesExpanded()) {
          @if (stashesLoading()) {
            <p class="st-rail__empty" data-testid="st-sidebar-stashes-loading" i18n>Loading…</p>
          } @else if (offline()) {
            <p class="st-rail__empty" data-testid="st-sidebar-stashes-offline" i18n>Git core offline</p>
          } @else if (stashesError(); as err) {
            <p class="st-rail__empty" data-testid="st-sidebar-stashes-error">{{ err.message }}</p>
          } @else if (stashes().length === 0) {
            <p class="st-rail__empty" data-testid="st-sidebar-stashes-empty" i18n>No stashes</p>
          } @else {
            <ul class="st-rail__list" data-testid="st-sidebar-stashes">
              @for (stash of stashes(); track stash.index) {
                <li class="st-rail__stash" data-testid="st-sidebar-stash">
                  <span class="st-rail__stash-label">
                    <span class="st-rail__stash-msg">{{ stashLabel(stash) }}</span>
                    @if (stash.branchName) {
                      <span class="st-rail__stash-branch">{{ stash.branchName }}</span>
                    }
                  </span>
                  <span class="st-rail__stash-actions">
                    <button
                      type="button"
                      data-testid="st-sidebar-stash-apply"
                      [disabled]="stashOpRunning()"
                      (click)="stashApplyRequested.emit(stash)"
                    >
                      <span i18n>Apply</span>
                    </button>
                    <button
                      type="button"
                      data-testid="st-sidebar-stash-pop"
                      [disabled]="stashOpRunning()"
                      (click)="stashPopRequested.emit(stash)"
                    >
                      <span i18n>Pop</span>
                    </button>
                    <button
                      type="button"
                      class="st-rail__menu-danger"
                      data-testid="st-sidebar-stash-drop"
                      [disabled]="stashOpRunning()"
                      (click)="stashDropRequested.emit(stash)"
                    >
                      <span i18n>Drop</span>
                    </button>
                  </span>
                </li>
              }
            </ul>
          }
        }
      </div>

      <div class="st-rail__section">
        <button
          class="st-rail__head st-eyebrow"
          type="button"
          data-testid="st-sidebar-git-flow"
          (click)="gitFlowRequested.emit()"
        >
          <st-icon class="st-rail__chevron" name="git-flow" />
          <span i18n>Git Flow</span>
        </button>
      </div>

      @if (rowMenu(); as menu) {
        <div
          class="st-rail__menu-backdrop"
          data-testid="st-sidebar-menu-backdrop"
          (click)="closeRowMenu()"
          (contextmenu)="onMenuBackdropContextMenu($event)"
        ></div>
        <div
          class="st-rail__menu"
          role="menu"
          data-testid="st-sidebar-row-menu"
          [style.left.px]="menu.x"
          [style.top.px]="menu.y"
        >
          @if (menu.kind === 'branch') {
            <button
              type="button"
              role="menuitem"
              data-testid="st-sidebar-menu-checkout"
              (click)="menuCheckout(menu)"
            >
              <span i18n>Checkout</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="st-sidebar-menu-rename"
              (click)="menuRename(menu)"
            >
              <span i18n>Rename…</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="st-sidebar-menu-merge"
              (click)="menuMerge(menu)"
            >
              <span i18n>Merge into current…</span>
            </button>
          }
          <button
            type="button"
            role="menuitem"
            class="st-rail__menu-danger"
            data-testid="st-sidebar-menu-delete"
            [disabled]="deleteBlockedFor(menu)"
            [attr.title]="deleteBlockedFor(menu) ? deleteCurrentBranchTitle : null"
            (click)="menuDelete(menu)"
          >
            <span i18n>Delete…</span>
          </button>
        </div>
      }

      <div class="st-rail__footer">
        <button
          class="st-rail__collapse"
          type="button"
          (click)="collapseToggle.emit()"
          title="Collapse"
          i18n-title
        >
          «
        </button>
      </div>
    } @else {
      <button
        class="st-rail__collapse"
        type="button"
        (click)="collapseToggle.emit()"
        title="Expand"
        i18n-title
      >
        »
      </button>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: var(--st-size-rail);
      min-width: var(--st-size-rail);
      background: var(--st-color-rail);
      border-right: var(--st-hairline) solid var(--st-color-border);
      color: var(--st-color-text);
      overflow: auto;
      font-size: var(--st-font-12);
    }

    :host(.st-rail--collapsed) {
      width: var(--st-size-rail-collapsed);
      min-width: var(--st-size-rail-collapsed);
      align-items: center;
      padding-top: var(--st-space-2);
      overflow: hidden;
    }

    .st-rail__repo {
      display: flex;
      flex-direction: column;
      /* Name / branch / path are one stacked identity block: the line boxes
         already separate them, so no synthetic gap (was an off-grid 2px). */
      gap: 0;
      padding: var(--st-space-3);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      min-width: 0;
    }

    .st-rail__repo-name,
    .st-rail__repo-branch,
    .st-rail__repo-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .st-rail__repo-name {
      font-size: var(--st-font-13);
      font-weight: 600;
    }

    .st-rail__repo-branch {
      font-size: var(--st-font-12);
      color: var(--st-color-ref-branch);
    }

    .st-rail__repo-path {
      font-size: var(--st-font-11);
      color: var(--st-color-muted);
    }

    .st-rail__section {
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      padding: var(--st-space-1) 0;
    }

    .st-rail__headrow {
      display: flex;
      align-items: center;
    }

    .st-rail__head {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      background: transparent;
      border: none;
      color: var(--st-color-muted);
      padding: var(--st-space-2) var(--st-space-3);
      cursor: pointer;
      text-align: left;
    }

    .st-rail__head:hover {
      color: var(--st-color-text);
    }

    .st-rail__chevron {
      flex: none;
    }

    .st-rail__add {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: var(--st-hairline) solid transparent;
      color: var(--st-color-muted);
      border-radius: var(--st-radius-2);
      cursor: pointer;
      padding: var(--st-space-1);
      margin-right: var(--st-space-2);
    }

    .st-rail__add:hover {
      color: var(--st-color-text);
      border-color: var(--st-color-border);
    }

    .st-rail__list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .st-rail__item {
      margin: 0 var(--st-space-2);
    }

    .st-rail__item--active {
      border-radius: var(--st-radius-2);
    }

    .st-rail__row {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      height: var(--st-size-row-tree-dense);
      padding: 0 var(--st-space-2) 0 var(--st-space-6);
      color: var(--st-color-muted);
      font-size: var(--st-font-12);
      -webkit-user-select: none;
      user-select: none;
    }

    .st-rail__row:hover {
      color: var(--st-color-text);
    }

    .st-rail__row--sub {
      padding-left: var(--st-space-6);
    }

    .st-rail__row--mono {
      padding-left: var(--st-space-7);
      font-family: var(--st-font-mono);
    }

    /* Remote references and tags share the --sub indent but carry distinct
       semantic colours; the base .st-rail__row muted colour would otherwise
       apply to both. */
    .st-rail__row--remote {
      color: var(--st-color-ref-remote);
    }

    .st-rail__row--tag {
      color: var(--st-color-ref-tag);
    }

    .st-rail__row-label {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Local branch labels read violet; the current branch's label lifts to
       full-strength text so it outranks its siblings (its selection bar and
       fill already carry the "you are here" weight). */
    .st-rail__row-label--branch {
      color: var(--st-color-ref-branch);
    }

    .st-rail__row-label--current {
      color: var(--st-color-text);
    }

    /* Keep the shared row hover affordance: hovering a branch row brightens its
       violet label to full-strength text, matching remote/tag rows. */
    .st-rail__row:hover .st-rail__row-label--branch {
      color: var(--st-color-text);
    }

    .st-rail__sub {
      display: flex;
      align-items: center;
      height: var(--st-size-row-tree-dense);
      padding: 0 var(--st-space-3);
      color: var(--st-color-muted);
      font-size: var(--st-font-11);
    }

    .st-rail__filter {
      padding: var(--st-space-1) var(--st-space-2) var(--st-space-2);
    }

    .st-rail__empty {
      margin: 0;
      padding: var(--st-space-1) var(--st-space-3);
      color: var(--st-color-muted);
      font-size: var(--st-font-12);
      font-style: italic;
    }

    .st-rail__stash {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--st-space-2);
      padding: var(--st-space-1) var(--st-space-2) var(--st-space-1) var(--st-space-3);
    }

    .st-rail__stash-label {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .st-rail__stash-msg {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      /* Amber = pending changes, matching tags. */
      color: var(--st-color-ref-tag);
    }

    .st-rail__stash-branch {
      color: var(--st-color-muted);
      font-size: var(--st-font-11);
    }

    .st-rail__stash-actions {
      display: flex;
      flex: none;
      gap: var(--st-space-1);
    }

    .st-rail__stash-actions button {
      background: transparent;
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      color: var(--st-color-muted);
      cursor: pointer;
      font: inherit;
      font-size: var(--st-font-11);
      padding: var(--st-hairline) var(--st-space-2);
    }

    .st-rail__stash-actions button:hover:not(:disabled) {
      color: var(--st-color-text);
    }

    .st-rail__stash-actions button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .st-rail__menu-backdrop {
      position: fixed;
      inset: 0;
      z-index: var(--st-z-backdrop);
    }

    .st-rail__menu {
      position: fixed;
      z-index: var(--st-z-menu);
      min-width: 168px;
      padding: var(--st-space-1);
      background: var(--st-color-raised);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-4);
      color: var(--st-color-text);
      font-size: var(--st-font-12);
    }

    .st-rail__menu button {
      display: block;
      width: 100%;
      padding: var(--st-space-2) var(--st-space-3);
      background: transparent;
      border: 0;
      border-radius: var(--st-radius-3);
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .st-rail__menu button:hover,
    .st-rail__menu button:focus-visible {
      background: var(--st-color-accent-soft);
      outline: none;
    }

    .st-rail__menu button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .st-rail__menu button:disabled:hover {
      background: transparent;
    }

    .st-rail__menu-danger {
      color: var(--st-color-danger);
    }

    .st-rail__footer {
      margin-top: auto;
      padding: var(--st-space-2);
      display: flex;
      justify-content: flex-end;
    }

    .st-rail__collapse {
      background: transparent;
      border: var(--st-hairline) solid var(--st-color-border);
      color: var(--st-color-muted);
      border-radius: var(--st-radius-2);
      cursor: pointer;
      padding: var(--st-space-1) var(--st-space-2);
    }

    .st-rail__collapse:hover {
      color: var(--st-color-text);
      border-color: var(--st-color-muted);
    }

    /* Responsive rail (plan §5 P6): at ≤1100 the rail leaves the left column
       and turns into a horizontal, wrapping chip strip above the workspace. */
    @media (max-width: 1100px) {
      :host {
        flex-direction: row;
        flex-wrap: wrap;
        align-items: flex-start;
        overflow: auto;
      }

      .st-rail__repo {
        flex: 1 1 100%;
      }

      .st-rail__section {
        flex: 0 1 auto;
        border-bottom: 0;
        border-right: var(--st-hairline) solid var(--st-color-border);
      }

      .st-rail__footer {
        margin-top: 0;
      }

      .st-rail__filter {
        max-width: 260px;
      }
    }
  `,
})
export class NavRail {
  readonly collapsed = input(false);
  /** Active repository display name; hidden with the header when empty. */
  readonly repoName = input('');
  /** Active repository filesystem path (mono byline). */
  readonly repoPath = input('');
  /** Local branch display names. */
  readonly branches = input<readonly string[]>([]);
  /** Name of the current local branch; only it can carry a pull-pending badge. */
  readonly currentBranch = input('');
  /** Pull-pending count of the current branch; badges its row when > 0. */
  readonly currentBranchBehind = input(0);
  /** Remote-tracking branch names, e.g. `origin/david/topic`. */
  readonly remoteBranches = input<readonly string[]>([]);
  readonly tags = input<readonly string[]>([]);
  /** Remote config names (not remote branches). */
  readonly remotes = input<readonly string[]>([]);
  /** Stash entries for the active repository (newest first). */
  readonly stashes = input<readonly Stash[]>([]);
  readonly stashesLoading = input(false);
  readonly stashesError = input<AppError | null>(null);
  /** True while a stash apply/pop/drop mutation is in flight. */
  readonly stashOpRunning = input(false);
  readonly loading = input(false);
  readonly offline = input(false);
  readonly error = input<AppError | null>(null);
  /** Controlled by the parent; this component never mutates it locally. */
  readonly activeWorkspace = input('history');
  /**
   * Working-tree change count for the "Commit analyzer" workspace pill. The
   * shell has no working-tree count at its scope yet, so it passes 0 and the
   * pill is hidden; the `st-nav-item` mechanism is already in place for a later
   * feed. (Deferral — no IPC call is invented here.)
   */
  readonly changeCount = input(0);

  readonly collapseToggle = output<void>();
  readonly workspaceSelected = output<string>();
  /** Local branch display name requested for checkout. */
  readonly branchSelected = output<string>();
  /** Remote-tracking branch short name requested for checkout (`<remote>/<branch>`). */
  readonly remoteBranchSelected = output<string>();
  /** User asked to create a new branch ("+" in the BRANCHES header). */
  readonly newBranchRequested = output<void>();
  /** User asked to create a new tag ("+" in the TAGS header). */
  readonly newTagRequested = output<void>();
  /** Local branch name requested for rename (row context menu). */
  readonly branchRenameRequested = output<string>();
  /** Local branch name requested for deletion (row context menu). */
  readonly branchDeleteRequested = output<string>();
  /** Local branch name requested to be merged into the current branch. */
  readonly branchMergeRequested = output<string>();
  /** Tag name requested for deletion (row context menu). */
  readonly tagDeleteRequested = output<string>();
  /** User asked to stash the current changes ("+" in the STASHES header). */
  readonly stashPushRequested = output<void>();
  /** Stash entry requested to be applied to the working tree. */
  readonly stashApplyRequested = output<Stash>();
  /** Stash entry requested to be popped (applied and dropped). */
  readonly stashPopRequested = output<Stash>();
  /** Stash entry requested to be dropped (the parent confirms first). */
  readonly stashDropRequested = output<Stash>();
  /** User asked to open the git-flow panel (GIT FLOW header). */
  readonly gitFlowRequested = output<void>();

  /**
   * REMOTES groups: every configured remote (in order) plus any remote derived
   * from a remote-tracking branch name. Each group lists its branch short names
   * (remote prefix stripped). Remote visibility never requires a local
   * tracking branch.
   */
  readonly remoteGroups = computed<RemoteGroup[]>(() => {
    const groups: RemoteGroup[] = [];
    const indexByRemote = new Map<string, number>();
    const ensure = (remote: string): RemoteGroup => {
      const existing = indexByRemote.get(remote);
      if (existing !== undefined) return groups[existing];
      const group: RemoteGroup = { remote, branches: [] };
      indexByRemote.set(remote, groups.length);
      groups.push(group);
      return group;
    };

    for (const remote of this.remotes()) ensure(remote);

    for (const branch of this.remoteBranches()) {
      const separator = branch.indexOf('/');
      if (separator <= 0) continue;
      const remote = branch.slice(0, separator);
      const shortName = branch.slice(separator + 1);
      if (!remote || !shortName) continue;
      const group = ensure(remote);
      if (!group.branches.includes(shortName)) group.branches.push(shortName);
    }

    return groups;
  });

  readonly WORKSPACE: readonly WorkspaceItem[] = [
    { kind: 'status', label: $localize`Commit analyzer`, icon: 'changes' },
    { kind: 'history', label: $localize`History`, icon: 'history' },
    { kind: 'repos', label: $localize`Repositories`, icon: 'repo' },
  ];

  /** Explanatory tooltip shown when "Delete…" targets the current branch. */
  readonly deleteCurrentBranchTitle = $localize`Cannot delete the current branch`;

  readonly branchFilterPlaceholder = $localize`Filter branches…`;

  readonly workspaceExpanded = signal(true);
  readonly branchesExpanded = signal(true);
  readonly tagsExpanded = signal(false);
  readonly remotesExpanded = signal(true);
  readonly stashesExpanded = signal(false);
  /** Client-side branch filter term (empty = no filtering). */
  readonly branchFilter = signal('');
  /** Open per-row menu (branch or tag), or null when closed. */
  readonly rowMenu = signal<RowMenu | null>(null);

  /** Branch rows narrowed by the local filter (case-insensitive substring). */
  readonly filteredBranches = computed<readonly string[]>(() => {
    const term = this.branchFilter().trim().toLowerCase();
    if (!term) return this.branches();
    return this.branches().filter((branch) => branch.toLowerCase().includes(term));
  });

  selectWorkspace(kind: string): void {
    this.workspaceSelected.emit(kind);
  }

  /** Count pill for a workspace item: only "Commit analyzer" carries one. */
  countFor(kind: string): number | undefined {
    return kind === 'status' ? this.changeCount() : undefined;
  }

  /**
   * Display label for a stash row: its message, falling back to the Git-style
   * `stash@{index}` when the core returned an empty message.
   */
  stashLabel(stash: Stash): string {
    return stash.message || `stash@{${stash.index}}`;
  }

  /** Emit a local branch name for checkout. */
  selectBranch(name: string): void {
    this.branchSelected.emit(name);
  }

  /**
   * Emit the `remote/branch` short name for checkout. REMOTES groups store
   * prefix-stripped branch names, so the remote prefix is reconstructed here.
   */
  selectRemoteBranch(remote: string, shortName: string): void {
    this.remoteBranchSelected.emit(`${remote}/${shortName}`);
  }

  /** Enter/Space activation for local branch rows (role="button"). */
  onBranchKeydown(event: KeyboardEvent, name: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.selectBranch(name);
    }
  }

  /** Enter/Space activation for remote branch rows (role="button"). */
  onRemoteBranchKeydown(event: KeyboardEvent, remote: string, shortName: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.selectRemoteBranch(remote, shortName);
    }
  }

  // -- per-row context menu ------------------------------------------------

  /** Open the row menu for a local branch at the pointer. */
  onBranchContextMenu(event: MouseEvent, name: string): void {
    event.preventDefault();
    this.rowMenu.set({ x: event.clientX, y: event.clientY, kind: 'branch', name });
  }

  /** Open the row menu for a tag at the pointer. */
  onTagContextMenu(event: MouseEvent, name: string): void {
    event.preventDefault();
    this.rowMenu.set({ x: event.clientX, y: event.clientY, kind: 'tag', name });
  }

  closeRowMenu(): void {
    this.rowMenu.set(null);
  }

  /** A right-click on the menu backdrop dismisses the menu. */
  onMenuBackdropContextMenu(event: MouseEvent): void {
    event.preventDefault();
    this.closeRowMenu();
  }

  menuCheckout(menu: RowMenu): void {
    this.closeRowMenu();
    this.branchSelected.emit(menu.name);
  }

  menuRename(menu: RowMenu): void {
    this.closeRowMenu();
    this.branchRenameRequested.emit(menu.name);
  }

  menuMerge(menu: RowMenu): void {
    this.closeRowMenu();
    this.branchMergeRequested.emit(menu.name);
  }

  menuDelete(menu: RowMenu): void {
    this.closeRowMenu();
    // Tags can always be deleted; a branch that is the current one cannot.
    if (menu.kind === 'branch' && this.deleteBlockedFor(menu)) return;
    if (menu.kind === 'branch') {
      this.branchDeleteRequested.emit(menu.name);
    } else {
      this.tagDeleteRequested.emit(menu.name);
    }
  }

  /**
   * True when the open menu's row is the current local branch, whose deletion is
   * blocked (it must be switched away from first). Tags are never blocked.
   */
  deleteBlockedFor(menu: RowMenu): boolean {
    return menu.kind === 'branch' && menu.name === this.currentBranch();
  }
}
