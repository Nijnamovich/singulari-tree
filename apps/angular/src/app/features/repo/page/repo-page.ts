import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { Repository } from '@contracts/domain';
import { WorkspaceSplitComponent } from '@singularitree/ui-kit';
import { CommitFocusService } from '@core/services/commit-focus.service';
import { IpcBridge } from '@core/services/ipc-bridge.service';
import { PreferencesService } from '@core/services/preferences.service';
import { RepoState } from '@core/services/repo-state.service';
import { WorkspacesStore } from '@core/services/workspaces.store';
import { CommitViewModeService } from '../commit-view-mode.service';
import { GraphStore } from '../graph/graph.store';
import { CommitDetailsPanel } from '../graph/ui/commit-details-panel';
import { GraphPage } from '../graph/page/graph-page';
import { StatusStore } from '../status/status.store';
import { RepoPicker } from '../ui/repo-picker';
import { RepoRelocatePanel } from '../ui/repo-relocate-panel';

/**
 * Routed repository page: the History workspace. It mounts the shared
 * `st-workspace-split` (pinned commit-detail pane + flexible graph pane) and
 * first-run `st-repo-picker` empty state.
 *
 * It also hydrates the route-scoped `GraphStore` from the root `RepoState`: the
 * repository list route only calls `RepoState.setActive()` (or opens the repo
 * itself) before navigating here, so without this sync the graph would stay
 * empty until the user re-picked from the in-page picker.
 *
 * The split's detail pane is wired to the persisted pane-width preference so a
 * resize survives reloads.
 */
