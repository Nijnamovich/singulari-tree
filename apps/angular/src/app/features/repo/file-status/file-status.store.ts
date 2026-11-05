import { Injectable, computed, inject, signal } from '@angular/core';
import type { Branch, Commit, Diff, FileDiff, FileStatus } from '@contracts/domain';
import type {
  GetBranchesRequest,
  GetBranchesResponse,
  GetDiffRequest,
} from '@contracts/gitcore';
import { IpcBridge, toAppError, type AppError } from '@core/services/ipc-bridge.service';
import { StatusStore } from '../status/status.store';
import type { FileStatusVariant, ResolvedBaseRef } from './file-status.models';
import { findRefOid, resolveBaseRef } from './file-status-mappers';

function isIpcUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'IPC_UNAVAILABLE'
  );
}

/** Error code recorded when the PR base/target oids cannot be resolved. */
const PR_REFS_UNRESOLVED = 'PR_REFS_UNRESOLVED';

/**
 * Signal store for the "File Status" screen (local worktree / commit / PR
 * variants).
 *
 * Ownership boundary: the store is the single renderer-side owner of the
 * `getBranches`/`getDiff` calls needed by the commit and PR variants, and it
 * **composes** the route-scoped `StatusStore` for everything the working tree
 * already owns — the file list, both ADR-0020 hunk/file mutations and the
 * worktree/staged addressing substrate. `StatusStore` is used as-is (no edits),
 * so the existing working-tree panel cannot regress; the local variant reads
 * `status.diff()` instead of an own diff.
 *
 * ADR-0020: the renderer never builds patches. A hunk or a line is addressed by
 * index (`path` + `hunkIndex` + `lineIndices`) and the core re-derives and
 * applies the patch; the mutations below are therefore thin delegations to
 * `StatusStore`.
 *
 * The bridge is a constructor parameter (defaulting to DI) so the store can be
 * unit-tested without TestBed, and like `StatusStore`/`GraphStore` it is
 * `@Injectable()` with no `providedIn` (route-scoped).
 */
@Injectable()
export class FileStatusStore {
  private readonly bridge: IpcBridge;

  constructor(
    bridge: IpcBridge = inject(IpcBridge),
    private readonly status: StatusStore = inject(StatusStore),
  ) {
    this.bridge = bridge;
  }

  // -- state ---------------------------------------------------------------
  readonly repoId = signal<string | null>(null);
  readonly variant = signal<FileStatusVariant>('local');
  readonly selectedPath = signal<string | null>(null);
  /**
   * The whole diff of the `commit`/`pr` variants (their own). Never conflated
   * with `StatusStore.diff()`, which stays the worktree viewer diff.
   */
  readonly commitDiff = signal<Diff | null>(null);
  readonly diffLoading = signal(false);
  readonly diffError = signal<AppError | null>(null);
  readonly activeCommit = signal<Commit | null>(null);
  readonly branches = signal<Branch[]>([]);
  readonly branchesLoading = signal(false);
  readonly branchesError = signal<AppError | null>(null);
  readonly baseRef = signal('');
  readonly baseRefOid = signal('');
  readonly targetRef = signal('');
  readonly targetRefOid = signal('');

  // -- derived -------------------------------------------------------------
  /** Diff shown by the viewer: the worktree one locally, the own one otherwise. */
  readonly wholeDiff = computed<Diff | null>(() =>
    this.variant() === 'local' ? this.status.diff() : this.commitDiff(),
  );
  readonly diffFiles = computed<FileDiff[]>(() => this.wholeDiff()?.files ?? []);
  readonly truncated = computed(() => this.wholeDiff()?.truncated === true);
  readonly stagedFiles = computed<FileStatus[]>(() => this.status.stagedFiles());
  readonly unstagedFiles = computed<FileStatus[]>(() => this.status.unstagedFiles());
  readonly filesLoading = computed(() => this.status.loading());
  readonly statusError = computed(() => this.status.error()?.message ?? null);
  readonly commitError = computed(() => this.status.commitError()?.message ?? null);
  readonly commitMessage = computed(() => this.status.commitMessage());
  readonly rightLoading = computed(() =>
    this.variant() === 'local' ? this.status.diffLoading() : this.diffLoading(),
  );
  readonly rightError = computed(() =>
    this.variant() === 'local'
      ? this.status.diffError()?.message ?? null
      : this.diffError()?.message ?? null,
  );
  readonly selectedUnstagedFile = computed<FileDiff | null>(
    () => this.status.unstagedDiffFiles().find((file) => file.path === this.selectedPath()) ?? null,
  );
  readonly selectedStagedFile = computed<FileDiff | null>(
    () => this.status.stagedDiffFiles().find((file) => file.path === this.selectedPath()) ?? null,
  );
  readonly graphReloadRequested = computed(() => this.status.graphReloadRequested());
  readonly isLocal = computed(() => this.variant() === 'local');

