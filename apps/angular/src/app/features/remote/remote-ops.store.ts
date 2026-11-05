import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { Branch, Remote, Tag } from '@contracts/domain';
import type { FetchRequest, PullRequest, PushRequest } from '@contracts/gitcore';
import { IpcBridge, toAppError, type AppError } from '@core/services/ipc-bridge.service';
import { RepoState } from '@core/services/repo-state.service';
import {
  parseRemoteTracking,
  type FetchIntent,
  type PullIntent,
  type PushIntent,
  type PushRowView,
  type RemoteBranchOption,
  type RemoteDialogKind,
  type RemoteOpProgress,
  type RemoteOption,
  type RepoFetchState,
} from './remote-models';

function isIpcUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'IPC_UNAVAILABLE'
  );
}

/**
 * Root store for the Git remote dialogs (Pull/Push/Fetch).
 *
 * Owns the active dialog, the ref data loaded for the active repository and the
 * running/progress/error state of a remote operation. It mirrors `RepoState`'s
 * graceful degradation when the Electron bridge is absent and reuses its active
 * repository as the operation target. The bridge/state/DestroyRef are
 * constructor parameters (defaulting to DI) so the store is unit-testable
 * without TestBed.
 */
@Injectable({ providedIn: 'root' })
export class RemoteOpsStore {
  private readonly bridge: IpcBridge;
  private readonly repoState: RepoState;

  /** Monotonic token for `loadRefs` (discards late responses). */
  private refsGeneration = 0;

  // -- per-repository fetch bookkeeping ------------------------------------
  /** Monotonic token per repository; an explicit token bump drops late results. */
  private readonly fetchGenerations = new Map<string, number>();
  /** Repositories with an automatic fetch in flight (single-flight guard). */
  private readonly fetchInFlight = new Set<string>();
  /** Repositories already fetched successfully in this session (freshness marker). */
  private readonly fetchedThisSession = new Set<string>();

  constructor(
    bridge: IpcBridge = inject(IpcBridge),
    repoState: RepoState = inject(RepoState),
    destroyRef: DestroyRef = inject(DestroyRef),
  ) {
    this.bridge = bridge;
    this.repoState = repoState;

    const unsubscribe = this.bridge.onProgress((p) => {
      this.progress.set({ percent: p.percent, message: p.message });
    });
    destroyRef.onDestroy(unsubscribe);
  }

  // -- dialog state --------------------------------------------------------
  readonly activeDialog = signal<RemoteDialogKind | null>(null);
  readonly dialogOpen = computed(() => this.activeDialog() !== null);

  // -- ref data for the active repository ----------------------------------
  readonly remotes = signal<Remote[]>([]);
  /** Local branches only (`!isRemote`); remote-tracking refs are separate. */
  readonly locals = signal<Branch[]>([]);
  /** Real remote-tracking branches enumerated by `getBranches` (`isRemote`). */
  readonly remoteRefs = signal<Branch[]>([]);
  readonly tags = signal<Tag[]>([]);
  readonly refsLoading = signal(false);
  readonly refsError = signal<AppError | null>(null);
  readonly offline = signal(false);

  // -- remote operation state ----------------------------------------------
  readonly running = signal(false);
  readonly progress = signal<RemoteOpProgress | null>(null);
  readonly opError = signal<AppError | null>(null);

  // -- per-repository fetch (ADR-024, renderer-orchestrated) ---------------
  /** Per-repository status of the current fetch, keyed by repo id (one at a time). */
  readonly fetchStatus = signal<Readonly<Record<string, RepoFetchState>>>({});
  /** Repository whose status the fetch line currently reports, or null. */
  readonly fetchRepoId = signal<string | null>(null);
  /** Last real fetch failure, or null (a missing bridge sets `offline` instead). */
  readonly fetchError = signal<AppError | null>(null);

  // -- derived -------------------------------------------------------------
  readonly remoteOptions = computed<RemoteOption[]>(() =>
    this.remotes().map((r) => ({ name: r.name, url: r.urls[0] ?? '' })),
  );

  readonly localBranchNames = computed<string[]>(() => this.locals().map((b) => b.name));

  readonly currentBranch = computed(() => this.locals().find((b) => b.isCurrent)?.name ?? '');

