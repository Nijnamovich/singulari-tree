import { Injectable, computed, inject, signal } from '@angular/core';
import type { Commit, CommitStats, Lane, Repository } from '@contracts/domain';
import type { GetCommitsRequest, GetCommitsResponse, ResetRequest } from '@contracts/gitcore';
import { BranchLensStore } from '@core/services/branch-lens.store';
import { GraphSessionStore } from '@core/services/graph-session.store';
import { IpcBridge, toAppError, type AppError } from '@core/services/ipc-bridge.service';
import { LiveRegionService } from '@singularitree/ui-kit';
import type { CommitRow } from '../repo-models';
import { filterRows, joinRows, mapPageLanes, maxLaneIndex } from '../repo-mappers';
import type { ResetModeName } from './graph-menu.models';

/** Pseudo-oid for the synthetic working-tree (uncommitted) node. UI-only: no IPC. */
export const WIP_OID = 'worktree';

/** Visible window (rows kept in memory) — matches the Go cache LRU window. */
export const GRAPH_WINDOW_SIZE = 200;
/** Extra rows fetched ahead of the window to hide fetch latency. */
export const GRAPH_PREFETCH = 100;
/** Trigger prefetch when the rendered range is within this many rows of the end. */
export const GRAPH_PREFETCH_THRESHOLD = 20;
/** Max extra windows loaded to reveal a commit requested by a focus hand-off. */
export const COMMIT_FOCUS_MAX_LOADS = 10;

function isIpcUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'IPC_UNAVAILABLE'
  );
}

/**
 * Read the root `LiveRegionService` when one exists, else `null`.
 *
 * The graph lock announces through the shared status-bar live region, but the
 * store is also constructed directly (`new GraphStore(bridge)`) in unit tests
 * with no DI context at all — a bare `inject()` would throw NG0203 there. The
 * `try/catch` + `{ optional: true }` pair makes the announcement a best-effort
 * side channel: outside a real app it simply degrades to silence, and the lock
 * semantics themselves never depend on the region being present.
 */
function safeInjectLiveRegion(): LiveRegionService | null {
  try {
    return inject(LiveRegionService, { optional: true });
  } catch {
    return null;
  }
}

/**
 * Read the root `GraphSessionStore` when one exists, else `null`.
 *
 * Mirrors {@link safeInjectLiveRegion}: the store is also constructed directly
 * (`new GraphStore(bridge)`) in unit tests with no DI context, where a bare
 * `inject()` would throw NG0203. Persistence is a best-effort side channel —
 * outside a real app the graph simply behaves as it did before the session
 * store existed (open blanks the selection/lock, mutators do not save).
 */
function safeInjectGraphSession(): GraphSessionStore | null {
  try {
    return inject(GraphSessionStore, { optional: true });
  } catch {
    return null;
  }
}

/**
 * Read the root `BranchLensStore` when one exists, else `null`.
 *
 * Mirrors {@link safeInjectGraphSession}: the store is also constructed
 * directly (`new GraphStore(bridge)`) in unit tests with no DI context, where a
 * bare `inject()` would throw NG0203. Without a lens store the graph simply
 * sends an empty `refs` scope — exactly the pre-lens behaviour.
 */
function safeInjectBranchLens(): BranchLensStore | null {
  try {
    return inject(BranchLensStore, { optional: true });
  } catch {
    return null;
  }
}

/**
 * Signal store for the commit graph (service-design.md §2.2/§3).
 *
 * Owns the windowed `getCommits` pagination (window 200 + prefetch 100) and the
 * parallel `commits`/`lanes` arrays from the Go core. The bridge is a constructor
 * parameter (defaulting to DI) so the store can be unit-tested without TestBed.
 *
 * Selection/lock state is route-scoped but hydrated from the root in-memory
 * `GraphSessionStore`: route destruction (leaving `/repo`) recreates this store,
 * and opening another repo tab re-installs the same instance, so each repo's
 * selection/padlock is restored from the root session instead of being blanked.
 */
