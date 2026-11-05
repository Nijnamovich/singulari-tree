import { Injectable, computed, inject, signal, type WritableSignal } from '@angular/core';
import type { Commit, Diff, FileDiff, FileStatus } from '@contracts/domain';
import type {
  CommitRequest,
  DiscardHunkRequest,
  DiscardRequest,
  GetDiffRequest,
  GetStatusRequest,
  StageHunkRequest,
  StageRequest,
  UnstageHunkRequest,
  UnstageRequest,
} from '@contracts/gitcore';
import { IpcBridge, toAppError, type AppError } from '@core/services/ipc-bridge.service';

function isIpcUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'IPC_UNAVAILABLE'
  );
}

/** Empty working-tree side: `getDiff` treats the empty oid as the worktree. */
const WORKTREE_OID = '';

/** Which diff the viewer is currently showing, so mutations refresh the right one. */
export type DiffContext = 'worktree' | 'commit' | null;

/** Hunk/line mutation methods exposed by the bridge. */
type HunkMutation = 'stageHunk' | 'unstageHunk' | 'discardHunk';

/**
 * Signal store for the working tree (status + diff + staging + commit).
 *
 * Mirrors `GraphStore`: it is the single renderer-side owner of the
 * `getStatus`/`stage`/`unstage`/`stageHunk`/`unstageHunk`/`discardHunk`/
 * `discard`/`commit`/`getDiff` IPC calls and never talks to Git directly. The
 * bridge is a constructor parameter (defaulting to DI) so the store can be
 * unit-tested without TestBed.
 *
 * ADR-0020: the renderer never builds patches. It addresses a file, hunk or
 * line by indices (`path`/`hunkIndex`/`lineIndices`) and the core re-derives and
 * applies the patch. Two diffs feed the UI:
 *
 * - `unstagedDiff` — HEAD→worktree (`staged: false`): the Stage/Discard substrate.
 * - `stagedDiff` — HEAD→index (`staged: true`): the Unstage substrate.
 *
 * `diff` remains the diff currently shown by the viewer (worktree or a commit);
 * `diffContext` records which, so a mutation only overwrites the viewer when it
 * is actually displaying the worktree diff.
 */
@Injectable()
export class StatusStore {
  private readonly bridge: IpcBridge;

  constructor(bridge: IpcBridge = inject(IpcBridge)) {
    this.bridge = bridge;
  }

  // -- state ---------------------------------------------------------------
  readonly repoId = signal<string | null>(null);
  /** Hex of the currently checked-out HEAD commit, used as the `from` side. */
  readonly headOid = signal<string | null>(null);
  readonly files = signal<FileStatus[]>([]);
  readonly loading = signal(false);
  readonly error = signal<AppError | null>(null);
  readonly selectedPath = signal<string | null>(null);
  readonly commitMessage = signal('');
  readonly commitError = signal<AppError | null>(null);
  /** Diff currently shown by the viewer (worktree when `diffContext` is `worktree`). */
  readonly diff = signal<Diff | null>(null);
  /** Which diff `diff` currently holds; drives post-mutation refresh. */
  readonly diffContext = signal<DiffContext>(null);
  readonly diffLoading = signal(false);
  readonly diffError = signal<AppError | null>(null);
  /** HEAD→worktree diff: Stage/Discard addressing substrate (ADR-0020). */
  readonly unstagedDiff = signal<Diff | null>(null);
  readonly unstagedDiffLoading = signal(false);
  readonly unstagedDiffError = signal<AppError | null>(null);
  /** HEAD→index diff: Unstage addressing substrate (ADR-0020). */
  readonly stagedDiff = signal<Diff | null>(null);
  readonly stagedDiffLoading = signal(false);
  readonly stagedDiffError = signal<AppError | null>(null);
  /** True when the renderer runs without the Electron preload bridge. */
  readonly offline = signal(false);
  /**
   * Monotonic counter bumped after a successful commit: the graph watches it
   * and reloads its window (the HEAD node moved).
   */
  readonly graphReloadRequested = signal(0);

