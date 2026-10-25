import { Injectable, computed, inject, signal } from '@angular/core';
import type { Commit, Repository, Stash } from '@contracts/domain';
import type {
  CherryPickRequest,
  FinishGitFlowRequest,
  GitFlowConfig,
  GitFlowResult,
  MergeRequest,
  MergeResponse,
  ResolveRevisionRequest,
  RevertRequest,
  StartGitFlowRequest,
} from '@contracts/gitcore';
import type { GitFlowKindName } from '@shared/ui/git-flow-dialog/git-flow.models';
import type { MergeStrategyName } from '@shared/ui/ref-dialogs/ref-dialog.models';
import { BranchLensStore } from './branch-lens.store';
import { IpcBridge, toAppError, type AppError } from './ipc-bridge.service';

type RepositoryId = string;

/** The Git operation that can leave the tree conflicted (ADR-0042). */
export type ConflictOperation = 'merge' | 'cherry-pick' | 'revert';

/**
 * One conflict state for every operation that can leave the working tree
 * conflicted. The `operation` discriminator keeps the shell banner and the
 * operation's dialog from reading each other's conflicts.
 */
export interface ConflictState {
  readonly operation: ConflictOperation;
  readonly hasConflict: boolean;
  readonly oid: string;
}

/**
 * Read the root `BranchLensStore` when one exists, else `null`.
 *
 * Mirrors the defensive injectors in `GraphStore`: `RepoState` is also built
 * directly (`new RepoState(bridge)`) in unit tests with no DI context, where a
 * bare `inject()` would throw NG0203. Outside a real app the lens cannot exist,
 * so clearing it degrades to a no-op.
 */
function safeInjectBranchLens(): BranchLensStore | null {
  try {
    return inject(BranchLensStore, { optional: true });
  } catch {
    return null;
  }
}

function isIpcUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'IPC_UNAVAILABLE'
  );
}

/**
 * Best-effort `oid` carried by a typed conflict rejection (`…_CONFLICT`). The
 * core normally answers conflicts as data, so this only matters for the error
 * envelope; a missing/invalid field degrades to `''`.
 */
function conflictOidFrom(error: AppError): string {
  const oid = error.details?.['oid'];
  return typeof oid === 'string' ? oid : '';
}

/**
 * Root active-repository source of truth for the shell.
 *
 * The route-scoped `GraphStore` owns the graph and knows which repository is
 * open; this store mirrors that selection so the layout chrome (left sidebar
 * ref lists) can observe it without depending on a route-scoped provider.
 * Ref reads (`getBranches`/`getRemotes`/`getTags`) degrade gracefully when the
 * Electron bridge is unavailable.
 */
@Injectable({ providedIn: 'root' })
export class RepoState {
  private readonly bridge: IpcBridge;
  /**
   * Root branch-lens state, captured once at construction (see
   * {@link safeInjectBranchLens}); `null` in plain unit tests. The lens is
   * repo-scoped UI state, so every repository transition clears it.
   */
  private readonly branchLens: BranchLensStore | null;

  /**
   * Monotonic token for `loadRefs`. Incremented on every call so a late
   * response for a previous repository can never overwrite a newer one.
   */
  private refsGeneration = 0;

  constructor(
    bridge: IpcBridge = inject(IpcBridge),
    branchLens: BranchLensStore | null = safeInjectBranchLens(),
  ) {
    this.bridge = bridge;
    this.branchLens = branchLens;
  }

  readonly repos = signal<Repository[]>([]);
  readonly activeId = signal<RepositoryId | null>(null);
  readonly reposLoading = signal(false);
  readonly reposError = signal<AppError | null>(null);
  /** True when the repository list could not be read because the bridge is absent. */
  readonly reposOffline = signal(false);
  /** Id of the repository currently being removed, or null when idle. */
  readonly removingId = signal<RepositoryId | null>(null);
  /** True once the first `loadRepositories` attempt has settled. */
  readonly reposLoaded = signal(false);
  /** In-flight/last `loadRepositories` promise, for callers that must await it. */
  private reposLoadPromise: Promise<void> | null = null;

  // -- ref lists for the active repository ---------------------------------
  /** Local branch display names (remote-tracking branches are excluded). */
  readonly branches = signal<string[]>([]);
  /** Remote-tracking branch display names, e.g. `origin/david/topic`. */
  readonly remoteBranches = signal<string[]>([]);
  readonly tags = signal<string[]>([]);
  readonly remotes = signal<string[]>([]);
  /**
   * Name of the current local branch (`isCurrent && !isRemote`), or `''` when
   * there is no active repo / detached HEAD.
   */
  readonly currentBranch = signal('');
  /**
   * Pull-pending count of the current local branch vs. its upstream; `0` when
   * the branch has no upstream, is not current, or there is no active repo.
   */
  readonly currentBranchBehind = signal(0);
  readonly refsLoading = signal(false);
  readonly refsError = signal<AppError | null>(null);
  /** True when the renderer runs without the Electron preload bridge. */
  readonly refsOffline = signal(false);

  // -- checkout ------------------------------------------------------------
  /** True while a `checkout` call is in flight. */
  readonly checkoutRunning = signal(false);
  /** True while a `stashPush` call is in flight. */
  readonly stashRunning = signal(false);
  /** Last checkout failure, or null when idle/successful. */
  readonly checkoutError = signal<AppError | null>(null);