  // -- actions -------------------------------------------------------------

  /** Point the screen at a repository (null clears it), locally and in `StatusStore`. */
  setRepoId(id: string | null): void {
    this.repoId.set(id);
    this.status.setRepoId(id);
  }

  /** Record the current HEAD oid so the worktree diff has its `from` side. */
  setHeadOid(oid: string | null): void {
    this.status.setHeadOid(oid);
  }

  /**
   * Open the local (working tree) variant: reload the status and both diffs,
   * the worktree one for the viewer and the staged one so the Unstage
   * substrate is ready. `commitDiff` is left untouched (cheap: `wholeDiff` no
   * longer reads it while `variant` is `local`).
   */
  async openLocal(): Promise<void> {
    this.variant.set('local');
    this.selectedPath.set(null);
    await this.status.loadStatus();
    await this.status.loadWorkingTreeDiff();
    await this.status.loadStagedDiff();
  }

  /**
   * Open the commit variant: diff the commit against its first parent, or
   * against the empty tree for a root commit (the core already handles the
   * empty `from` oid).
   */
  async openCommit(commit: Commit): Promise<void> {
    this.variant.set('commit');
    this.activeCommit.set(commit);
    await this.loadOwnDiff(commit.parents?.[0]?.hex ?? '', commit.oid?.hex ?? '');
  }

  /**
   * Open the PR variant: resolve the base (defaulting to `main`/`master`) and a
   * target, then diff base → target. An unresolved side degrades to a
   * `PR_REFS_UNRESOLVED` error instead of throwing.
   */
  async openPr(): Promise<void> {
    this.variant.set('pr');
    if (this.branches().length === 0) {
      await this.loadBranches();
    }
    await this.resolveDefaultBase();

    // Default the target to the current branch unless it already points
    // somewhere else than the base.
    if (!this.targetRef() || this.targetRefOid() === this.baseRefOid()) {
      const current = this.branches().find((b) => !b.isRemote && b.isCurrent && !!b.tip?.hex);
      if (current) {
        this.targetRef.set(current.name);
        this.targetRefOid.set(current.tip?.hex ?? '');
      }
    }

    await this.loadPrDiff();
  }

  /** Load the local + remote-tracking branches of the current repository. */
  async loadBranches(): Promise<void> {
    const id = this.repoId();
    if (!id) return;

    this.branchesLoading.set(true);
    this.branchesError.set(null);

    const req: GetBranchesRequest = { repoId: id };
    try {
      const resp: GetBranchesResponse = await this.bridge.invoke('getBranches', req);
      this.branches.set(resp.branches ?? []);
    } catch (err) {
      if (isIpcUnavailable(err)) {
        // Degrade to an empty ref list instead of crashing a plain browser.
        this.branches.set([]);
        this.branchesError.set(null);
      } else {
        this.branchesError.set(toAppError(err));
      }
    } finally {
      this.branchesLoading.set(false);
    }
  }

  /** Resolve (and remember) the default PR base; `null` when nothing qualifies. */
  async resolveDefaultBase(): Promise<ResolvedBaseRef | null> {
    if (this.branches().length === 0) {
      await this.loadBranches();
    }
    const resolved = resolveBaseRef(this.branches());
    if (resolved) {
      this.baseRef.set(resolved.name);
      this.baseRefOid.set(resolved.oid);
    }
    return resolved;
  }

  /** Override the PR base by ref name and re-issue the PR diff when possible. */
  setBaseRef(name: string): void {
    this.baseRef.set(name);
    this.baseRefOid.set(findRefOid(this.branches(), name) ?? '');
    this.refreshPrDiff();
  }