  // -- derived -------------------------------------------------------------
  readonly stagedFiles = computed(() => this.files().filter((file) => file.isStaged));
  readonly unstagedFiles = computed(() => this.files().filter((file) => !file.isStaged));
  readonly hasStaged = computed(() => this.stagedFiles().length > 0);
  readonly canCommit = computed(
    () => this.hasStaged() && this.commitMessage().trim().length > 0 && !this.loading(),
  );

  /** Per-file sections of the worktree diff (Stage/Discard). */
  readonly unstagedDiffFiles = computed<FileDiff[]>(() => this.unstagedDiff()?.files ?? []);
  /** Per-file sections of the staged diff (Unstage). */
  readonly stagedDiffFiles = computed<FileDiff[]>(() => this.stagedDiff()?.files ?? []);
  /** True when the displayed diff was capped by the core (ADR-0020 (c)). */
  readonly diffTruncated = computed(() => this.diff()?.truncated === true);
  readonly unstagedDiffTruncated = computed(() => this.unstagedDiff()?.truncated === true);
  readonly stagedDiffTruncated = computed(() => this.stagedDiff()?.truncated === true);

  // -- actions -------------------------------------------------------------

  /** Point the store at a repository (null clears it). */
  setRepoId(id: string | null): void {
    this.repoId.set(id);
  }

  /** Record the current HEAD oid so `loadWorkingTreeDiff` has a `from` side. */
  setHeadOid(oid: string | null): void {
    this.headOid.set(oid);
  }