  readonly pushRows = computed<PushRowView[]>(() =>
    this.locals().map((b) => ({
      localBranch: b.name,
      isCurrent: b.isCurrent,
      upstream: b.upstream,
      defaultRemoteBranch: parseRemoteTracking(b.upstream)?.branch ?? b.name,
    })),
  );

  /**
   * Remote branches keyed by remote name, deduplicated by branch name. Real
   * remote-tracking branches from `getBranches` (`isRemote`) are listed first
   * with `derivedFromUpstream:false`; any upstreams not backed by a real ref
   * are appended as a fallback with `derivedFromUpstream:true`. Empty when the
   * repository has neither remote-tracking branches nor tracking upstreams.
   */
  readonly remoteBranchesByRemote = computed<Record<string, RemoteBranchOption[]>>(() => {
    const byRemote: Record<string, RemoteBranchOption[]> = {};
    const seen = new Set<string>();
    const add = (remote: string, option: RemoteBranchOption): void => {
      const key = `${remote}\u0000${option.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      (byRemote[remote] ??= []).push(option);
    };

    // Real remote-tracking branches enumerated by `getBranches`.
    for (const branch of this.remoteRefs()) {
      const parsed = parseRemoteTracking(branch.refName);
      if (!parsed) continue;
      add(parsed.remote, {
        name: parsed.branch,
        refName: branch.refName,
        derivedFromUpstream: false,
      });
    }

    // Fallback: remote branches inferred from local branches' upstreams.
    for (const branch of this.locals()) {
      const parsed = parseRemoteTracking(branch.upstream);
      if (!parsed) continue;
      add(parsed.remote, {
        name: parsed.branch,
        refName: branch.upstream,
        derivedFromUpstream: true,
      });
    }

    return byRemote;
  });

  // -- dialog actions ------------------------------------------------------

  /**
   * Open a remote dialog. No-op when no repository is active so the toolbar
   * cannot open a dialog without a target. Loads the ref lists in the
   * background.
   */
  openDialog(kind: RemoteDialogKind): void {
    if (this.repoState.activeId() === null) return;
    this.activeDialog.set(kind);
    this.opError.set(null);
    this.progress.set(null);
    void this.loadRefs();
  }

  closeDialog(): void {
    this.activeDialog.set(null);
    this.progress.set(null);
    this.opError.set(null);
  }

  // -- ref loading ---------------------------------------------------------

  /**
   * Load the remote/branch/tag objects for the active repository. Mirrors
   * `RepoState.loadRefs`: monotonic generation guard, `offline` on a missing
   * bridge, `refsError` on any other failure, empty lists on failure and a
   * guaranteed `refsLoading` reset.
   */
  async loadRefs(): Promise<void> {
    const id = this.repoState.activeId();
    const generation = ++this.refsGeneration;
    this.refsError.set(null);

    if (!id) {
      this.offline.set(false);
      this.clearRefs();
      this.refsLoading.set(false);
      return;
    }

    this.refsLoading.set(true);
    try {
      const [branches, remotes, tags] = await Promise.all([
        this.bridge.invoke('getBranches', { repoId: id }),
        this.bridge.invoke('getRemotes', { repoId: id }),
        this.bridge.invoke('getTags', { repoId: id }),
      ]);
      // Stale response: a newer loadRefs superseded this one.
      if (generation !== this.refsGeneration) return;
      this.offline.set(false);
      const refs = branches.branches ?? [];
      this.locals.set(refs.filter((b) => !b.isRemote));
      // Defensive: never surface the symbolic `origin/HEAD` remote ref
      // (matched on the raw ref so it holds regardless of short-name form).
      this.remoteRefs.set(refs.filter((b) => b.isRemote && !b.refName.endsWith('/HEAD')));
      this.remotes.set(remotes.remotes ?? []);
      this.tags.set(tags.tags ?? []);
    } catch (err) {
      // Stale failure: never mutate state for a newer active repo.
      if (generation !== this.refsGeneration) return;
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
      } else {
        this.refsError.set(toAppError(err));
      }
      this.clearRefs();
    } finally {
      if (generation === this.refsGeneration) this.refsLoading.set(false);
    }
  }

  /** Clear every ref list; used when there is no active repo or on failure. */
  private clearRefs(): void {
    this.remotes.set([]);
    this.locals.set([]);
    this.remoteRefs.set([]);
    this.tags.set([]);
  }

  // -- remote operations ---------------------------------------------------

  /** Fetch every remote (sequentially) or a single one. */
  async runFetch(intent: FetchIntent): Promise<void> {
    const repoId = this.repoState.activeId();
    if (!repoId || this.running()) return;

    this.running.set(true);
    this.opError.set(null);
    this.progress.set({ percent: 0, message: 'Starting…' });
    try {
      if (intent.allRemotes) {
        for (const remote of this.remotes()) {
          await this.bridge.invoke('fetch', {
            repoId,
            remote: remote.name,
            prune: intent.prune,
            tags: intent.tags,
            force: intent.force,
          } satisfies FetchRequest);
        }
      } else {
        await this.bridge.invoke('fetch', {
          repoId,
          remote: intent.remote,
          prune: intent.prune,
          tags: intent.tags,
          force: intent.force,
        } satisfies FetchRequest);
      }
      await this.loadRefs();
      // Refresh the sidebar's ref lists (and the current-branch behind count)
      // and close the modal only after the whole run finished successfully.
      await this.repoState.loadRefs();
      this.closeDialog();
    } catch (err) {
      this.handleRunError(err);
    } finally {
      this.running.set(false);
      this.progress.set(null);
    }
  }

  /** Pull `intent.branch` from `intent.remote` into the active repository. */
  async runPull(intent: PullIntent): Promise<void> {
    const repoId = this.repoState.activeId();
    if (!repoId || this.running()) return;

    this.running.set(true);
    this.opError.set(null);
    this.progress.set({ percent: 0, message: 'Starting…' });
    try {
      await this.bridge.invoke('pull', {
        repoId,
        remote: intent.remote,
        branch: intent.branch,
        localBranch: intent.intoLocalBranch,
        noCommit: intent.noCommit,
        log: intent.log,
        noFf: intent.noFf,
        rebase: intent.rebase,
      } satisfies PullRequest);
      await this.loadRefs();
      // Refresh the sidebar's ref lists (and the current-branch behind count)
      // so the pull-pending badge clears after a successful pull.
      await this.repoState.loadRefs();
    } catch (err) {
      this.handleRunError(err);
    } finally {
      this.running.set(false);
      this.progress.set(null);
    }
  }

  /** Push every selected row (sequentially) to `intent.remote`. */
  async runPush(intent: PushIntent): Promise<void> {
    const repoId = this.repoState.activeId();
    if (!repoId || this.running()) return;

    this.running.set(true);
    this.opError.set(null);
    this.progress.set({ percent: 0, message: 'Starting…' });
    try {
      for (const row of intent.branches) {
        if (!row.localBranch) continue;
        await this.bridge.invoke('push', {
          repoId,
          remote: intent.remote,
          branch: row.localBranch,
          // Empty `remoteBranch` means "same name as `branch`" (core contract).
          remoteBranch: row.remoteBranch,
          setUpstream: row.track,
          tags: intent.tags,
          force: intent.force,
        } satisfies PushRequest);
      }
      await this.loadRefs();
    } catch (err) {
      this.handleRunError(err);
    } finally {
      this.running.set(false);
      this.progress.set(null);
    }
  }

  // -- per-repository fetch (ADR-024) --------------------------------------

  /**
   * Fetch exactly one repository over the existing per-repo streaming `fetch`.
   * No core "fetch all" RPC exists: the renderer asks the core for one repo at a
   * time, so a slow repository can never block or freeze the UI.
   *
   * The request shape is unchanged from the former fan-out (`remote: ''`,
   * `prune: false`, `tags: false`, `force: false`); an explicit user sync is
   * expressed by the caller, which simply calls this method directly instead of
   * `fetchRepoIfStale` and therefore bypasses the freshness marker.
   *
   * A fetch captures a generation token. After the await it drops its result
   * (status, error and refs refresh) unless the token is still current — which
   * `invalidateFetch` (tab closed) and a newer explicit fetch both invalidate.
   */
  async fetchRepo(repoId: string, opts: { force?: boolean } = {}): Promise<void> {
    const generation = this.bumpFetchGeneration(repoId);
    // An explicit (forced) sync bypasses the session freshness marker.
    if (opts.force) this.fetchedThisSession.delete(repoId);
    this.fetchInFlight.add(repoId);
    this.fetchRepoId.set(repoId);
    // Report a single repository at a time: a new fetch replaces the previous
    // line instead of accumulating a fake N/M aggregate.
    this.fetchStatus.set({ [repoId]: 'pending' });
    this.fetchError.set(null);

    try {
      await this.bridge.invoke('fetch', {
        repoId,
        // Empty remote => `git fetch` for the repository's configured default
        // (all its remotes are covered by the repo's own refspecs).
        remote: '',
        prune: false,
        tags: false,
        force: false,
      } satisfies FetchRequest);
      if (!this.isFetchCurrent(repoId, generation)) return;
      this.fetchedThisSession.add(repoId);
      // The STATUS write belongs to whoever owns the line: a newer repository
      // (or a dismissed line) must never be repainted by this fetch.
      if (this.fetchRepoId() === repoId) this.setFetchStatus(repoId, 'success');
      // The refs refresh must NOT depend on the line owner: dismissing the
      // status line while the fetch is in flight still leaves the repository
      // marked session-fresh, so skipping this would leave its badges stale for
      // the rest of the session. Only the active repository may refresh.
      if (this.repoState.activeId() === repoId) await this.repoState.loadRefs();
    } catch (err) {
      if (!this.isFetchCurrent(repoId, generation)) return;
      this.fetchedThisSession.delete(repoId);
      // The OFFLINE indicator is global, not line state: a dismissed status line
      // must never hide that the bridge is gone.
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
      }
      // The line-owned writes (status + error) belong to whoever owns the line.
      if (this.fetchRepoId() !== repoId) return;
      this.setFetchStatus(repoId, 'failed');
      if (!isIpcUnavailable(err)) {
        this.fetchError.set(toAppError(err));
      }
    } finally {
      // Only the token that is still current owns the in-flight slot; a stale
      // fetch must not clear a newer fetch's guard.
      if (this.isFetchCurrent(repoId, generation)) this.fetchInFlight.delete(repoId);
    }
  }

  /**
   * Lazy fetch used when a repository tab becomes active: skip repositories
   * already fetched successfully in this session, and stay single-flight so two
   * quick activations cannot stack a second concurrent call.
   */
  async fetchRepoIfStale(repoId: string): Promise<void> {
    if (this.fetchInFlight.has(repoId)) return;
    if (this.fetchedThisSession.has(repoId)) return;
    await this.fetchRepo(repoId);
  }

  /**
   * Invalidate every in-flight fetch for `repoId` (its tab was closed). Bumps
   * the generation so a late response can never write status, error or refs,
   * and drops the reported line when it belonged to that repository.
   */
  invalidateFetch(repoId: string): void {
    this.bumpFetchGeneration(repoId);
    this.fetchInFlight.delete(repoId);
    this.fetchedThisSession.delete(repoId);
    if (this.fetchRepoId() === repoId) {
      this.fetchStatus.set({});
      this.fetchRepoId.set(null);
      this.fetchError.set(null);
    }
  }

  /** Dismiss the fetch status line and drop its transient state. */
  clearFetch(): void {
    this.fetchStatus.set({});
    this.fetchRepoId.set(null);
    this.fetchError.set(null);
  }

  private setFetchStatus(repoId: string, state: RepoFetchState): void {
    // One source of truth, one repository at a time.
    this.fetchStatus.set({ [repoId]: state });
  }

  private bumpFetchGeneration(repoId: string): number {
    const generation = (this.fetchGenerations.get(repoId) ?? 0) + 1;
    this.fetchGenerations.set(repoId, generation);
    return generation;
  }

  private isFetchCurrent(repoId: string, generation: number): boolean {
    return this.fetchGenerations.get(repoId) === generation;
  }

  private handleRunError(err: unknown): void {
    if (isIpcUnavailable(err)) {
      this.offline.set(true);
      return;
    }
    // Surface real core failures (FETCH_FAILED/PULL_FAILED/PUSH_FAILED, …) as-is.
    this.opError.set(toAppError(err));
  }
}