  // -- ref mutations (ADR-028: branch/tag CRUD + merge) --------------------
  /** True while any branch/tag/merge mutation is in flight. */
  readonly refOpRunning = signal(false);
  /** Last ref-mutation failure, or null when idle/successful. */
  readonly refOpError = signal<AppError | null>(null);
  /**
   * Conflict produced by the last merge / cherry-pick / revert, or null. The
   * `operation` discriminator lets the shell banner and the operation's own
   * dialog render only their conflict. The tree stays conflicted: there is no
   * in-app resolver.
   */
  readonly conflict = signal<ConflictState | null>(null);
  /**
   * Merge-only view of {@link conflict}, kept for `st-merge-dialog` (which
   * predates the general conflict state). Null for any other operation.
   */
  readonly mergeConflict = computed<MergeResponse | null>(() => {
    const current = this.conflict();
    return current && current.operation === 'merge'
      ? { hasConflict: current.hasConflict, oid: current.oid }
      : null;
  });

  // -- cherry-pick (ADR-0042) ----------------------------------------------
  /**
   * Open cherry-pick dialog: the source commit to copy onto the current branch,
   * or null when closed.
   */
  readonly cherryPickDialog = signal<{ source: string } | null>(null);
  /** Resolved source commit shown as the dialog's preview, or null. */
  readonly cherryPreview = signal<Commit | null>(null);
  readonly cherryPreviewLoading = signal(false);
  /** Why the last preview resolution failed (`COMMIT_NOT_FOUND`, …), or null. */
  readonly cherryPreviewError = signal<AppError | null>(null);
  /**
   * Monotonic token for {@link resolveCherryPickSource}: only the newest
   * request may write the preview, so a slow earlier resolution can never
   * overwrite a newer revision.
   */
  private cherryPreviewGeneration = 0;

  // -- stashes (ADR-028) ---------------------------------------------------
  /** Stash entries for the active repository, newest first (as the core lists). */
  readonly stashes = signal<Stash[]>([]);
  readonly stashesLoading = signal(false);
  readonly stashesError = signal<AppError | null>(null);
  /** True while a `stashApply`/`stashPop`/`stashDrop` mutation is in flight. */
  readonly stashOpRunning = signal(false);
  /** Last stash-mutation failure, or null when idle/successful. */
  readonly stashOpError = signal<AppError | null>(null);
  /**
   * Monotonic token for `loadStashes`. Incremented on every call so a late
   * response for a previous repository can never overwrite a newer one.
   */
  private stashesGeneration = 0;

  // -- git-flow presets (ADR-027) ------------------------------------------
  /** Active repository's git-flow configuration, or null until loaded. */
  readonly gitFlowConfig = signal<GitFlowConfig | null>(null);
  readonly gitFlowConfigLoading = signal(false);
  readonly gitFlowConfigError = signal<AppError | null>(null);
  /** True while a start/finish/config mutation is in flight. */
  readonly gitFlowRunning = signal(false);
  /** Last git-flow failure, or null when idle/successful. */
  readonly gitFlowError = signal<AppError | null>(null);
  /**
   * Result of the last git-flow start/finish (branch, ordered `steps` and the
   * `hasConflict` flag), or null. On a finish conflict the sequence stops, the
   * tree is left conflicted and `hasConflict` is true.
   */
  readonly gitFlowResult = signal<GitFlowResult | null>(null);

  /**
   * Monotonic token bumped whenever a ref mutation may have changed the working
   * tree or HEAD (a checkout-on-create or a merge). Route-scoped consumers
   * observe it to refresh: `RepoPage` reloads the graph window and
   * `FileStatusPage` refreshes the working tree — both relocated when ADR-0030
   * removed the band that used to own them.
   */
  private readonly statusRefreshState = signal(0);
  readonly statusRefreshRequested = this.statusRefreshState.asReadonly();

  // -- ref name maps (display name -> full ref) ----------------------------
  private readonly localRefState = signal<ReadonlyMap<string, string>>(new Map());
  private readonly remoteRefState = signal<ReadonlyMap<string, string>>(new Map());
  /** Local branch display name -> full local ref (`refs/heads/<name>`). */
  readonly localRefByName = this.localRefState.asReadonly();
  /** Remote-tracking display name -> raw ref (e.g. `refs/remotes/origin/foo`). */
  readonly remoteRefByName = this.remoteRefState.asReadonly();

  readonly activeRepo = computed(() => {
    const id = this.activeId();
    if (!id) return null;
    return this.repos().find((r) => r.id === id) ?? null;
  });

  /**
   * Load the persisted repository list from the Go core (`listRepositories`).
   *
   * Mirrors the refs pattern: records `reposOffline` when the bridge is absent,
   * any other failure on `reposError`, and always clears `reposLoading`. The
   * currently loaded list is kept on failure so a transient error never blanks
   * the drawer. The in-flight promise is retained so `whenRepositoriesLoaded`
   * can await it.
   */
  loadRepositories(): Promise<void> {
    const promise = this.doLoadRepositories();
    this.reposLoadPromise = promise;
    return promise;
  }

  /**
   * Resolve once the repository list has been loaded at least once.
   *
   * Deep-link routing awaits this so a `<repo>` token is never resolved against
   * an empty list while the first `loadRepositories` is still in flight (a link
   * can arrive right after the renderer acknowledges readiness, before
   * `ngOnInit`'s load has settled).
   */
  async whenRepositoriesLoaded(): Promise<void> {
    if (this.reposLoaded()) return;
    if (this.reposLoadPromise) {
      await this.reposLoadPromise;
      return;
    }
    await this.loadRepositories();
  }