@Injectable()
export class GraphStore {
  private readonly bridge: IpcBridge;
  /**
   * Root-scoped announcer for lock rejections, captured once at construction
   * (see {@link safeInjectLiveRegion}); `null` in plain unit tests.
   */
  private readonly liveRegion: LiveRegionService | null;
  /**
   * Root-scoped, in-memory session state for selection/lock, captured once at
   * construction (see {@link safeInjectGraphSession}); `null` in plain unit
   * tests, where the store degrades to the original non-persisting behaviour.
   */
  private readonly graphSession: GraphSessionStore | null;
  /**
   * Root-scoped, view-only branch lens (ADR-0042), captured once at
   * construction (see {@link safeInjectBranchLens}); `null` in plain unit
   * tests, where the request simply carries an empty `refs` scope.
   */
  private readonly lens: BranchLensStore | null;

  constructor(
    bridge: IpcBridge = inject(IpcBridge),
    graphSession: GraphSessionStore | null = safeInjectGraphSession(),
    lens: BranchLensStore | null = safeInjectBranchLens(),
  ) {
    this.bridge = bridge;
    this.liveRegion = safeInjectLiveRegion();
    this.graphSession = graphSession;
    this.lens = lens;
  }

  readonly windowSize = GRAPH_WINDOW_SIZE;
  readonly prefetch = GRAPH_PREFETCH;

  // -- state ---------------------------------------------------------------
  /**
   * Monotonic request sequence for `loadWindow`.
   *
   * Overlapping reloads are normal: every working-tree mutation
   * (stage/unstage/commit) fires `fs:changed`, coalesced by the core watcher's
   * 150ms debounce into `FileStatusPage.refreshForExternalChange()`, and a
   * successful commit additionally bumps `graphReloadRequested`; both call
   * `reload()`. Without a guard the *last response to resolve* wins rather than
   * the last request, so on a slow CI box an earlier `getCommits` — served from
   * the pre-invalidation L1 cache window and thereby missing the new commit — can
   * land after the post-commit one and install a stale page. Only the newest
   * request is allowed to touch the state signals.
   */
  private loadSeq = 0;

  /**
   * Monotonic request sequence for `openRepository`.
   *
   * Switching repo tabs can issue a new open before the previous one resolved;
   * without a guard the *last open to resolve* wins rather than the last one
   * requested, so a slow open from a tab the user already left could re-install
   * its `repoId`, clear the newer selection and `startWatch` the wrong repo.
   * Claimed before the `openRepository` invoke and re-checked after it settles:
   * only the newest open may touch state.
   */
  private openSeq = 0;

  readonly repoId = signal<string | null>(null);
  readonly commits = signal<Commit[]>([]);
  /** Normalized to one entry per commit (index-aligned with `commits`). */
  readonly lanes = signal<Lane[]>([]);
  /**
   * Oids the branch lens reports as reachable from the lensed ref (ADR-0042),
   * derived from the parallel `inRefs` array. Empty when no lens is active, so
   * every row renders exactly as before.
   */
  readonly lensOids = signal<ReadonlySet<string>>(new Set());
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly loading = signal(false);
  readonly error = signal<AppError | null>(null);
  readonly selectedOid = signal<string | null>(null);
  readonly filter = signal('');

  // -- commit selection lock (padlock) -------------------------------------
  /**
   * Oid of the pinned commit, or null when the padlock is open.
   *
   * The graph lock keeps ONE real commit selected across navigation between
   * `/repo` (History) and `/repo/file-status` and refuses every other graph
   * click until released. It lives here — on the route-scoped store shared by
   * both screens — because the File-status screen follows this selection (and
   * the pinned commit-detail pane reads {@link lockedCommit}) through effects
   * on the same instance. Route destruction/recreation rehydrates it from the
   * root `GraphSessionStore` in {@link openRepository}.
   */
  readonly lockedOid = signal<string | null>(null);
  /**
   * The `Commit` captured at lock time. Held separately from `lockedOid` on
   * purpose: `reload()` / `loadWindow()` / `applyPage()` never touch the lock,
   * so when the locked commit falls out of the freshly loaded window the cached
   * object still renders the pinned detail pane instead of blanking to
   * "select a commit".
   */
  readonly lockedCommit = signal<Commit | null>(null);

  /** Recently opened repositories (from `listRepositories`), newest first. */
  readonly recentRepos = signal<Repository[]>([]);
  /** True when the renderer runs without the Electron preload bridge. */
  readonly offline = signal(false);