@Component({
  selector: 'st-repo-page',
  standalone: true,
  imports: [
    WorkspaceSplitComponent,
    CommitDetailsPanel,
    RepoPicker,
    RepoRelocatePanel,
    GraphPage,
  ],
  template: `
    <st-workspace-split [showDetail]="showDetail()" [detailTitle]="detailTitle()" [detailWidth]="detailWidth()" [resizable]="true" (detailWidthResized)="setPaneWidth($event)">
      <st-commit-details-panel
        detail
        [commit]="selectedCommit()"
        [isWip]="isWipSelected()"
        [changedFiles]="changedFiles()"
        [showCta]="true"
        [showFiles]="true"
        [showViewSwitch]="true"
        [mode]="viewMode.mode()"
        [navMode]="'release'"
        [locked]="graphStore.lockedOid() === selectedCommit()?.oid?.hex"
        (reviewChanges)="openChanges()"
        (lockToggle)="toggleLock()"
        (modeChange)="viewMode.setMode($event)"
        (release)="releaseCommit()"
      />
      <!--
        Recovery wins over the picker: GraphStore.openRepository leaves repoId()
        null on failure, so without this branch a missing repo would silently
        fall back to the first-run picker — the exact "did not detect the error"
        complaint. The recovery panel names the state and offers the
        relocate/remove fallbacks instead of deleting the registration.
      -->
      @if (relocateRepo(); as repo) {
        <st-repo-relocate-panel
          [repo]="repo"
          [reason]="relocateReason()"
          [busy]="relocating()"
          (relocated)="onRelocated($event)"
          (removed)="onRemoved()"
        />
      } @else if (graphStore.repoId()) {
        <st-graph-page />
      } @else {
        <st-repo-picker />
      }
    </st-workspace-split>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      color: var(--st-color-text);
    }

    /* The split fills the routed host; the graph/picker fills the primary pane. */
    :host st-workspace-split {
      flex: 1 1 auto;
      min-height: 0;
    }

    /*
      The History aside's commit panel IS the detail pane: it must fill the
      split's detail body so its content region is the only scroller and its
      metadata footer stays pinned to the bottom. The split's detail body is a
      definite-height flex column, so flex: 1 1 auto + min-height: 0 is all
      the panel needs to stretch without overflowing.
    */
    :host st-commit-details-panel {
      flex: 1 1 auto;
      min-height: 0;
    }

    :host st-graph-page,
    :host st-repo-picker,
    :host st-repo-relocate-panel {
      flex: 1 1 auto;
      min-height: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepoPage {
  private readonly repoState = inject(RepoState);
  readonly graphStore = inject(GraphStore);
  /**
   * Route-scoped `description | files` choice shared with the File-status
   * analyzer, so a pick on either surface survives the screen change.
   */
  protected readonly viewMode = inject(CommitViewModeService);
  private readonly commitFocus = inject(CommitFocusService);
  private readonly bridge = inject(IpcBridge);
  private readonly workspaces = inject(WorkspacesStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly prefs = inject(PreferencesService);
  /**
   * The route-scoped `StatusStore` (the same instance `FileStatusStore` composes),
   * used read-only for the History aside's inline expandable changed-file panel
   * (ADR-0033) and to observe `graphReloadRequested` so a commit's post-commit
   * graph reload survives navigating away from the File-status screen.
   */
  private readonly status = inject(StatusStore);
  /**
   * Optional: the page is also constructed outside a router (unit spec), so the
   * primary CTA's navigation degrades to a no-op there.
   */
  private readonly router = inject(Router, { optional: true });

  /**
   * Commit rendered by the pinned detail pane: the LOCKED commit when one is
   * held, otherwise the selected row's commit.
   *
   * The graph lock captures the commit at lock time, so a reload (or a filter)
   * that drops the row out of the loaded window keeps the pinned pane rendering
   * the locked commit instead of blanking to "select a commit".
   */
  readonly selectedCommit = computed(
    () => this.graphStore.lockedCommit() ?? this.graphStore.selectedRow()?.commit ?? null,
  );
  /** Whether the synthetic working-tree (WIP) node is the current selection. */
  readonly isWipSelected = computed(() => this.graphStore.isWipSelected());
  /** The detail pane is pinned whenever any row (commit or WIP) is selected. */
  readonly showDetail = computed(() => this.graphStore.selectedOid() !== null);
  /** Header label of the pinned detail pane. */
  readonly detailTitle = computed(() =>
    this.isWipSelected() ? $localize`Working tree` : $localize`Commit`,
  );

  /**
   * The persisted `st:paneWidth` drives the pinned commit-detail pane; `null`
   * keeps the 380px token default.
   */
  readonly detailWidth = computed<string | null>(() => {
    const width = this.prefs.paneWidth();
    return width ? `${width}px` : null;
  });

  /**
   * The active repository whose folder could not be opened, or null.
   *
   * `GraphStore.error.code` is a plain string (not an enum), matched here by its
   * core error codes. Recovery is only offered while the *active* repo's folder
   * is the problem, so an unrelated stale graph error never blocks the picker.
   */
  readonly relocateRepo = computed<Repository | null>(() => {
    const code = this.graphStore.error()?.code;
    if (code !== 'REPO_PATH_MISSING' && code !== 'NOT_A_GIT_REPO') return null;
    return this.repoState.activeRepo();
  });

  /** 'missing' when the recorded folder is gone; 'not-a-repo' when it exists but isn't a Git repo. */
  readonly relocateReason = computed<'missing' | 'not-a-repo'>(() =>
    this.graphStore.error()?.code === 'NOT_A_GIT_REPO' ? 'not-a-repo' : 'missing',
  );

  /** True while the graph is being reopened after an explicit relocation. */
  readonly relocating = signal(false);

  /**
   * True while a relocation owns the graph open. `onRelocated` opens the graph
   * explicitly; this gate suppresses the hydration effect for that window so
   * `setActive` — which replaces the repo object and re-runs the effect — cannot
   * race a second `openRepository`.
   */
  private readonly relocateOpening = signal(false);

  /** Last observed `RepoState.statusRefreshRequested` token (dedupes the effect). */
  private lastStatusRefresh = this.repoState.statusRefreshRequested();

  /**
   * Changed-file paths of the selected commit, for the aside's read-only
   * inline expandable panel (ADR-0033). Empty for the WIP row and for a cleared
   * selection; the panel owns the disclosure, this page owns the read.
   */
  readonly changedFiles = signal<readonly string[]>([]);

  /**
   * Monotonic token guarding the async file-list read: a response whose commit
   * is no longer selected is dropped instead of overwriting the current list.
   */
  private changedFilesSeq = 0;

  constructor() {
    // Sync the active repo into the route-scoped graph. `openRepository` is not
    // idempotent (it refreshes `last_opened_at`), so guard by id and only open
    // when the graph currently points at a different repository.
    //
    // The gate skips this while a relocation owns the open (see `onRelocated`):
    // `setActive` swaps the repo object, so without it the effect would fire a
    // second `openRepository` that races the explicit one.
    //
    // The same effect consumes a pending deep-link commit focus: once
    // the matching repository is open it selects (and, if needed, pages to) the
    // requested commit. A focus for the already-open repo is handled in place.
    effect(() => {
      if (this.relocateOpening()) return;
      const active = this.repoState.activeRepo();
      const pending = this.commitFocus.pending();
      if (!active) return;

      if (this.graphStore.repoId() === active.id) {
        if (pending && pending.repoId === active.id) {
          this.commitFocus.clear();
          void this.graphStore.focusCommit(pending.oid);
        }
        return;
      }

      void this.graphStore.openRepository(active.fsPath).then(() => {
        // A superseded open installs nothing (openSeq). Never consume a stale
        // repo's deep-link focus then: `select()` would persist its oid under the
        // repo that actually won the switch.
        if (this.graphStore.repoId() !== active.id) return;
        const oid = this.commitFocus.consume(active.id);
        if (oid) void this.graphStore.focusCommit(oid);
      });
    });

    // A ref mutation that may have moved HEAD or dirtied the tree (a checkout on
    // branch create, a merge — ADR-028) used to be observed by `StatusWorkspace`,
    // the band ADR-0030 item 1 removed. Its graph half lives here now: the
    // History screen must not show a stale window after HEAD moves. The
    // working-tree half of the same token is owned by `FileStatusPage`.
    effect(() => {
      const token = this.repoState.statusRefreshRequested();
      if (token === this.lastStatusRefresh) return;
      this.lastStatusRefresh = token;
      this.graphStore.reload();
    });

    // External file changes invalidate the graph window — the reload
    // `StatusWorkspace` fired on `fs:changed` before the band was removed.
    const unsubscribe = this.bridge.onFsChanged(() => this.graphStore.reload());
    this.destroyRef.onDestroy(unsubscribe);

    // A successful commit bumps the route-scoped `StatusStore.graphReloadRequested`
    // (StatusStore.commit). Its other consumer is a PAGE-scoped effect in
    // `FileStatusPage` that dies the moment the user navigates to History, so a
    // commit made there could leave the graph window stale. Consuming the SAME
    // route-scoped signal here makes the post-commit reload navigation-proof:
    // RepoPage observes the (already-bumped) token on mount and reloads, so the
    // new commit is visible on return regardless of which screen performed it.
    effect(() => {
      if (this.status.graphReloadRequested() > 0) this.graphStore.reload();
    });

    // ADR-0033: the aside's inline expandable changed-file panel. Point the route-scoped
    // `StatusStore` at the open repository (mirroring `FileStatusPage`) and,
    // when a real commit is selected, read its first-parent / empty-tree file
    // list. The read is deliberately non-mutating (`readCommitChangedFiles`), so
    // it never disturbs the File-status viewer or its staging substrates, and
    // `headOid` is not needed — the read takes its `from`/`to` explicitly. The
    // WIP row and a cleared selection both clear the list; the monotonic token
    // drops a late response for a commit that is no longer selected.
    effect(() => {
      const repoId = this.graphStore.repoId();
      this.status.setRepoId(repoId);

      const commit = this.selectedCommit();
      const seq = ++this.changedFilesSeq;
      if (!repoId || !commit) {
        this.changedFiles.set([]);
        return;
      }
      void this.status.readCommitChangedFiles(commit).then((paths) => {
        if (seq !== this.changedFilesSeq) return;
        this.changedFiles.set(paths);
      });
    });
  }

  /**
   * Detail-pane primary CTA: route to the File status screen, which reads the
   * shared graph store's selection to choose its variant (ADR-0029/0030).
   *
   * Defence-in-depth for the headline path: `GraphPage`'s destroy hook also
   * queues the restore, and this explicit call keeps the CTA correct even if the
   * pane is ever unmounted in a way that skips that hook.
   */
  openChanges(): void {
    this.graphStore.requestScrollRestore();
    void this.router?.navigate(['/repo', 'file-status']);
  }

  /**
   * The split emits pixels and the service owns persistence/validation, so this
   * only rounds the value and forwards it.
   */
  setPaneWidth(width: number): void {
    this.prefs.setPaneWidth(String(Math.round(width)));
  }

  /**
   * The recovery panel relocated the active repository. The id is unchanged, so
   * `openTab` refreshes the tab's cached path in place (no duplicate tab) and
   * `setActive` keeps the single active-repo source of truth on it.
   *
   * `openRepository` is then called *directly* while `relocateOpening` gates the
   * hydration effect. `setActive` REPLACES the repo object inside `repos`, so
   * `activeRepo()` yields a new reference and the effect re-runs; the failed open
   * left `repoId()` null, so an ungated effect would call `openRepository` itself
   * and race this explicit one. The gate keeps a single open. On success
   * `loadWindow` clears the error, the graph renders and the panel disappears.
   */
  onRelocated(repo: Repository): void {
    this.relocateOpening.set(true);
    this.workspaces.openTab(repo);
    this.repoState.setActive(repo);
    this.relocating.set(true);
    void this.graphStore.openRepository(repo.fsPath).finally(() => {
      this.relocateOpening.set(false);
      this.relocating.set(false);
    });
  }

  /**
   * The recovery panel removed the active repository explicitly. `removeRepository`
   * already cleared `activeId`, so the picker is what renders next; nothing else
   * to do here — and, crucially, this is only reached by the user's own action.
   */
  onRemoved(): void {
    // No-op by design; kept as the panel's explicit-intent seam.
  }

  /**
   * Item 7a: release the pinned selection. `release()` clears the graph lock and
   * the selection together, so the padlock and the aside both reset.
   */
  releaseCommit(): void {
    this.graphStore.release();
  }

  /**
   * Toggle the graph lock: pin the current real-commit selection, or release the
   * lock while keeping the selection (the padlock's on/off intent).
   */
  toggleLock(): void {
    if (this.graphStore.lockedOid()) {
      this.graphStore.unlock();
    } else {
      this.graphStore.lock();
    }
  }
}