  private async doLoadRepositories(): Promise<void> {
    this.reposLoading.set(true);
    this.reposError.set(null);
    try {
      const res = await this.bridge.invoke('listRepositories', {});
      this.reposOffline.set(false);
      this.repos.set(res.repositories ?? []);
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.reposOffline.set(true);
      } else {
        this.reposError.set(toAppError(err));
      }
    } finally {
      this.reposLoading.set(false);
      this.reposLoaded.set(true);
    }
  }

  /**
   * Open (register) a repository by absolute filesystem path (`openRepository`)
   * and make it active. Used by deep-link routing (ADR-025): the shell never
   * runs Git, so the renderer resolves the path through the core here.
   *
   * Returns the opened repository on success, or null on failure. A missing
   * bridge records `reposOffline`; any other failure records `reposError`.
   */
  async openRepositoryPath(fsPath: string): Promise<Repository | null> {
    const trimmed = fsPath.trim();
    if (!trimmed) return null;

    this.reposError.set(null);
    try {
      const repo = await this.bridge.invoke('openRepository', { fsPath: trimmed });
      this.reposOffline.set(false);
      this.setActive(repo);
      return repo;
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.reposOffline.set(true);
      } else {
        this.reposError.set(toAppError(err));
      }
      return null;
    }
  }

  /**
   * Remove a persisted repository from the core (`removeRepository`).
   *
   * On success the repo is dropped from `repos`; if it was the active one,
   * `activeId` is cleared and `loadRefs()` runs to clear the ref lists and bump
   * the generation token. On failure the list/selection are left untouched:
   * `reposOffline` records a missing bridge, any other error goes to `reposError`.
   */
  async removeRepository(id: RepositoryId): Promise<boolean> {
    this.removingId.set(id);
    this.reposError.set(null);
    try {
      await this.bridge.invoke('removeRepository', { repoId: id });
      this.reposOffline.set(false);
      this.repos.update((prev) => prev.filter((repo) => repo.id !== id));
      if (this.activeId() === id) {
        // A lens belongs to the repository it was applied in: never let it
        // survive the removal of its active repo.
        this.branchLens?.clear();
        this.resetCherryPick();
        this.activeId.set(null);
        void this.loadRefs();
        void this.loadStashes();
      }
      return true;
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.reposOffline.set(true);
      } else {
        this.reposError.set(toAppError(err));
      }
      return false;
    } finally {
      this.removingId.set(null);
    }
  }

  /**
   * Repoint a registered repository at a differing filesystem path
   * (`relocateRepository`, P4.1 polish).
   *
   * Mirrors `removeRepository`'s error handling: `IPC_UNAVAILABLE` records
   * `reposOffline`, any other failure (including `REPO_PATH_MISSING`,
   * `NOT_A_GIT_REPO` and `REPO_PATH_IN_USE`) is recorded verbatim on
   * `reposError` so the user is never left guessing why the save failed.
   *
   * On success the core repoints the *same* repository id, so the record is
   * upserted in place and `created_at` is preserved. When the repo was active it
   * stays active (the id is unchanged); the authoritative list is then reloaded
   * so the drawer/nav-rail observe the new path. Returns the relocated record, or
   * null on failure.
   */
  async relocateRepository(id: RepositoryId, fsPath: string): Promise<Repository | null> {
    const trimmed = fsPath.trim();
    if (!trimmed) return null;

    this.reposError.set(null);
    try {
      const repo = await this.bridge.invoke('relocateRepository', { repoId: id, fsPath: trimmed });
      this.reposOffline.set(false);
      // Upsert the repointed record under its (unchanged) id; `created_at` is the
      // core's, so a same-id replace keeps the original registration history.
      this.repos.update((prev) => {
        const index = prev.findIndex((r) => r.id === repo.id);
        if (index === -1) return [...prev, repo];
        const next = [...prev];
        next[index] = repo;
        return next;
      });
      // `activeId` is already `repo.id` when this was the active repo, so it
      // "stays active" for free; re-activating also reloads its refs/stashes for
      // the new path. When it was not active the selection is left untouched.
      if (this.activeId() === repo.id) this.setActive(repo);
      // Refresh the authoritative list so the repos page / nav-rail show the new
      // path without a manual reload (the record is upserted optimistically above
      // so the UI never briefly shows the stale path).
      await this.loadRepositories();
      return repo;
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.reposOffline.set(true);
      } else {
        this.reposError.set(toAppError(err));
      }
      return null;
    }
  }

  /** Upsert `repo`, make it active and (re)load its ref lists. */
  setActive(repo: Repository): void {
    // The lens is repo-scoped: switching repositories always drops it.
    this.branchLens?.clear();
    // Same for the cherry-pick dialog/preview: neither may leak across repos.
    this.resetCherryPick();
    this.repos.update((prev) => {
      const index = prev.findIndex((r) => r.id === repo.id);
      if (index === -1) return [...prev, repo];
      const next = [...prev];
      next[index] = repo;
      return next;
    });
    this.activeId.set(repo.id);
    void this.loadRefs();
    void this.loadStashes();
  }

  /**
   * Clear the active repository selection and its derived lists (refs, stashes).
   *
   * Used when the last workspace tab closes: without this the sidebar/toolbar
   * would keep showing refs for a repository that no longer has an open tab.
   * Mirrors `removeRepository`'s clear-on-active-removal path.
   */
  clearActive(): void {
    // With no active repository there is nothing for a lens to scope.
    this.branchLens?.clear();
    this.resetCherryPick();
    this.activeId.set(null);
    void this.loadRefs();
    void this.loadStashes();
  }

  /**
   * Load branch/tag/remote display names for the active repository. Local
   * branches (`!isRemote`) feed `branches`; remote-tracking branches
   * (`isRemote`) feed `remoteBranches`; `origin/HEAD` is never surfaced. Clears
   * the lists when there is no active repo; records `refsOffline` on a missing
   * bridge and any other failure on `refsError`. A monotonic generation token
   * discards late responses from a repository that is no longer active.
   */
  async loadRefs(): Promise<void> {
    const id = this.activeId();
    const generation = ++this.refsGeneration;
    this.refsError.set(null);
    // A ref (re)load means the user moved on or a checkout succeeded, so any
    // previously surfaced checkout failure is stale and must be cleared.
    this.checkoutError.set(null);

    if (!id) {
      this.refsOffline.set(false);
      this.clearRefLists();
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
      this.refsOffline.set(false);
      const refs = branches.branches ?? [];
      const localRefs = refs.filter((b) => !b.isRemote);
      // Defensive: never surface the symbolic `origin/HEAD` remote ref
      // (matched on the raw ref so it holds regardless of short-name form).
      const remoteRefs = refs.filter((b) => b.isRemote && !b.refName.endsWith('/HEAD'));
      this.branches.set(localRefs.map((b) => b.name));
      // The current branch drives the toolbar/sidebar pull-pending badge; only
      // the current local branch is badged, and only when it is behind.
      const current = localRefs.find((b) => b.isCurrent);
      this.currentBranch.set(current?.name ?? '');
      this.currentBranchBehind.set(current?.behind ?? 0);
      this.remoteBranches.set(remoteRefs.map((b) => b.name));
      // Retain display-name -> full-ref mappings so a later checkout can send
      // the full ref (locals are `refs/heads/<name>`; remotes keep the raw ref).
      this.localRefState.set(
        new Map(localRefs.map((b) => [b.name, b.refName || `refs/heads/${b.name}`])),
      );
      this.remoteRefState.set(new Map(remoteRefs.map((b) => [b.name, b.refName || b.name])));
      this.tags.set(tags.tags.map((t) => t.name));
      this.remotes.set(remotes.remotes.map((r) => r.name));
      this.dropLensIfMissing();
    } catch (err) {
      // Stale failure: never mutate state for a newer active repo.
      if (generation !== this.refsGeneration) return;
      if (isIpcUnavailable(err)) {
        this.refsOffline.set(true);
      } else {
        this.refsError.set(toAppError(err));
      }
      this.clearRefLists();
    } finally {
      if (generation === this.refsGeneration) this.refsLoading.set(false);
    }
  }

  /**
   * Drop the lens when the ref it scopes no longer exists in the fresh lists.
   *
   * A lens is a scope over a real ref: once the rail deletes that branch (or
   * rename/checkout remove it), the next `getCommits` would fail and leave the
   * graph stuck in a broken scope. Comparing against the list the lens came from
   * (`local` ⇒ branches, `remote` ⇒ remote branches) keeps a same-named ref of
   * the other kind from masking the deletion. Tags are not lensable today, so a
   * tag lens never reaches this check.
   */
  private dropLensIfMissing(): void {
    const lens = this.branchLens;
    const ref = lens?.ref();
    if (!lens || !ref) return;
    const names = lens.kind() === 'remote' ? this.remoteBranches() : this.branches();
    if (!names.includes(ref)) lens.clear();
  }

  /** Clear every ref list; used when there is no active repo or on failure. */
  private clearRefLists(): void {
    this.branches.set([]);
    this.remoteBranches.set([]);
    this.tags.set([]);
    this.remotes.set([]);
    this.currentBranch.set('');
    this.currentBranchBehind.set(0);
    this.localRefState.set(new Map());
    this.remoteRefState.set(new Map());
  }

  /**
   * Check out a local or remote-tracking branch on the active repository.
   *
   * No-ops without an active repo, while another checkout is running, or when a
   * local click targets the already-current branch (avoids a duplicate
   * checkout). The full ref is resolved from the retained display-name map,
   * falling back to `name` (the Go adapter resolves short names defensively).
   *
   * `force` maps to `git checkout -f` (discard tracked modifications) and
   * `discardUntracked` maps to `git clean -fd` before the checkout (implies
   * force); both are driven by the branch-switch conflict flow, defaulting to
   * false for a plain click. On success the ref lists are reloaded; on failure
   * `IPC_UNAVAILABLE` maps to `refsOffline` and any other error to
   * `checkoutError`.
   */
  async checkoutBranch(
    name: string,
    isRemote: boolean,
    force = false,
    discardUntracked = false,
  ): Promise<void> {
    const repoId = this.activeId();
    if (!repoId || this.checkoutRunning()) return;
    // A local click on the current branch is a no-op (no duplicate checkout).
    if (!isRemote && name === this.currentBranch()) return;

    const map = isRemote ? this.remoteRefByName() : this.localRefByName();
    const refName = map.get(name) ?? name;

    this.checkoutRunning.set(true);
    this.checkoutError.set(null);
    try {
      await this.bridge.invoke('checkout', { repoId, refName, force, discardUntracked });
      await this.loadRefs();
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.refsOffline.set(true);
      } else {
        this.checkoutError.set(toAppError(err));
      }
    } finally {
      this.checkoutRunning.set(false);
    }
  }

  /**
   * Save the working-tree changes to the stash stack (`stashPush`), used by the
   * branch-switch flow to "save changes" before retrying a blocked checkout.
   *
   * No-ops without an active repo or while another stash is running. On success
   * the ref lists (including stashes) are reloaded and `true` is returned; on
   * failure `IPC_UNAVAILABLE` maps to `refsOffline`, any other error to
   * `checkoutError`, and `false` is returned.
   */
  async stashPush(message: string): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.stashRunning()) return false;

    this.stashRunning.set(true);
    this.checkoutError.set(null);
    try {
      await this.bridge.invoke('stashPush', { repoId, message });
      await this.loadRefs();
      await this.loadStashes();
      this.requestStatusRefresh();
      return true;
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.refsOffline.set(true);
      } else {
        this.checkoutError.set(toAppError(err));
      }
      return false;
    } finally {
      this.stashRunning.set(false);
    }
  }

  /** Clear a displayed checkout failure (e.g. the shell banner was dismissed). */
  dismissCheckoutError(): void {
    this.checkoutError.set(null);
  }

  // -- ref mutations (ADR-028) ---------------------------------------------

  /**
   * Create a local branch (`createBranch`) at `startPoint`, optionally checking
   * it out. No-ops without an active repo, while another ref op runs, or with a
   * blank name. On success the ref lists reload and, when `checkout` is true, the
   * working tree consumers are asked to refresh (HEAD moved).
   */
  async createBranch(name: string, startPoint: string, checkout: boolean): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.refOpRunning() || !name.trim()) return false;

    this.refOpRunning.set(true);
    this.refOpError.set(null);
    try {
      await this.bridge.invoke('createBranch', { repoId, name, startPoint, checkout });
      // A checkout moves HEAD onto the new branch, so a lens over the previous
      // scope would keep the graph narrowed against the wrong branch.
      if (checkout) this.branchLens?.clear();
      await this.loadRefs();
      if (checkout) this.requestStatusRefresh();
      return true;
    } catch (err) {
      this.handleRefOpError(err);
      return false;
    } finally {
      this.refOpRunning.set(false);
    }
  }

  /**
   * Rename a local branch (`renameBranch`). No-ops without an active repo, while
   * another ref op runs, or with a blank new name. Reloads the ref lists on
   * success.
   */
  async renameBranch(oldName: string, newName: string): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.refOpRunning() || !newName.trim()) return false;

    this.refOpRunning.set(true);
    this.refOpError.set(null);
    try {
      await this.bridge.invoke('renameBranch', { repoId, oldName, newName });
      await this.loadRefs();
      return true;
    } catch (err) {
      this.handleRefOpError(err);
      return false;
    } finally {
      this.refOpRunning.set(false);
    }
  }

  /**
   * Delete a local branch (`deleteBranch`). `force` maps to `git branch -D`
   * (discard unmerged commits); the dialog warns first. Reloads the ref lists on
   * success.
   */
  async deleteBranch(name: string, force: boolean): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.refOpRunning()) return false;

    this.refOpRunning.set(true);
    this.refOpError.set(null);
    try {
      await this.bridge.invoke('deleteBranch', { repoId, name, force });
      await this.loadRefs();
      return true;
    } catch (err) {
      this.handleRefOpError(err);
      return false;
    } finally {
      this.refOpRunning.set(false);
    }
  }

  /**
   * Create a tag (`createTag`) at `target`. An annotated tag requires a message;
   * the dialog enforces it and this guard defends the store. `force` moves an
   * existing tag. Reloads the ref lists on success.
   */
  async createTag(
    name: string,
    target: string,
    annotated: boolean,
    message: string,
    force: boolean,
  ): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.refOpRunning() || !name.trim()) return false;
    if (annotated && !message.trim()) return false;

    this.refOpRunning.set(true);
    this.refOpError.set(null);
    try {
      await this.bridge.invoke('createTag', { repoId, name, target, annotated, message, force });
      await this.loadRefs();
      return true;
    } catch (err) {
      this.handleRefOpError(err);
      return false;
    } finally {
      this.refOpRunning.set(false);
    }
  }

  /** Delete a tag (`deleteTag`). Reloads the ref lists on success. */
  async deleteTag(name: string): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.refOpRunning()) return false;

    this.refOpRunning.set(true);
    this.refOpError.set(null);
    try {
      await this.bridge.invoke('deleteTag', { repoId, name });
      await this.loadRefs();
      return true;
    } catch (err) {
      this.handleRefOpError(err);
      return false;
    } finally {
      this.refOpRunning.set(false);
    }
  }

  /**
   * Merge `ref` into the current branch (`merge`) with the chosen strategy.
   *
   * M3 surfaces conflicts instead of resolving them: a response with
   * `hasConflict` (or a `MERGE_CONFLICT` rejection) publishes the merge
   * `conflict`, refreshes the ref lists and asks the working-tree consumers to
   * refresh so the conflicted files appear. The tree stays conflicted — there is
   * no 3-way editor in M3.
   */
  async merge(
    ref: string,
    strategy: MergeStrategyName,
    noCommit: boolean,
    message: string,
  ): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.refOpRunning() || !ref) return false;

    this.refOpRunning.set(true);
    this.refOpError.set(null);
    try {
      const req = { repoId, ref, strategy, noCommit, message } as unknown as MergeRequest;
      const res = await this.bridge.invoke('merge', req);
      await this.loadRefs();
      this.requestStatusRefresh();
      this.publishConflict('merge', res.hasConflict === true, res.oid ?? '');
      return true;
    } catch (err) {
      const appError = toAppError(err);
      if (appError.code === 'MERGE_CONFLICT') {
        // The core reports conflicts as an error envelope; treat it as the same
        // surfaced state (tree stays conflicted) rather than a hard failure.
        this.refsOffline.set(false);
        await this.loadRefs();
        this.requestStatusRefresh();
        this.publishConflict('merge', true, conflictOidFrom(appError));
        return true;
      }
      this.handleRefOpError(appError);
      return false;
    } finally {
      this.refOpRunning.set(false);
    }
  }

  /** Clear a displayed ref-mutation failure (e.g. a dialog was dismissed). */
  clearRefOpError(): void {
    this.refOpError.set(null);
  }

  /**
   * Open the cherry-pick dialog for `source` (the commit to pick onto the
   * current branch). A stale ref-mutation error and any previous preview are
   * cleared first.
   */
  openCherryPick(source: string): void {
    this.clearRefOpError();
    this.resetCherryPreview();
    this.cherryPickDialog.set({ source });
  }

  /** Dismiss the cherry-pick dialog without changing any repository state. */
  closeCherryPick(): void {
    this.cherryPickDialog.set(null);
    this.resetCherryPreview();
  }

  /**
   * Cherry-pick one revision onto the current branch (`cherryPick`, ADR-0042).
   *
   * Handles the two ways the core reports conflicts — the `hasConflict`
   * response and the typed `CHERRY_PICK_CONFLICT` rejection — identically: the
   * cherry-pick `conflict` is published, refs and the working tree are
   * refreshed, and `false` is returned so the dialog stays open with its warn
   * row. Any other failure goes to `refOpError`, leaves `conflict` untouched and
   * returns `false`.
   */
  async cherryPick(source: string, recordOrigin: boolean, noCommit: boolean): Promise<boolean> {
    const repoId = this.activeId();
    const trimmed = source.trim();
    if (!repoId || this.refOpRunning() || !trimmed) return false;

    this.refOpRunning.set(true);
    this.refOpError.set(null);
    try {
      const req: CherryPickRequest = { repoId, source: trimmed, recordOrigin, noCommit };
      const res = await this.bridge.invoke('cherryPick', req);
      await this.loadRefs();
      this.requestStatusRefresh();
      const conflicted = res.hasConflict === true;
      this.publishConflict('cherry-pick', conflicted, res.oid ?? '');
      return !conflicted;
    } catch (err) {
      const appError = toAppError(err);
      if (appError.code === 'CHERRY_PICK_CONFLICT') {
        this.refsOffline.set(false);
        await this.loadRefs();
        this.requestStatusRefresh();
        this.publishConflict('cherry-pick', true, conflictOidFrom(appError));
        return false;
      }
      this.handleRefOpError(appError);
      return false;
    } finally {
      this.refOpRunning.set(false);
    }
  }

  /**
   * Revert one revision on the current branch (`revert`, ADR-0042). Same shape
   * as {@link cherryPick}, with the revert `conflict` and `REVERT_CONFLICT`.
   */
  async revert(source: string): Promise<boolean> {
    const repoId = this.activeId();
    const trimmed = source.trim();
    if (!repoId || this.refOpRunning() || !trimmed) return false;

    this.refOpRunning.set(true);
    this.refOpError.set(null);
    try {
      const req: RevertRequest = { repoId, source: trimmed };
      const res = await this.bridge.invoke('revert', req);
      await this.loadRefs();
      this.requestStatusRefresh();
      const conflicted = res.hasConflict === true;
      this.publishConflict('revert', conflicted, res.oid ?? '');
      return !conflicted;
    } catch (err) {
      const appError = toAppError(err);
      if (appError.code === 'REVERT_CONFLICT') {
        this.refsOffline.set(false);
        await this.loadRefs();
        this.requestStatusRefresh();
        this.publishConflict('revert', true, conflictOidFrom(appError));
        return false;
      }
      this.handleRefOpError(appError);
      return false;
    } finally {
      this.refOpRunning.set(false);
    }
  }

  /**
   * Resolve `revision` for the cherry-pick preview (`resolveRevision`).
   *
   * Read-only: it never mutates the repository. The newest request wins — a
   * monotonic token discards a late response for a superseded revision so the
   * preview can never show a commit the user already typed past. A blank
   * revision clears the preview without a round-trip, and an unresolvable one
   * (`COMMIT_NOT_FOUND`) lands on `cherryPreviewError` for the dialog's
   * not-found row.
   */
  async resolveCherryPickSource(revision: string): Promise<void> {
    const repoId = this.activeId();
    const trimmed = revision.trim();
    const generation = ++this.cherryPreviewGeneration;

    if (!repoId || !trimmed) {
      this.cherryPreview.set(null);
      this.cherryPreviewLoading.set(false);
      this.cherryPreviewError.set(null);
      return;
    }

    this.cherryPreviewLoading.set(true);
    this.cherryPreviewError.set(null);
    // The card always belongs to the newest request: drop the previous one so a
    // stale commit is never shown beside the loading line.
    this.cherryPreview.set(null);
    try {
      const req: ResolveRevisionRequest = { repoId, revision: trimmed };
      const commit = await this.bridge.invoke('resolveRevision', req);
      if (generation !== this.cherryPreviewGeneration) return;
      this.cherryPreview.set(commit ?? null);
    } catch (err) {
      if (generation !== this.cherryPreviewGeneration) return;
      this.cherryPreview.set(null);
      if (isIpcUnavailable(err)) {
        this.refsOffline.set(true);
      } else {
        this.cherryPreviewError.set(toAppError(err));
      }
    } finally {
      if (generation === this.cherryPreviewGeneration) this.cherryPreviewLoading.set(false);
    }
  }

  /** Dismiss any conflict notice (merge, cherry-pick or revert). */
  dismissConflict(): void {
    this.conflict.set(null);
  }

  /**
   * Dismiss the merge conflict notice (the conflict itself is untouched). Kept
   * for callers that predate the general conflict state; it never clears
   * another operation's conflict.
   */
  dismissMergeConflict(): void {
    if (this.conflict()?.operation === 'merge') this.conflict.set(null);
  }

  /**
   * Publish (or clear) the conflict for `operation`. A clean result clears only
   * this operation's conflict so another operation's surfaced state survives.
   */
  private publishConflict(operation: ConflictOperation, hasConflict: boolean, oid: string): void {
    if (hasConflict) {
      this.conflict.set({ operation, hasConflict: true, oid });
      return;
    }
    if (this.conflict()?.operation === operation) this.conflict.set(null);
  }

  /** Clear the cherry-pick preview state and invalidate any in-flight resolve. */
  private resetCherryPreview(): void {
    this.cherryPreviewGeneration++;
    this.cherryPreview.set(null);
    this.cherryPreviewLoading.set(false);
    this.cherryPreviewError.set(null);
  }

  /** Drop the cherry-pick dialog and its preview (repository transitions). */
  private resetCherryPick(): void {
    this.cherryPickDialog.set(null);
    this.resetCherryPreview();
  }

  // -- stashes (ADR-028) ---------------------------------------------------

  /**
   * Load the active repository's stash stack (`getStashes`). Clears the list
   * without an active repo; records `stashesError` on failure and `refsOffline`
   * when the bridge is absent. A monotonic token discards late responses from a
   * repository that is no longer active.
   */
  async loadStashes(): Promise<void> {
    const id = this.activeId();
    const generation = ++this.stashesGeneration;
    this.stashesError.set(null);

    if (!id) {
      this.stashes.set([]);
      this.stashesLoading.set(false);
      return;
    }

    this.stashesLoading.set(true);
    try {
      const res = await this.bridge.invoke('getStashes', { repoId: id });
      if (generation !== this.stashesGeneration) return;
      this.stashes.set(res.stashes ?? []);
    } catch (err) {
      if (generation !== this.stashesGeneration) return;
      if (isIpcUnavailable(err)) {
        this.refsOffline.set(true);
      } else {
        this.stashesError.set(toAppError(err));
      }
      this.stashes.set([]);
    } finally {
      if (generation === this.stashesGeneration) this.stashesLoading.set(false);
    }
  }

  /**
   * Apply a stash entry (`stashApply`), optionally restoring it to the stack
   * (`restoreIndex`). No-ops without an active repo or while another stash op
   * runs. On success the stash list reloads and the working-tree consumers are
   * asked to refresh; on failure `IPC_UNAVAILABLE` maps to `refsOffline` and any
   * other error to `stashOpError`.
   */
  async stashApply(index: number, restoreIndex = false): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.stashOpRunning()) return false;

    this.stashOpRunning.set(true);
    this.stashOpError.set(null);
    try {
      await this.bridge.invoke('stashApply', { repoId, index, restoreIndex });
      await this.loadStashes();
      this.requestStatusRefresh();
      return true;
    } catch (err) {
      this.handleStashOpError(err);
      return false;
    } finally {
      this.stashOpRunning.set(false);
    }
  }

  /**
   * Pop a stash entry (`stashPop`): apply it and drop it from the stack. No-ops
   * without an active repo or while another stash op runs. Reloads the stash
   * list and refreshes the working tree on success.
   */
  async stashPop(index: number): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.stashOpRunning()) return false;

    this.stashOpRunning.set(true);
    this.stashOpError.set(null);
    try {
      await this.bridge.invoke('stashPop', { repoId, index });
      await this.loadStashes();
      this.requestStatusRefresh();
      return true;
    } catch (err) {
      this.handleStashOpError(err);
      return false;
    } finally {
      this.stashOpRunning.set(false);
    }
  }

  /**
   * Drop a stash entry (`stashDrop`) without applying it. No-ops without an
   * active repo or while another stash op runs. Reloads the stash list on
   * success (the working tree is untouched, so no status refresh).
   */
  async stashDrop(index: number): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.stashOpRunning()) return false;

    this.stashOpRunning.set(true);
    this.stashOpError.set(null);
    try {
      await this.bridge.invoke('stashDrop', { repoId, index });
      await this.loadStashes();
      return true;
    } catch (err) {
      this.handleStashOpError(err);
      return false;
    } finally {
      this.stashOpRunning.set(false);
    }
  }

  /** Clear a displayed stash-mutation failure (e.g. a dialog was dismissed). */
  clearStashOpError(): void {
    this.stashOpError.set(null);
  }

  private handleStashOpError(err: unknown): void {
    if (isIpcUnavailable(err)) {
      this.refsOffline.set(true);
    } else {
      this.stashOpError.set(toAppError(err));
    }
  }

  // -- git-flow presets (ADR-027) ------------------------------------------

  /**
   * Load the active repository's git-flow configuration (`getGitFlowConfig`).
   * The core returns conventional defaults for an unset repository. Clears the
   * config without an active repo; `IPC_UNAVAILABLE` maps to `refsOffline` and
   * any other failure to `gitFlowConfigError`.
   */
  async loadGitFlowConfig(): Promise<void> {
    const repoId = this.activeId();
    this.gitFlowConfigError.set(null);
    if (!repoId) {
      this.gitFlowConfig.set(null);
      this.gitFlowConfigLoading.set(false);
      return;
    }

    this.gitFlowConfigLoading.set(true);
    try {
      const config = await this.bridge.invoke('getGitFlowConfig', { repoId });
      this.gitFlowConfig.set(config);
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.refsOffline.set(true);
      } else {
        this.gitFlowConfigError.set(toAppError(err));
      }
    } finally {
      this.gitFlowConfigLoading.set(false);
    }
  }

  /**
   * Persist the git-flow configuration (`setGitFlowConfig`). No-ops without an
   * active repo or while a git-flow op runs. Stores the core-normalized config
   * returned by the call on success.
   */
  async saveGitFlowConfig(config: GitFlowConfig): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.gitFlowRunning()) return false;

    this.gitFlowRunning.set(true);
    this.gitFlowError.set(null);
    try {
      const saved = await this.bridge.invoke('setGitFlowConfig', { repoId, config });
      this.gitFlowConfig.set(saved);
      return true;
    } catch (err) {
      this.handleGitFlowError(err);
      return false;
    } finally {
      this.gitFlowRunning.set(false);
    }
  }

  /**
   * Start a git-flow workflow (`startGitFlow`): the core checks out the base and
   * creates/checks out the workflow branch. No-ops without an active repo, while
   * another git-flow op runs, or with a blank name. On success the refs, stashes
   * and working-tree consumers are refreshed and the result (steps) is published.
   */
  async startGitFlow(kind: GitFlowKindName, name: string, base: string): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.gitFlowRunning() || !name.trim()) return false;

    this.gitFlowRunning.set(true);
    this.gitFlowError.set(null);
    try {
      const req = { repoId, kind, name, base } as unknown as StartGitFlowRequest;
      const res = await this.bridge.invoke('startGitFlow', req);
      await this.loadRefs();
      await this.loadStashes();
      this.requestStatusRefresh();
      this.gitFlowResult.set(res);
      return true;
    } catch (err) {
      this.handleGitFlowError(err);
      return false;
    } finally {
      this.gitFlowRunning.set(false);
    }
  }

  /**
   * Finish a git-flow workflow (`finishGitFlow`): the core merges the workflow
   * branch per its kind, tags releases/hotfixes and optionally deletes the
   * branch. M3 surfaces conflicts instead of resolving them: a result with
   * `hasConflict` (or a `MERGE_CONFLICT` rejection) publishes a `merge`
   * conflict, refreshes refs/stashes/status and returns `true`; the tree stays
   * conflicted.
   */
  async finishGitFlow(
    kind: GitFlowKindName,
    name: string,
    deleteBranch: boolean,
  ): Promise<boolean> {
    const repoId = this.activeId();
    if (!repoId || this.gitFlowRunning() || !name.trim()) return false;

    this.gitFlowRunning.set(true);
    this.gitFlowError.set(null);
    try {
      const req = { repoId, kind, name, deleteBranch } as unknown as FinishGitFlowRequest;
      const res = await this.bridge.invoke('finishGitFlow', req);
      await this.loadRefs();
      await this.loadStashes();
      this.requestStatusRefresh();
      this.gitFlowResult.set(res);
      this.publishConflict('merge', res.hasConflict === true, '');
      return true;
    } catch (err) {
      const appError = toAppError(err);
      if (appError.code === 'MERGE_CONFLICT') {
        // The core reports conflicts as an error envelope; treat it as the same
        // surfaced state (tree stays conflicted) rather than a hard failure.
        this.refsOffline.set(false);
        await this.loadRefs();
        await this.loadStashes();
        this.requestStatusRefresh();
        this.gitFlowResult.set({ branch: '', steps: [], hasConflict: true });
        this.publishConflict('merge', true, '');
        return true;
      }
      this.handleGitFlowError(appError);
      return false;
    } finally {
      this.gitFlowRunning.set(false);
    }
  }

  /** Clear a displayed git-flow failure (e.g. a dialog was dismissed). */
  clearGitFlowError(): void {
    this.gitFlowError.set(null);
  }

  /** Dismiss the last git-flow result (the workflow state is untouched). */
  dismissGitFlowResult(): void {
    this.gitFlowResult.set(null);
  }

  private handleGitFlowError(err: unknown): void {
    if (isIpcUnavailable(err)) {
      this.refsOffline.set(true);
    } else {
      this.gitFlowError.set(toAppError(err));
    }
  }

  /** Bump the working-tree refresh token observed by route-scoped consumers. */
  private requestStatusRefresh(): void {
    this.statusRefreshState.update((value) => value + 1);
  }

  private handleRefOpError(err: unknown): void {
    if (isIpcUnavailable(err)) {
      this.refsOffline.set(true);
    } else {
      this.refOpError.set(toAppError(err));
    }
  }
}