  /** Load the porcelain status for the current repository. */
  async loadStatus(): Promise<void> {
    const id = this.repoId();
    if (!id) return;

    this.loading.set(true);
    this.error.set(null);

    const req: GetStatusRequest = { repoId: id };
    try {
      const resp = await this.bridge.invoke('getStatus', req);
      this.offline.set(false);
      const files = resp.files ?? [];
      this.files.set(files);
      // Drop a stale file selection if the path vanished from the status.
      const selected = this.selectedPath();
      if (selected && !files.some((file) => file.path === selected)) {
        this.selectedPath.set(null);
      }
    } catch (err) {
      if (isIpcUnavailable(err)) {
        // Degrade to an empty working tree instead of crashing a plain browser.
        this.offline.set(true);
        this.files.set([]);
      } else {
        this.error.set(toAppError(err));
      }
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Select a status row and load the worktree + staged diffs it belongs to.
   * Both addressing substrates are loaded so the hunk-action list can offer
   * Stage/Discard (unstaged) and Unstage (staged) for the selected path.
   */
  setSelectedPath(path: string | null): void {
    this.selectedPath.set(path);
    if (path) {
      void this.loadWorkingTreeDiff();
      void this.loadStagedDiff();
    }
  }

  /** Update the commit message buffer (clears any previous commit error). */
  setMessage(message: string): void {
    this.commitMessage.set(message);
    this.commitError.set(null);
  }

  /** Stage the given paths, then refresh the status and diffs. */
  async stage(paths: string[]): Promise<void> {
    await this.mutate('stage', paths);
  }

  /** Unstage the given paths, then refresh the status and diffs. */
  async unstage(paths: string[]): Promise<void> {
    await this.mutate('unstage', paths);
  }

  /**
   * Stage a hunk (or the selected changed lines of a hunk) by index. An empty
   * `lineIndices` means "the whole hunk" (ADR-0020).
   */
  async stageHunk(path: string, hunkIndex: number, lineIndices: number[] = []): Promise<void> {
    await this.mutateHunk('stageHunk', path, hunkIndex, lineIndices);
  }

  /** Unstage a hunk (or selected lines) by index. */
  async unstageHunk(path: string, hunkIndex: number, lineIndices: number[] = []): Promise<void> {
    await this.mutateHunk('unstageHunk', path, hunkIndex, lineIndices);
  }

  /**
   * Discard a hunk (or selected lines) from the worktree. Destructive: the
   * component confirms before calling for file-level discard.
   */
  async discardHunk(path: string, hunkIndex: number, lineIndices: number[] = []): Promise<void> {
    await this.mutateHunk('discardHunk', path, hunkIndex, lineIndices);
  }

  /**
   * Discard whole files. Tracked paths are restored from HEAD/index; untracked
   * paths are removed (their only discard path, ADR-0020 (b)).
   */
  async discardFiles(paths: string[]): Promise<void> {
    const id = this.repoId();
    if (!id || paths.length === 0) return;

    const req: DiscardRequest = { repoId: id, paths };
    try {
      await this.bridge.invoke('discard', req);
      this.offline.set(false);
      await this.refreshAfterMutation();
    } catch (err) {
      this.handleMutationError(err);
    }
  }

  /**
   * Commit the staged changes with the current message. On success the message
   * is cleared, the status reloaded and the graph told to reload.
   */
  async commit(): Promise<void> {
    const id = this.repoId();
    if (!id || !this.canCommit()) return;

    this.loading.set(true);
    this.commitError.set(null);

    const req: CommitRequest = {
      repoId: id,
      message: this.commitMessage(),
      author: undefined,
    };
    try {
      await this.bridge.invoke('commit', req);
      this.offline.set(false);
      this.commitMessage.set('');
      this.selectedPath.set(null);
      this.graphReloadRequested.update((value) => value + 1);
      await this.loadStatus();
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
      } else {
        this.commitError.set(toAppError(err));
      }
    } finally {
      this.loading.set(false);
    }
  }

  /** Diff HEAD → working tree (`to` is the empty oid). */
  async loadWorkingTreeDiff(): Promise<void> {
    const id = this.repoId();
    if (!id) return;
    this.diffContext.set('worktree');
    await this.loadDiff(
      this.diff,
      this.diffLoading,
      this.diffError,
      id,
      this.headOid() ?? WORKTREE_OID,
      WORKTREE_OID,
      false,
    );
    // The worktree diff doubles as the Stage/Discard addressing substrate.
    this.unstagedDiff.set(this.diff());
  }

  /** Diff HEAD → index (`git diff --cached`): the Unstage addressing substrate. */
  async loadStagedDiff(): Promise<void> {
    const id = this.repoId();
    if (!id) return;
    await this.loadDiff(
      this.stagedDiff,
      this.stagedDiffLoading,
      this.stagedDiffError,
      id,
      this.headOid() ?? WORKTREE_OID,
      WORKTREE_OID,
      true,
    );
  }

  /**
   * Diff the commit against its first parent (or the empty tree for a root).
   *
   * Kept as a store capability after ADR-0030 removed the graph-route panel
   * that used to drive it: the viewer/substrate coupling is gone on purpose,
   * and the file-status screen diffs commits through its own `loadOwnDiff`.
   * The History aside reads a commit's file list through the non-mutating
   * `readCommitChangedFiles` below (ADR-032), never through this viewer-diff
   * method — so a History selection can no longer clobber the viewer it used to.
   */
  async loadCommitDiff(commit: Commit): Promise<void> {
    const id = this.repoId();
    if (!id) return;
    this.diffContext.set('commit');
    const from = commit.parents[0]?.hex ?? WORKTREE_OID;
    const to = commit.oid?.hex ?? WORKTREE_OID;
    await this.loadDiff(this.diff, this.diffLoading, this.diffError, id, from, to, false);
  }

  /**
   * Read only the changed-file paths of one commit (first parent → commit, or
   * the empty tree → commit for a root), for the History aside's read-only
   * file-list tooltip (ADR-032).
   *
   * This is a *read*: unlike `loadCommitDiff` it writes none of the viewer
   * substrates (`diff`/`diffContext`) nor the addressing substrates
   * (`unstagedDiff`/`stagedDiff`), so a History selection can never disturb the
   * File-status viewer or its staging state. It reuses the same `getDiff` RPC
   * the File status screen uses — no new RPC, IPC channel or Go-core surface
   * (ADR-032 item 3), and it never talks to Git directly.
   *
   * Failure degrades and never throws: `IPC_UNAVAILABLE` flips `offline` and
   * yields an empty list, any other error is recorded on `error` and also
   * yields an empty list. The tooltip is read-only chrome, so a failed read
   * must not break the aside.
   */
  async readCommitChangedFiles(commit: Commit): Promise<readonly string[]> {
    const id = this.repoId();
    if (!id) return [];
    const from = commit.parents[0]?.hex ?? WORKTREE_OID;
    const to = commit.oid?.hex ?? WORKTREE_OID;
    try {
      const diff = await this.fetchDiff(id, from, to, false);
      this.offline.set(false);
      return diff.files.map((file) => file.path);
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
        return [];
      }
      this.error.set(toAppError(err));
      return [];
    }
  }

