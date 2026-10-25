import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { Router } from '@angular/router';
import {
  BadgeComponent,
  ButtonComponent,
  EmptyStateComponent,
  GRAPH_ROW_HEIGHT,
  GraphRow,
  IconComponent,
  InputComponent,
  LANE_COLUMN_WIDTH,
} from '@singularitree/ui-kit';
import { BranchCreateDialog } from '@shared/ui/ref-dialogs/branch-create-dialog';
import type { BranchCreateValue, TagCreateValue } from '@shared/ui/ref-dialogs/ref-dialog.models';
import { TagCreateDialog } from '@shared/ui/ref-dialogs/tag-create-dialog';
import { BranchLensStore } from '@core/services/branch-lens.store';
import { KeyboardShortcutService } from '@core/services/keyboard-shortcut.service';
import { RepoState } from '@core/services/repo-state.service';
import type { CommitRow } from '../../repo-models';
import { GRAPH_PREFETCH_THRESHOLD, GraphStore, WIP_OID } from '../graph.store';
import type {
  CheckoutTarget,
  GraphContextMenuTarget,
  ResetModeName,
} from '../graph-menu.models';
import { GraphContextMenu } from '../ui/graph-context-menu';
import { ResetConfirmDialog } from '../ui/reset-confirm-dialog';
import { WipRow } from '../ui/wip-row';

/**
 * Commit graph feature page: the primary History pane (plan §4.5). It owns the
 * pane header (title + branch badge + search/clear), the sticky column header and
 * commit-count footer, the virtualized graph rows (CDK) and the pinned WIP node.
 * The commit-detail pane now lives in `repo-page`'s `st-workspace-split`, so this
 * page renders neither a split nor an `<aside>`. Data comes exclusively from
 * `GraphStore` (`getCommits` via `IpcBridge`); the page never talks to Git.
 */