  /** Override the PR target by ref name and re-issue the PR diff when possible. */
  setTargetRef(name: string): void {
    this.targetRef.set(name);
    this.targetRefOid.set(findRefOid(this.branches(), name) ?? '');
    this.refreshPrDiff();
  }

  /**
   * Select a file in the list. In the local variant the selection is forwarded
   * to `StatusStore` so the hunk addressing substrate is loaded (ADR-0020); the
   * commit/PR variants have no such substrate.
   */
  selectFile(path: string | null): void {
    this.selectedPath.set(path);
    if (this.variant() === 'local' && path) {
      this.status.setSelectedPath(path);
    }
  }

  /** Reset every PR/commit signal back to the local variant. */
  clearVariant(): void {
    this.variant.set('local');
    this.activeCommit.set(null);
    this.commitDiff.set(null);
    this.selectedPath.set(null);
    this.branches.set([]);
    this.baseRef.set('');
    this.baseRefOid.set('');
    this.targetRef.set('');
    this.targetRefOid.set('');
    this.diffError.set(null);
    this.branchesError.set(null);
  }

  // -- mutations (thin delegations to StatusStore, ADR-0020) ----------------

  async stage(paths: string[]): Promise<void> {
    await this.status.stage(paths);
  }

  async unstage(paths: string[]): Promise<void> {
    await this.status.unstage(paths);
  }

  async stageHunk(path: string, hunkIndex: number, lineIndices: number[] = []): Promise<void> {
    await this.status.stageHunk(path, hunkIndex, lineIndices);
  }

  async unstageHunk(path: string, hunkIndex: number, lineIndices: number[] = []): Promise<void> {
    await this.status.unstageHunk(path, hunkIndex, lineIndices);
  }

  async discardHunk(path: string, hunkIndex: number, lineIndices: number[] = []): Promise<void> {
    await this.status.discardHunk(path, hunkIndex, lineIndices);
  }

  async discardFiles(paths: string[]): Promise<void> {
    await this.status.discardFiles(paths);
  }

  setMessage(message: string): void {
    this.status.setMessage(message);
  }

  async commit(): Promise<void> {
    await this.status.commit();
  }

  // -- internals -----------------------------------------------------------

  /**
   * Re-issue the PR diff after a base/target override. Only when both oids are
   * already known, so an unknown ref never fires a doomed `getDiff` (and never
   * clears the error the user needs to see).
   */
  private refreshPrDiff(): void {
    if (this.variant() !== 'pr') return;
    if (!this.baseRefOid() || !this.targetRefOid()) return;
    void this.loadPrDiff();
  }

  /**
   * Diff base → target for the PR variant. An unresolved side records
   * `PR_REFS_UNRESOLVED` (the refs must be resolved before the core can diff
   * them) and leaves the previously loaded diff in place.
   */
  private async loadPrDiff(): Promise<void> {
    const from = this.baseRefOid();
    const to = this.targetRefOid();
    if (!from || !to) {
      this.diffError.set({
        code: PR_REFS_UNRESOLVED,
        message: 'The PR base and target refs could not be resolved to a commit.',
      });
      return;
    }
    await this.loadOwnDiff(from, to);
  }

  /**
   * Load the store-owned diff (commit/PR variants) into `commitDiff`. Mirrors
   * `StatusStore.loadDiff`: `path: ''` selects every changed file, an explicit
   * `staged` boolean picks HEAD→index vs HEAD→commit, and an unavailable IPC
   * bridge degrades instead of surfacing an error.
   */
  private async loadOwnDiff(from: string, to: string): Promise<void> {
    const id = this.repoId();
    if (!id) return;

    this.diffLoading.set(true);
    this.diffError.set(null);

    const req: GetDiffRequest = { repoId: id, from, to, path: '', staged: false };
    try {
      const diff = await this.bridge.invoke('getDiff', req);
      this.commitDiff.set(diff);
    } catch (err) {
      if (isIpcUnavailable(err)) {
        this.commitDiff.set(null);
        this.diffError.set(null);
      } else {
        this.diffError.set(toAppError(err));
      }
    } finally {
      this.diffLoading.set(false);
    }
  }
}