  /** Invalidate + reload the working tree status (fs:changed / external mutation). */
  reload(): void {
    void this.loadStatus();
  }

  private async mutate(method: 'stage' | 'unstage', paths: string[]): Promise<void> {
    const id = this.repoId();
    if (!id || paths.length === 0) return;

    const req: StageRequest | UnstageRequest = { repoId: id, paths };
    try {
      await this.bridge.invoke(method, req);
      this.offline.set(false);
      await this.refreshAfterMutation();
    } catch (err) {
      this.handleMutationError(err);
    }
  }

  private async mutateHunk(
    method: HunkMutation,
    path: string,
    hunkIndex: number,
    lineIndices: number[],
  ): Promise<void> {
    const id = this.repoId();
    if (!id) return;

    const req: StageHunkRequest | UnstageHunkRequest | DiscardHunkRequest = {
      repoId: id,
      path,
      hunkIndex,
      lineIndices,
    };
    try {
      await this.bridge.invoke(method, req);
      this.offline.set(false);
      await this.refreshAfterMutation();
    } catch (err) {
      this.handleMutationError(err);
    }
  }

  /**
   * After a working-tree mutation: refresh the status and both addressing
   * substrates, and only re-render the viewer when it is showing the worktree
   * diff (a commit diff must stay put).
   */
  private async refreshAfterMutation(): Promise<void> {
    await this.loadStatus();
    if (this.diffContext() === 'worktree') {
      await this.loadWorkingTreeDiff();
      await this.loadStagedDiff();
      return;
    }
    await Promise.all([this.loadUnstagedAddressing(), this.loadStagedDiff()]);
  }

  /** Refresh only the worktree addressing substrate (no viewer overwrite). */
  private async loadUnstagedAddressing(): Promise<void> {
    const id = this.repoId();
    if (!id) return;
    await this.loadDiff(
      this.unstagedDiff,
      this.unstagedDiffLoading,
      this.unstagedDiffError,
      id,
      this.headOid() ?? WORKTREE_OID,
      WORKTREE_OID,
      false,
    );
  }

  private handleMutationError(err: unknown): void {
    if (isIpcUnavailable(err)) {
      this.offline.set(true);
    } else {
      this.error.set(toAppError(err));
    }
  }

  private async loadDiff(
    target: WritableSignal<Diff | null>,
    loading: WritableSignal<boolean>,
    errorSignal: WritableSignal<AppError | null>,
    id: string,
    from: string,
    to: string,
    staged: boolean,
  ): Promise<void> {
    loading.set(true);
    errorSignal.set(null);

    try {
      const diff = await this.fetchDiff(id, from, to, staged);
      this.offline.set(false);
      target.set(diff);
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.offline.set(true);
        target.set(null);
      } else {
        errorSignal.set(toAppError(err));
      }
    } finally {
      loading.set(false);
    }
  }

  /**
   * The single `getDiff` call the two diff readers share: the viewer/addressing
   * loader (`loadDiff`) and the read-only commit file-list read
   * (`readCommitChangedFiles`). No new RPC — the same request shape ADR-0020
   * pinned. Deliberately not `async`: it returns the bridge promise unchanged so
   * a caller's `await` costs exactly the same single tick it did inline before.
   */
  private fetchDiff(id: string, from: string, to: string, staged: boolean): Promise<Diff> {
    // `path: ''` = all changed files; `staged` selects HEAD->index vs
    // HEAD->worktree (ADR-0020 GetDiffRequest evolution).
    const req: GetDiffRequest = { repoId: id, from, to, path: '', staged };
    return this.bridge.invoke('getDiff', req);
  }
}