  // -- CDK viewport scroll memory ------------------------------------------
  /**
   * Remembered CDK viewport scroll offset (px) for the current repository and
   * filter. In-memory only: the store is provided on the shared `repo.routes.ts`
   * parent, so its lifetime spans `/repo` ↔ `/repo/file-status` and no
   * `localStorage` round-trip is needed. The synthetic WIP row is pinned
   * *outside* the viewport, so this value is always a plain pixel offset and
   * never encodes the WIP row.
   */
  readonly scrollOffset = signal(0);
  /** Pending offset to restore on the next graph mount, or null when none is queued. */
  private readonly pendingRestore = signal<number | null>(null);
  /** Read-only view of the pending restore offset (null when nothing is queued). */
  readonly pendingScrollOffset = computed(() => this.pendingRestore());

  // -- commit change-size gauge (ADR-0023) ---------------------------------
  /** Counts per oid, lazily fetched for the visited window and cached. */
  readonly commitStats = signal<ReadonlyMap<string, CommitStats>>(new Map());
  /** Last non-IPC failure while loading the gauge, or null. */
  readonly statsError = signal<AppError | null>(null);

  // -- reset (ADR-0021) ----------------------------------------------------
  /** True while a `reset` call is in flight. */
  readonly resetRunning = signal(false);
  /** Last reset failure, or null when idle/successful. */
  readonly resetError = signal<AppError | null>(null);

  // -- derived -------------------------------------------------------------
  readonly rows = computed<CommitRow[]>(() => joinRows(this.commits(), this.lanes()));
  readonly filteredRows = computed<CommitRow[]>(() => filterRows(this.rows(), this.filter()));
  readonly maxLane = computed(() => maxLaneIndex(this.rows()));
  readonly hasMore = computed(() => this.commits().length < this.total());
  readonly isLoading = computed(() => this.loading());
  readonly isWipSelected = computed(() => this.selectedOid() === WIP_OID);
  readonly selectedRow = computed<CommitRow | null>(() => {
    const oid = this.selectedOid();
    if (!oid || oid === WIP_OID) return null;
    return this.rows().find((row) => row.commit.oid?.hex === oid) ?? null;
  });
  /**
   * Index of the selected row within `filteredRows()`; -1 when nothing is
   * selected, the synthetic WIP node is selected, or the selected oid is
   * filtered out / absent.
   */
  readonly selectedIndex = computed<number>(() => {
    const oid = this.selectedOid();
    if (!oid || oid === WIP_OID) return -1;
    return this.filteredRows().findIndex((row) => row.commit.oid?.hex === oid);
  });

  /**
   * Cached gauge for one oid, or null when it has not been measured yet. A
   * missing entry is rendered as "no gauge" (never a zeroed placeholder).
   */
  statsFor(oid: string | undefined): CommitStats | null {
    if (!oid) return null;
    return this.commitStats().get(oid) ?? null;
  }

  // -- actions -------------------------------------------------------------