@Component({
  selector: 'st-graph-page',
  standalone: true,
  imports: [
    ScrollingModule,
    GraphRow,
    WipRow,
    GraphContextMenu,
    ResetConfirmDialog,
    BranchCreateDialog,
    TagCreateDialog,
    BadgeComponent,
    ButtonComponent,
    EmptyStateComponent,
    IconComponent,
    InputComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="st-graph-page">
      <header class="st-graph-page__header">
        <div class="st-graph-page__heading">
          <span class="st-eyebrow st-graph-page__eyebrow" i18n>Workspace</span>
          <h2 class="st-graph-page__title" i18n>History</h2>
        </div>

        @if (currentBranch()) {
          <st-badge variant="branch" data-testid="graph-branch">{{ currentBranch() }}</st-badge>
        }

        <div class="st-graph-page__search">
          <st-input
            type="search"
            class="st-graph-page__filter"
            data-testid="graph-filter"
            [value]="store.filter()"
            [placeholder]="filterPlaceholder"
            [ariaLabel]="filterPlaceholder"
            (valueChange)="onFilterValue($event)"
          />
          @if (store.filter()) {
            <st-button
              variant="icon"
              size="sm"
              class="st-graph-page__filter-clear"
              data-testid="graph-filter-clear"
              [ariaLabel]="clearFilterTitle"
              (click)="clearFilter()"
            >
              <st-icon name="close" />
            </st-button>
          }
        </div>

        <st-button
          variant="default"
          size="sm"
          class="st-graph-page__changes"
          data-testid="graph-open-changes"
          (click)="openChanges()"
        >
          <st-icon name="changes" />
          <span i18n>Changes</span>
        </st-button>
      </header>

      <!--
        Branch lens (ADR-0042): a view-only ref scope. The bar states the scope
        in text and offers the one exit; it is a role="status" so the scope is
        announced, because the graph itself only changes visually (dimmed rows).
      -->
      @if (lens.active()) {
        <div class="st-graph-page__lens" role="status" data-testid="graph-lens-bar">
          <span class="st-graph-page__lens-label" i18n>Lens</span>
          <span class="st-graph-page__lens-ref st-mono" data-testid="graph-lens-ref">{{
            lens.ref()
          }}</span>
          <span class="st-graph-page__lens-note" data-testid="graph-lens-note" i18n
            >Commits outside this ref are dimmed.</span
          >
          <st-button
            variant="ghost"
            size="sm"
            class="st-graph-page__lens-clear"
            data-testid="graph-lens-clear"
            (click)="lens.clear()"
          >
            <span i18n>Clear</span>
          </st-button>
        </div>
      }

      @if (store.error(); as error) {
        <p class="st-graph-page__error" data-testid="graph-error">{{ error.message }}</p>
      }

      @if (store.isLoading()) {
        <st-empty-state
          data-testid="graph-loading"
          icon="⏳"
          title="Loading"
          i18n-title
          message="Fetching the commit history."
          i18n-message
          tone="muted"
        />
      }

      @if (store.offline()) {
        <st-empty-state
          data-testid="graph-offline"
          icon="🔌"
          title="Git core offline"
          i18n-title
          message="Open a repository inside the desktop app to load history."
          i18n-message
          tone="muted"
        />
      }

      <!--
        Sticky column header aligned to the row columns (plan §4.5). It carries
        the visible column labels while the rows below stay role="button"
        (no row-header/table semantics are invented here).
      -->
      <div
        class="st-eyebrow st-graph-page__columns"
        data-testid="graph-column-headers"
      >
        <!--
          Decorative spacer, not a label: it only reserves the lane gutter so
          "Commit / author" stays aligned with the row messages. A text label
          here would overflow the narrow gutter width.
        -->
        <span
          class="st-graph-page__col-graph"
          [style.width.px]="graphWidth()"
          aria-hidden="true"
        ></span>
        <span class="st-graph-page__col-message" i18n>Commit / author</span>
        <span class="st-graph-page__col-date st-hide-at-1600" i18n>Date</span>
      </div>

      <div class="st-graph-page__list">
        <!-- Pinned outside the virtual viewport so it never affects lane math. -->
        <st-wip-row
          [selected]="store.isWipSelected()"
          (picked)="selectWip()"
          data-testid="graph-wip"
        />

        <cdk-virtual-scroll-viewport
          class="st-graph-page__viewport"
          [itemSize]="rowHeight"
          (scrolledIndexChange)="onScrolledIndexChange($event)"
        >
          <st-graph-row
            *cdkVirtualFor="let row of store.filteredRows(); trackBy: trackByRow"
            [commit]="row.commit"
            [lane]="row.lane"
            [maxLane]="maxLane()"
            [selected]="store.selectedOid() === row.commit.oid?.hex"
            [stats]="store.statsFor(row.commit.oid?.hex)"
            [lensActive]="lens.active()"
            [inLens]="store.lensOids().has(row.commit.oid?.hex ?? '')"
            (picked)="onRowPicked(row)"
            (contextmenu)="onRowContextMenu($event, row)"
          />
        </cdk-virtual-scroll-viewport>

        @if (store.filteredRows().length === 0) {
          <st-empty-state
            data-testid="graph-empty"
            [icon]="emptyIcon()"
            [title]="emptyTitle()"
            [message]="emptyMessage()"
          />
        }
      </div>

      <footer class="st-graph-page__footer" data-testid="graph-count">{{ countLabel() }}</footer>

      <!-- Right-click action shell (ADR-0022): dumb, emits; the page owns the RPC. -->
      <st-graph-context-menu
        [open]="contextMenu() !== null"
        [x]="contextMenu()?.x ?? 0"
        [y]="contextMenu()?.y ?? 0"
        [target]="contextMenuTarget()"
        [canCompare]="canCompare()"
        [busy]="store.resetRunning()"
        [lensActive]="lens.active()"
        [currentBranch]="currentBranch()"
        (checkout)="onCheckout($event)"
        (lensCherryPick)="onLensCherryPick($event)"
        (compare)="onCompare()"
        (fileStatus)="onFileStatus($event)"
        (copySha)="onCopySha($event)"
        (createBranchHere)="onCreateBranchHere($event)"
        (tagCommit)="onTagCommit($event)"
        (revert)="onRevert($event)"
        (reset)="onReset($event)"
        (closed)="closeContextMenu()"
      />

      <!-- Destructive gate for a hard reset (ADR-0021). -->
      <st-reset-confirm-dialog
        [open]="resetConfirm() !== null"
        [oid]="resetConfirm()?.oid ?? null"
        [busy]="store.resetRunning()"
        (confirmed)="onResetConfirmed()"
        (cancelled)="onResetCancelled()"
      />

      <!-- Create branch/tag at the menu commit (ADR-028). -->
      <st-branch-create-dialog
        [open]="branchDialog() !== null"
        [defaultStartPoint]="branchDialog()?.startPoint ?? 'HEAD'"
        [running]="refOpRunning()"
        [error]="refOpError()"
        (submitted)="onBranchCreateSubmitted($event)"
        (cancelled)="onBranchCreateCancelled()"
      />
      <st-tag-create-dialog
        [open]="tagDialog() !== null"
        [defaultTarget]="tagDialog()?.target ?? 'HEAD'"
        [running]="refOpRunning()"
        [error]="refOpError()"
        (submitted)="onTagCreateSubmitted($event)"
        (cancelled)="onTagCreateCancelled()"
      />
    </section>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      color: var(--st-color-text);
    }

    .st-graph-page {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--st-color-surface);
    }

    .st-graph-page__header {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      padding: var(--st-space-2) var(--st-space-3);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
    }

    /* Branch lens bar: a ref-coloured wash + 1px inset marker, never the
       exclusive current-branch selection treatment. */
    .st-graph-page__lens {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      flex: none;
      padding: var(--st-space-1) var(--st-space-3);
      background: color-mix(in srgb, var(--st-color-ref-branch) 10%, transparent);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      box-shadow: inset 1px 0 0 var(--st-color-ref-branch);
      font-size: var(--st-font-12);
    }

    .st-graph-page__lens-label {
      flex: none;
      color: var(--st-color-muted);
      font-size: var(--st-font-10);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .st-graph-page__lens-ref {
      flex: none;
      color: var(--st-color-ref-branch);
      font-weight: 600;
    }

    .st-graph-page__lens-note {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--st-color-muted);
    }

    .st-graph-page__lens-clear {
      flex: none;
      margin-left: auto;
    }

    .st-graph-page__heading {
      display: flex;
      flex-direction: column;
      /* Eyebrow over title: leading alone separates the two lines. */
      gap: 0;
      flex: none;
      min-width: 0;
    }

    .st-graph-page__eyebrow {
      line-height: 1;
    }

    .st-graph-page__title {
      margin: 0;
      font-size: var(--st-font-13);
      font-weight: 600;
      line-height: var(--st-leading-tight);
    }

    .st-graph-page__search {
      display: flex;
      align-items: center;
      gap: var(--st-space-1);
      flex: 0 1 320px;
      min-width: 120px;
    }

    .st-graph-page__search st-input {
      flex: 1 1 auto;
      min-width: 0;
    }

    .st-graph-page__filter-clear {
      flex: none;
    }

    .st-graph-page__changes {
      flex: none;
      margin-left: auto;
    }

    .st-graph-page__error {
      margin: 0;
      padding: var(--st-space-1) var(--st-space-3);
      font-size: var(--st-font-12);
      color: var(--st-color-danger);
    }

    /* Sticky 24px column header aligned to the virtualized row columns. */
    .st-graph-page__columns {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: none;
      height: var(--st-size-row-tree-dense);
      padding: 0 8px;
      position: sticky;
      top: 0;
      z-index: var(--st-z-sticky);
      background: var(--st-color-surface-2);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      line-height: 1;
    }

    /* Fixed lane gutter: keeps the header columns aligned to the row columns.
       overflow: hidden is a guard only — the column carries no text. */
    .st-graph-page__col-graph {
      flex: none;
      overflow: hidden;
    }

    .st-graph-page__col-message {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Right-aligned to the row dates: the row date column is flex: none
       (natural width), so the header must be pushed to the same right edge. */
    .st-graph-page__col-date {
      flex: 0 0 auto;
      margin-left: auto;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .st-graph-page__list {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
    }

    .st-graph-page__viewport {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
    }

    .st-graph-page__footer {
      flex: none;
      padding: var(--st-space-1) var(--st-space-3);
      border-top: var(--st-hairline) solid var(--st-color-border);
      color: var(--st-color-muted);
      font-size: var(--st-font-11);
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class GraphPage {
  readonly store = inject(GraphStore);
  /** Root, view-only branch lens (ADR-0042); the bar and row dimming read it. */
  readonly lens = inject(BranchLensStore);

  private readonly shortcuts = inject(KeyboardShortcutService);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * Checkout is owned by `RepoState` (the branch-switch confirmation flow and
   * its error banner live in the shell); the graph delegates to it rather than
   * duplicating the flow (ADR-0022 item 1).
   */
  private readonly repoState = inject(RepoState);
  /** Optional: the page is also constructed outside a router (unit spec). */
  private readonly router = inject(Router, { optional: true });

  /** Must match `GRAPH_ROW_HEIGHT` so CDK virtualization delegates row height. */
  readonly rowHeight = GRAPH_ROW_HEIGHT;
  readonly maxLane = computed(() => this.store.maxLane());
  /** Pixel width of the graph column: `(maxLane + 1) * LANE_COLUMN_WIDTH`, shared by the header. */
  readonly graphWidth = computed(() => (this.maxLane() + 1) * LANE_COLUMN_WIDTH);
  /** Current branch of the active repository, shown as the pane-title badge. */
  readonly currentBranch = computed(() => this.repoState.currentBranch());

  readonly filterPlaceholder = $localize`Filter by message, author or oid`;
  readonly clearFilterTitle = $localize`Clear filter`;

  /** Footer counter, e.g. `120 of 2000 commits`. */
  readonly countLabel = computed(() =>
    $localize`${this.store.filteredRows().length} of ${this.store.total()} commits`,
  );
  /** Empty-state heading: distinguishes "no history" from "no filter match". */
  readonly emptyTitle = computed(() =>
    this.store.commits().length === 0
      ? $localize`No commits to display`
      : $localize`No commits match the filter`,
  );
  /** Empty-state supporting line, paired with {@link emptyTitle}. */
  readonly emptyMessage = computed(() =>
    this.store.commits().length === 0
      ? $localize`This repository has no commit history yet.`
      : $localize`Adjust or clear the search to see more commits.`,
  );
  /**
   * Empty-state glyph (the primitive renders `icon()` as text): a mailbox for an
   * empty repository and a distinct search glyph for a filter with no matches.
   * Never a bare word — `st-empty-state` prints its icon value literally.
   */
  readonly emptyIcon = computed(() => (this.store.commits().length === 0 ? '📭' : '🔍'));

  // -- context menu / reset confirmation state -----------------------------
  /** Open context menu anchored at viewport coordinates, or null when closed. */
  readonly contextMenu = signal<{ x: number; y: number; row: CommitRow } | null>(null);
  /** Pending hard-reset target awaiting explicit confirmation, or null. */
  readonly resetConfirm = signal<{ oid: string } | null>(null);
  /** Create-branch dialog state (default start point = menu commit oid), or null. */
  readonly branchDialog = signal<{ startPoint: string } | null>(null);
  /** Create-tag dialog state (default target = menu commit oid), or null. */
  readonly tagDialog = signal<{ target: string } | null>(null);

  /** Ref-mutation busy/error mirrored from the root store for the dialogs. */
  readonly refOpRunning = computed(() => this.repoState.refOpRunning());
  readonly refOpError = computed(() => this.repoState.refOpError());

  /** The commit the open menu points at (null when the row has no oid). */
  readonly contextMenuTarget = computed<GraphContextMenuTarget | null>(() => {
    const menu = this.contextMenu();
    const oid = menu?.row.commit.oid?.hex;
    if (!menu || !oid) return null;
    return { oid, refs: menu.row.commit.refs ?? [] };
  });

  /**
   * "Compare with selected" is a navigation action to the File status screen
   * (ADR-0030 item 4), so it is enabled exactly when its own target is a real
   * commit — the same gate as "File status". The synthetic WIP row has no
   * commit to open and stays disabled.
   */
  readonly canCompare = computed(() => {
    const oid = this.contextMenuTarget()?.oid ?? '';
    return !!oid && oid !== WIP_OID;
  });

  /**
   * Stable CDK identity for row DOM reuse on window shifts: the commit oid hex,
   * falling back to the synthetic WIP pseudo-oid for a row without an oid.
   * A readonly field (not a class expression) keeps the reference stable across
   * change-detection cycles, so the trackBy is not recreated per CD pass.
   */
  readonly trackByRow = (_index: number, row: CommitRow): string =>
    row.commit.oid?.hex ?? WIP_OID;

  /** Bound to the CDK viewport so keyboard navigation can reveal the selection. */
  readonly viewport = viewChild(CdkVirtualScrollViewport);

  /** Guard so a viewport-signal re-run cannot stack `elementScrolled` subscriptions. */
  private scrollBound = false;

  constructor() {
    const store = this.store;
    const unregister = [
      this.shortcuts.register('ArrowDown', () => store.selectNext()),
      this.shortcuts.register('ArrowUp', () => store.selectPrevious()),
    ];
    this.destroyRef.onDestroy(() => unregister.forEach((off) => off()));

    // Centralized scroll-restore queue: `GraphPage` only exists while a
    // repository is open, so tearing it down covers *every* exit path — the
    // detail CTA, the rail WORKSPACE entry, tab switch, deep link and browser
    // navigation. Relying on the explicit calls alone let some paths land at the
    // top of the list.
    this.destroyRef.onDestroy(() => this.queueScrollRestore());

    // Keep the selected row in view as keyboard navigation moves it. `-1` means
    // nothing is selected or the WIP row is (it is pinned outside the viewport),
    // so that path never scrolls.
    effect(() => {
      const index = this.store.selectedIndex();
      if (index >= 0) {
        this.viewport()?.scrollToIndex(index, 'smooth');
      }
    });

    // Bind the viewport's scroll stream once it exists and restore a pending
    // offset on (re)mount. Declared after the selection effect so a restore wins
    // over a same-flush `scrollToIndex` — the whole point of restoring the view.
    effect(() => {
      const viewport = this.viewport();
      this.bindViewportScroll(viewport);
      if (viewport) this.restoreScroll();
    });

    // Branch lens (ADR-0042): a changed scope means a different walk
    // (HEAD ∪ ref), so reload from the top. Only a real value change reloads —
    // the first run is skipped so mounting the page never re-requests the
    // window the store already loaded, and re-running with the same value is a
    // no-op.
    let previousLensRef = this.lens.ref();
    let lensInitialised = false;
    effect(() => {
      const next = this.lens.ref();
      if (!lensInitialised) {
        lensInitialised = true;
        previousLensRef = next;
        return;
      }
      if (next === previousLensRef) return;
      previousLensRef = next;
      untracked(() => {
        // Queue (then deliberately discard, via `reloadForLens`) the previous
        // position: a remembered offset from the old scope must not restore.
        this.queueScrollRestore();
        this.store.reloadForLens();
        this.resetViewportToTop();
      });
    });
  }

  /**
   * Scroll the viewport back to the top after a lens change. Guarded on
   * `Element.scrollTo`: jsdom (unit specs) has no implementation, and the CDK
   * viewport's `scrollToOffset` would throw there.
   */
  private resetViewportToTop(): void {
    const viewport = this.viewport();
    if (!viewport) return;
    if (typeof viewport.elementRef.nativeElement.scrollTo !== 'function') return;
    viewport.scrollToOffset(0);
  }

  /**
   * Bind `elementScrolled` → `store.rememberScrollOffset` exactly once. The
   * viewport is a signal, so this re-runs when CDK (re)creates it; the guard
   * keeps a re-run from stacking a second subscription.
   */
  private bindViewportScroll(viewport: CdkVirtualScrollViewport | undefined): void {
    if (!viewport || this.scrollBound) return;
    this.scrollBound = true;
    viewport
      .elementScrolled()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.store.rememberScrollOffset(viewport.measureScrollOffset()));
  }

  /**
   * Restore the store's pending scroll offset (px) into the viewport once and
   * consume it. Named and public so the unit spec — which constructs the page
   * with no template — can exercise it directly. Without a viewport (unit spec)
   * the pending value is still consumed so it can never leak into a later mount.
   */
  restoreScroll(): number | null {
    const pending = this.store.pendingScrollOffset();
    if (pending === null) return null;
    this.viewport()?.scrollToOffset(pending);
    return this.store.consumeScrollRestore();
  }

  /** Template entry point for the `st-input` primitive's `valueChange` output. */
  onFilterValue(value: string): void {
    this.store.setFilter(value);
  }

  onFilter(event: Event): void {
    this.store.setFilter((event.target as HTMLInputElement).value);
  }

  /** Clear affordance: reset the search field and the store filter. */
  clearFilter(): void {
    this.store.setFilter('');
  }

  /**
   * WIP row activation: select the synthetic working-tree node AND hand off to
   * the File status screen, whose `local` variant shows the changed-file list.
   * Selecting WIP first makes that screen open the working tree (ADR-0029/0030);
   * without a router (unit spec) the selection still applies and navigation
   * degrades to a no-op.
   */
  selectWip(): void {
    this.store.select(WIP_OID);
    this.openChanges();
  }

  /**
   * Commit-row activation. Selecting is always safe; inside a branch lens the
   * click also opens the shared cherry-pick dialog for that commit, because a
   * lens is read-only and cherry-pick is the only mutation offered on a lensed
   * commit (ADR-0042). With no lens the row keeps its select-only behaviour.
   */
  onRowPicked(row: CommitRow): void {
    const oid = row.commit.oid?.hex ?? null;
    this.store.select(oid);
    if (this.lens.active() && oid) this.repoState.openCherryPick(oid);
  }

  /**
   * Queue the remembered viewport offset for restore on the next mount. Public
   * and named so the unit spec — which constructs the page with no template —
   * can exercise it directly; the destroy hook calls it on every exit path.
   */
  queueScrollRestore(): void {
    this.store.requestScrollRestore();
  }

  /**
   * Always-visible toolbar entry: route to the File status screen with no commit
   * selection, so it opens the `local` (working tree) variant — the same target
   * as the sidebar WORKSPACE "File status" entry.
   */
  openChanges(): void {
    // Leaving the graph: remember the viewport so returning restores it (plan §4.6).
    this.queueScrollRestore();
    void this.router?.navigate(['/repo', 'file-status']);
  }

  /** Infinite scroll: prefetch when the rendered range approaches the loaded end. */
  onScrolledIndexChange(index: number): void {
    if (index >= this.store.filteredRows().length - GRAPH_PREFETCH_THRESHOLD) {
      this.store.loadMore();
    }
  }

  // -- context menu actions ------------------------------------------------

  /** Open the menu for a commit row at the pointer, clamped into the viewport. */
  onRowContextMenu(event: MouseEvent, row: CommitRow): void {
    if (!row.commit.oid?.hex) return;
    event.preventDefault();
    const x = Math.max(0, Math.min(event.clientX, window.innerWidth - 220));
    const y = Math.max(0, Math.min(event.clientY, window.innerHeight - 260));
    this.contextMenu.set({ x, y, row });
  }

  closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  /** Checkout delegates to the existing branch-switch flow (RepoState). */
  onCheckout(target: CheckoutTarget): void {
    this.closeContextMenu();
    void this.repoState.checkoutBranch(target.refName, target.isRemote);
  }

  /**
   * "Compare with selected" (ADR-0030 item 4): no diff is rendered in History.
   * The entry is a navigation shortcut that reuses the "File status" hand-off —
   * select the menu commit in the shared store, then route to the screen whose
   * `commit` variant diffs it against its first parent.
   */
  onCompare(): void {
    const target = this.contextMenuTarget();
    if (!target) return;
    this.onFileStatus(target.oid);
  }

  /**
   * "File status" (ADR-0029): select the menu commit in the shared graph store,
   * then route to the file-status screen, which reads that selection to choose
   * its variant. The router is optional so the page also stays constructible
   * outside a routing context (its unit spec drives the wiring through the
   * component instance); with no router the commit is still selected and the
   * navigation degrades to a no-op.
   */
  onFileStatus(oid: string): void {
    this.closeContextMenu();
    if (!oid || oid === WIP_OID) return;
    this.store.select(oid);
    // Leaving the graph: hand the viewport offset to the next mount (plan §4.6).
    this.queueScrollRestore();
    void this.router?.navigate(['/repo', 'file-status']);
  }

  /** Copy SHA is renderer-only: no IPC round-trip (ADR-0022 item 2). */
  onCopySha(oid: string): void {
    this.closeContextMenu();
    void this.copyToClipboard(oid);
  }

  /**
   * Lens-tier cherry-pick: close the menu and hand the source oid to
   * `RepoState`, which owns the shared dialog state. R2 owns the mutation and
   * the dialog component; this page only opens it.
   */
  onLensCherryPick(oid: string): void {
    this.closeContextMenu();
    this.repoState.openCherryPick(oid);
  }

  /**
   * Reset entries: soft/mixed run immediately; hard opens the confirmation gate
   * first (ADR-0021 item 3) and only runs once the user confirms.
   */
  onReset(mode: ResetModeName): void {
    const target = this.contextMenuTarget();
    this.closeContextMenu();
    if (!target) return;
    if (mode === 'HARD') {
      this.resetConfirm.set({ oid: target.oid });
      return;
    }
    void this.store.reset(target.oid, mode);
  }

  onResetConfirmed(): void {
    const confirm = this.resetConfirm();
    this.resetConfirm.set(null);
    if (confirm) void this.store.reset(confirm.oid, 'HARD');
  }

  onResetCancelled(): void {
    this.resetConfirm.set(null);
  }

  // -- create branch / tag at a commit (ADR-028) ---------------------------

  /** "Create branch here…" opens the dialog prefilled with the commit oid. */
  onCreateBranchHere(oid: string): void {
    this.closeContextMenu();
    this.repoState.clearRefOpError();
    this.branchDialog.set({ startPoint: oid });
  }

  onBranchCreateSubmitted(value: BranchCreateValue): void {
    void this.repoState.createBranch(value.name, value.startPoint, value.checkout).then((ok) => {
      if (ok) this.branchDialog.set(null);
    });
  }

  onBranchCreateCancelled(): void {
    this.branchDialog.set(null);
    this.repoState.clearRefOpError();
  }

  /** "Tag this commit…" opens the dialog prefilled with the commit oid. */
  onTagCommit(oid: string): void {
    this.closeContextMenu();
    this.repoState.clearRefOpError();
    this.tagDialog.set({ target: oid });
  }

  /**
   * "Revert this commit…" runs on the checked-out branch (ADR-0042), so no
   * dialog is needed: `RepoState` performs the revert and, on a conflict,
   * surfaces it through the shared conflict banner.
   */
  onRevert(oid: string): void {
    this.closeContextMenu();
    this.repoState.clearRefOpError();
    void this.repoState.revert(oid);
  }

  onTagCreateSubmitted(value: TagCreateValue): void {
    void this.repoState
      .createTag(value.name, value.target, value.annotated, value.message, value.force)
      .then((ok) => {
        if (ok) this.tagDialog.set(null);
      });
  }

  onTagCreateCancelled(): void {
    this.tagDialog.set(null);
    this.repoState.clearRefOpError();
  }

  /**
   * Copy `text` to the clipboard, preferring the async Clipboard API and
   * falling back to a hidden textarea + `execCommand` when it is unavailable
   * (jsdom, insecure contexts). Never throws; returns whether it succeeded.
   */
  async copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return this.copyFallback(text);
    }
  }

  private copyFallback(text: string): boolean {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
}