  /**
   * Open a repository by filesystem path and load its first commit window.
   *
   * Contract: a failed open leaves NO repository open. The graph is reset to the
   * empty state (`repoId()` null, no commits/selection/filter, viewport offset
   * and gauge cache reset), so a previous repo's window can never survive —
   * this is what makes `RepoPage`'s `repoId()` gate route to the relocate
   * panel / picker instead of keeping the old tree mounted. A superseded open
   * (the user switched tabs before it resolved) installs nothing and never
   * starts a watch for the wrong repo.
   *
   * A successful open restores the target repo's selection and padlock from the
   * root session store (each repo tab has its own saved state); with no saved
   * entry this is the original null/empty state. A failed open clears only the
   * live signals — the saved session for that repo is deliberately kept, so a
   * later successful open can still restore it.
   *
   * Returns the opened repository, or null when it was superseded or failed.
   */
  async openRepository(fsPath: string): Promise<Repository | null> {
    // Claim the newest sequence before awaiting: a later open supersedes this
    // one, and only the newest may install its repo (see `openSeq`).
    const seq = ++this.openSeq;
    try {
      const repo = await this.bridge.invoke('openRepository', { fsPath });
      // Superseded while in flight: install nothing, so a late open cannot
      // clobber the newer repo's identity, selection, window or watch.
      if (seq !== this.openSeq) return null;
      this.offline.set(false);
      this.repoId.set(repo.id);
      // Restore this repo's own saved selection/padlock (or the null/empty state
      // when it has none). Never write back here: opening is not a user-driven
      // selection change and must not overwrite another tab's saved state.
      this.restoreSession(repo.id);
      this.filter.set('');
      // A different repository invalidates the remembered graph position: both
      // the offset and any pending restore are scoped to the old repo.
      this.scrollOffset.set(0);
      this.pendingRestore.set(null);
      // Clear the previous repo's rows synchronously, before the new window
      // loads: `repoId` already names the new repo, so leaving the old rows in
      // place would briefly render them under the new repo's identity. The
      // successful `loadWindow(0)` repopulates immediately after.
      this.commits.set([]);
      this.lanes.set([]);
      this.lensOids.set(new Set());
      this.total.set(0);
      await this.loadWindow(0);
      // Refresh the picker's recents now that this repo is the most recent.
      await this.loadRecentRepos();
      // A newer open may have superseded this one while loading; it owns the
      // watch, so this stale open stops here without starting watch/wrong-repo.
      if (seq !== this.openSeq) return null;
      // Start the repository-scoped background watch: `fs:changed` drives the
      // graph/status refresh both repo screens subscribe to. Fire-and-forget — a
      // missing bridge or a failing watch can never fail the open.
      this.startWatch(repo.id);
      return repo;
    } catch (err) {
      // Superseded failure: a newer open owns the state, so do not blank its
      // graph or record a stale error.
      if (seq !== this.openSeq) return null;
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
      } else {
        this.error.set(toAppError(err));
      }
      // A failed open leaves NO repository open: reset the graph to the empty
      // state so no other repo's commits/lanes/selection can survive it.
      this.repoId.set(null);
      this.commits.set([]);
      this.lanes.set([]);
      // The lens scope is scoped to the repo that just failed to open: its
      // highlighted oids cannot survive the empty-state reset.
      this.lensOids.set(new Set());
      this.total.set(0);
      this.selectedOid.set(null);
      // The failed repo is gone, so its lock goes with it — a stale pinned
      // commit must never outlive the repository it pointed at.
      this.resetLock();
      this.filter.set('');
      this.scrollOffset.set(0);
      this.pendingRestore.set(null);
      // Complete the empty-state reset: the viewport offset and the cached gauge
      // are scoped to the failed repo too, so neither can survive it.
      this.offset.set(0);
      this.commitStats.set(new Map());
      return null;
    }
  }

  /**
   * Load the recently opened repositories. Degrades to an empty list when the
   * Electron bridge is unavailable (plain browser session); records any other
   * failure on the `error` signal.
   */
  async loadRecentRepos(): Promise<void> {
    try {
      const resp = await this.bridge.invoke('listRepositories', {});
      this.offline.set(false);
      this.recentRepos.set(resp.repositories ?? []);
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
        this.recentRepos.set([]);
      } else {
        this.error.set(toAppError(err));
      }
    }
  }

  /**
   * Load a commit window at `offset`. `offset <= 0` replaces the current page
   * (reload); a positive offset appends (infinite scroll).
   */
  async loadWindow(offset: number): Promise<void> {
    const id = this.repoId();
    if (!id) return;

    // Claim the newest sequence before awaiting: a later loadWindow supersedes
    // this one, and only the newest response may mutate state (see `loadSeq`).
    const seq = ++this.loadSeq;

    this.loading.set(true);
    this.error.set(null);

    const req: GetCommitsRequest = {
      repoId: id,
      offset,
      limit: this.windowSize + this.prefetch,
      // View-only ref scope (ADR-0042): empty means the plain HEAD walk.
      refs: this.lens?.refs() ?? [],
    };

    try {
      const resp = await this.bridge.invoke('getCommits', req);
      // Superseded while in flight: drop the stale page instead of clobbering
      // the newer one.
      if (seq !== this.loadSeq) return;
      this.offline.set(false);
      this.applyPage(offset, resp);
    } catch (err) {
      // Superseded failure: it must not clobber the newer page's `error`, and an
      // IPC_UNAVAILABLE must not blank the screen either.
      if (seq !== this.loadSeq) return;
      if (isIpcUnavailable(err)) {
        // Degrade to an empty page instead of crashing a plain browser session.
        this.offline.set(true);
        if (offset <= 0) this.applyPage(0, { commits: [], total: 0, lanes: [], inRefs: [] });
      } else {
        this.error.set(toAppError(err));
      }
    } finally {
      // Only the newest request owns `loading`; a superseded one must not report
      // completion while a newer window is still in flight. The newest request
      // always reaches this branch, so `loading` can never stay stuck true.
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  /** Fetch the next window when the viewport approaches the end of loaded rows. */
  loadMore(): void {
    if (this.loading() || !this.repoId() || !this.hasMore()) return;
    void this.loadWindow(this.commits().length);
  }

  /** Invalidate and reload the first window (fs:changed / HEAD move). */
  reload(): void {
    void this.loadWindow(0);
  }

  /**
   * Reload from offset 0 after the branch lens changed (ADR-0042).
   *
   * A lens switches the walk to a different ref scope, so the remembered CDK
   * viewport offset (and any pending restore) belongs to the previous scope and
   * must go: the new walk always starts at the top.
   */
  reloadForLens(): void {
    this.scrollOffset.set(0);
    this.pendingRestore.set(null);
    void this.loadWindow(0);
  }

  /**
   * Ask the shell to start the background `Watch` stream for `repoId`.
   * Fire-and-forget: the ack resolves immediately and a missing bridge or a
   * failing watch degrades to this store's own offline/error state, so it can
   * never fail the repository open. Relocated from `StatusWorkspace` when
   * ADR-0030 removed the band `RepoPage` no longer mounts.
   */
  private startWatch(repoId: string): void {
    try {
      void this.bridge.invoke('watch', { repoId }).catch(() => {});
    } catch {
      // Intentionally ignored: the open already recorded the failure.
    }
  }

  /**
   * Lazily measure the change-size gauge for a batch of oids (ADR-0023).
   *
   * Only oids absent from the cache are requested, in one `getCommitStats`
   * call, so a re-render or a repeated window never re-measures. Failures are
   * silent for the gauge: `IPC_UNAVAILABLE` degrades to `offline`, any other
   * error is recorded on `statsError` — a missing gauge must not break the graph.
   */
  async loadStats(oids: readonly string[]): Promise<void> {
    const id = this.repoId();
    if (!id) return;

    const cached = this.commitStats();
    const missing = [...new Set(oids)].filter((oid) => !!oid && !cached.has(oid));
    if (missing.length === 0) return;

    try {
      const resp = await this.bridge.invoke('getCommitStats', { repoId: id, oids: missing });
      this.offline.set(false);
      this.statsError.set(null);
      const next = new Map(cached);
      for (const stat of resp.stats ?? []) next.set(stat.oid, stat);
      this.commitStats.set(next);
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
      } else {
        this.statsError.set(toAppError(err));
      }
    }
  }

  /**
   * Run `git reset --<mode> <to>` (ADR-0021) and reload the graph on success.
   *
   * No-ops without a repository, while another reset is in flight, or when the
   * mode is unspecified. `HARD` is gated by a renderer confirmation *before*
   * this method is reached; the store never downgrades or defaults a mode.
   */
  async reset(to: string, mode: ResetModeName): Promise<boolean> {
    const id = this.repoId();
    if (!id || this.resetRunning() || !to) return false;
    if (mode !== 'SOFT' && mode !== 'MIXED' && mode !== 'HARD') return false;

    this.resetRunning.set(true);
    this.resetError.set(null);
    try {
      // `mode` is the enum value name: proto-loader decodes with `enums: String`.
      await this.bridge.invoke('reset', { repoId: id, to, mode } as unknown as ResetRequest);
      this.offline.set(false);
      // A reset moves HEAD: refresh the graph through the normal flow.
      this.reload();
      return true;
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
      } else {
        this.resetError.set(toAppError(err));
      }
      return false;
    } finally {
      this.resetRunning.set(false);
    }
  }

  /**
   * Set the graph selection, unless the padlock holds a different commit.
   *
   * While locked, a foreign oid (including `null`/WIP) is refused and the
   * refusal is announced through the live region, so keyboard and mouse alike
   * cannot silently steal a pinned selection; re-selecting the locked oid (or
   * selecting freely when unlocked) behaves exactly as before. This is the one
   * chokepoint every selection path funnels through — `moveSelection` and the
   * deep-link `focusCommit` included.
   */
  select(oid: string | null): void {
    const locked = this.lockedOid();
    if (locked !== null && oid !== locked) {
      this.announceLocked();
      return;
    }
    this.selectedOid.set(oid);
    this.persistSession();
  }

  /**
   * Pin the current real-commit selection (padlock closed).
   *
   * A no-op unless a genuine commit is selected: nothing selected, the
   * synthetic WIP node (there is no commit to pin), or an oid no longer present
   * in the loaded `rows()` all leave the lock open. On success the oid AND the
   * live `Commit` object are captured, so the pinned detail pane keeps
   * rendering even after a reload drops the row out of the window.
   */
  lock(): void {
    const oid = this.selectedOid();
    if (!oid || oid === WIP_OID) return;
    const row = this.rows().find((r) => r.commit.oid?.hex === oid);
    if (!row) return;
    this.lockedOid.set(oid);
    this.lockedCommit.set(row.commit);
    this.persistSession();
  }

  /**
   * Clear the lock, keeping the selection (the padlock's "off" intent).
   *
   * The selected commit stays selected; only the pin is lifted, so toggling the
   * padlock off returns the graph to ordinary navigation without losing the
   * user's place.
   */
  unlock(): void {
    this.resetLock();
    this.persistSession();
  }

  /**
   * Release the pinned selection entirely (the contextual "release the commit"
   * action): drop the lock AND the selection together.
   *
   * Writes `selectedOid` directly rather than through {@link select} because
   * this is the one action that is *allowed* to move a locked selection — the
   * guard exists to block foreign selectors, not the release itself.
   */
  release(): void {
    this.resetLock();
    this.selectedOid.set(null);
    this.persistSession();
  }

  /**
   * Clear both lock signals without touching the selection.
   *
   * Deliberately non-persisting: `openRepository`'s failure path uses it to
   * clear only the live signals, and a failed open must never erase a repo's
   * saved session.
   */
  private resetLock(): void {
    this.lockedOid.set(null);
    this.lockedCommit.set(null);
  }

  /**
   * Hydrate the selection/lock signals from the root session store for
   * `repoId`. No saved entry (or no session store in plain unit tests) yields
   * the original null/empty state.
   */
  private restoreSession(repoId: string): void {
    const saved = this.graphSession?.read(repoId);
    this.selectedOid.set(saved?.selectedOid ?? null);
    this.lockedOid.set(saved?.lockedOid ?? null);
    this.lockedCommit.set(saved?.lockedCommit ?? null);
  }

  /**
   * Save the current selection/lock for the open repo. Called only from the
   * user-driven mutators (`select`/`lock`/`unlock`/`release`); a no-op when no
   * repo is open or the session store is absent.
   */
  private persistSession(): void {
    const repoId = this.repoId();
    if (!repoId || !this.graphSession) return;
    this.graphSession.write(repoId, {
      selectedOid: this.selectedOid(),
      lockedOid: this.lockedOid(),
      lockedCommit: this.lockedCommit(),
    });
  }

  /** Announce a refused selection change through the shared live region. */
  private announceLocked(): void {
    this.liveRegion?.announce(
      $localize`Commit selection is locked. Release the lock to select another commit.`,
    );
  }

  /**
   * Select `oid` and, when it is not yet in the loaded window, page forward
   * (bounded by {@link COMMIT_FOCUS_MAX_LOADS}) until it appears or the history
   * ends. Used by the deep-link commit-focus hand-off to reveal a commit that
   * lives beyond the first window; the selection is normally applied even when
   * the commit is not reached. The internal {@link select} calls now honour the
   * padlock, so a deep link arriving while a different commit is locked is
   * blocked (and announced) rather than replacing the pinned selection.
   *
   * Locked on a DIFFERENT commit, paging is pointless: both internal `select`
   * calls would be refused (announcing twice), so the address is applied once
   * through the normal `select` path and the method returns without loading any
   * window. Only an unlocked graph, or a target that IS the locked oid, pages.
   */
  async focusCommit(oid: string): Promise<void> {
    if (!oid) return;
    const locked = this.lockedOid();
    if (locked !== null && locked !== oid) {
      this.select(oid);
      return;
    }
    this.select(oid);

    const contains = (): boolean =>
      this.rows().some((row) => row.commit.oid?.hex === oid);
    if (contains()) return;

    let loads = 0;
    while (loads < COMMIT_FOCUS_MAX_LOADS && this.hasMore() && !contains()) {
      const before = this.commits().length;
      await this.loadWindow(before);
      loads++;
      // Stop early when a page made no progress (avoids an infinite loop).
      if (this.commits().length === before) break;
    }
    this.select(oid);
  }

  /** Move the selection down one visible row, clamping at the last row. */
  selectNext(): void {
    this.moveSelection(1);
  }

  /** Move the selection up one visible row, clamping at the first row. */
  selectPrevious(): void {
    this.moveSelection(-1);
  }

  private moveSelection(delta: number): void {
    const rows = this.filteredRows();
    if (rows.length === 0) return;
    const current = this.selectedIndex();
    const target =
      current < 0 ? 0 : Math.min(Math.max(current + delta, 0), rows.length - 1);
    // Route through `select` so keyboard traversal obeys the padlock exactly
    // like a row click: while locked, an arrow key onto another row is refused
    // and announced instead of quietly moving the selection off the pin.
    this.select(rows[target].commit.oid?.hex ?? null);
  }

  setFilter(query: string): void {
    this.filter.set(query);
    // A changed filter reorders the visible rows, so a remembered offset (and
    // any pending restore) would land on the wrong row.
    this.scrollOffset.set(0);
    this.pendingRestore.set(null);
  }

  // -- scroll offset persistence -------------------------------------------

  /**
   * Record the viewport scroll offset (px). Called on every `elementScrolled`
   * so the position survives a route change to `/repo/file-status` and back.
   */
  rememberScrollOffset(offset: number): void {
    this.scrollOffset.set(offset);
  }

  /**
   * Mark the remembered offset as pending restore. Called when the user leaves
   * the graph; {@link consumeScrollRestore} hands it back once on return.
   */
  requestScrollRestore(): void {
    this.pendingRestore.set(this.scrollOffset());
  }

  /**
   * Return the pending restore offset exactly once and clear it, so a second
   * call (or a re-mounted viewport) can never restore a stale position.
   */
  consumeScrollRestore(): number | null {
    const pending = this.pendingRestore();
    this.pendingRestore.set(null);
    return pending;
  }

  private applyPage(offset: number, resp: GetCommitsResponse): void {
    const page = resp.commits ?? [];
    const lanes = mapPageLanes(resp);

    if (offset <= 0) {
      this.commits.set([...page]);
      this.lanes.set(lanes);
      this.offset.set(page.length);
    } else {
      this.commits.update((prev) => [...prev, ...page]);
      this.lanes.update((prev) => [...prev, ...lanes]);
      this.offset.set(offset + page.length);
    }

    this.total.set(resp.total ?? 0);
    this.applyLensPage(offset, page, resp.inRefs ?? []);

    // Measure the gauge for the rows just loaded (ADR-0023): lazily, for the
    // visited window only, never the whole history. Fire-and-forget so the
    // window renders immediately and the gauge fills in when it arrives.
    void this.loadStats(
      page.map((commit) => commit.oid?.hex).filter((oid): oid is string => !!oid),
    );
  }

  /**
   * Pair `resp.inRefs` with `resp.commits` (parallel arrays, ADR-0042) into the
   * oid set the rows render against. A replacing page (`offset <= 0`) rebuilds
   * the set; an appended page unions into it so earlier windows keep their
   * highlights.
   */
  private applyLensPage(
    offset: number,
    page: readonly Commit[],
    inRefs: readonly boolean[],
  ): void {
    const inside: string[] = [];
    page.forEach((commit, index) => {
      const oid = commit.oid?.hex;
      if (inRefs[index] && oid) inside.push(oid);
    });

    if (offset <= 0) {
      this.lensOids.set(new Set(inside));
      return;
    }
    if (inside.length === 0) return;
    this.lensOids.update((prev) => {
      const next = new Set(prev);
      for (const oid of inside) next.add(oid);
      return next;
    });
  }
}
