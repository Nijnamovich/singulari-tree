import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, Diff, FileDiff, FileStatus, Hunk } from '@contracts/domain';
import type { GetStatusResponse } from '@contracts/gitcore';
import { IpcBridge } from '@core/services/ipc-bridge.service';
import { StatusStore } from './status.store';

function file(path: string, isStaged: boolean, overrides: Partial<FileStatus> = {}): FileStatus {
  return {
    path,
    staged: isStaged ? 'M' : ' ',
    unstaged: isStaged ? ' ' : 'M',
    isStaged,
    isConflicted: false,
    ...overrides,
  };
}

function commit(hex: string, parents: string[] = []): Commit {
  return {
    oid: { hex, kind: 'SHA1' },
    parents: parents.map((p) => ({ hex: p, kind: 'SHA1' })),
    author: undefined,
    committer: undefined,
    message: 'msg',
    treeOid: undefined,
    committedAt: '2026-01-01T00:00:00Z',
    refs: [],
  };
}

function diff(): Diff {
  return {
    from: undefined,
    to: undefined,
    hunks: [],
    additions: 1,
    deletions: 0,
    isBinary: false,
    hasConflictMarkers: false,
    files: [],
    truncated: false,
  };
}

function hunk(): Hunk {
  return {
    fromStart: 1,
    fromLines: 1,
    toStart: 1,
    toLines: 1,
    lines: [{ kind: 'added', text: 'x', noNewline: false }],
  };
}

function fileDiff(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    oldPath: '',
    status: 'M',
    hunks: [hunk()],
    additions: 1,
    deletions: 0,
    isBinary: false,
    hasConflictMarkers: false,
    ...overrides,
  };
}

type Handler = (req: unknown) => unknown;
type Handlers = Partial<
  Record<
    | 'getStatus'
    | 'stage'
    | 'unstage'
    | 'stageHunk'
    | 'unstageHunk'
    | 'discardHunk'
    | 'discard'
    | 'commit'
    | 'getDiff',
    Handler
  >
>;

function makeBridge(handlers: Handlers): IpcBridge {
  return {
    invoke: vi.fn((method: string, req: unknown) => {
      const handler = handlers[method as keyof Handlers];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return handler(req);
    }),
  } as unknown as IpcBridge;
}

function storeWith(handlers: Handlers, repoId = 'repo-1'): StatusStore {
  const store = new StatusStore(makeBridge(handlers));
  store.setRepoId(repoId);
  return store;
}

const FILES: FileStatus[] = [file('b.ts', true), file('a.ts', false)];

describe('StatusStore', () => {
  let store: StatusStore;

  beforeEach(() => {
    store = storeWith({ getStatus: () => ({ files: FILES }) });
  });

  it('loads status and derives staged/unstaged/canCommit', async () => {
    await store.loadStatus();

    expect(store.files()).toHaveLength(2);
    expect(store.stagedFiles().map((f) => f.path)).toEqual(['b.ts']);
    expect(store.unstagedFiles().map((f) => f.path)).toEqual(['a.ts']);
    expect(store.hasStaged()).toBe(true);
    expect(store.canCommit()).toBe(false); // no message yet
    expect(store.offline()).toBe(false);
    expect(store.error()).toBeNull();

    store.setMessage('feat: x');
    expect(store.canCommit()).toBe(true);
  });

  it('is a no-op without a repository', async () => {
    const getStatus = vi.fn(() => Promise.resolve({ files: FILES }));
    store = new StatusStore(makeBridge({ getStatus }));

    await store.loadStatus();

    expect(getStatus).not.toHaveBeenCalled();
  });

  it('degrades to an empty tree when the IPC bridge is unavailable', async () => {
    store = storeWith({
      getStatus: () => {
        throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
      },
    });
    store.files.set(FILES);

    await store.loadStatus();

    expect(store.offline()).toBe(true);
    expect(store.error()).toBeNull();
    expect(store.files()).toEqual([]);
  });

  it('records non-IPC status failures on the error signal', async () => {
    store = storeWith({
      getStatus: () => Promise.reject({ code: 'GIT_FAILED', message: 'boom' }),
    });

    await store.loadStatus();

    expect(store.error()).toEqual({ code: 'GIT_FAILED', message: 'boom', details: {} });
    expect(store.offline()).toBe(false);
  });

  it('clears a stale selected path when it disappears from status', async () => {
    await store.loadStatus();
    store.selectedPath.set('gone.ts');

    await store.loadStatus();

    expect(store.selectedPath()).toBeNull();
  });

  it('stages paths then refreshes the status', async () => {
    const stage = vi.fn(() => Promise.resolve({}));
    const getStatus = vi.fn(() => Promise.resolve<GetStatusResponse>({ files: FILES }));
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    store = storeWith({ stage, getStatus, getDiff });

    await store.stage(['a.ts']);

    expect(stage).toHaveBeenCalledWith({ repoId: 'repo-1', paths: ['a.ts'] });
    expect(getStatus).toHaveBeenCalledTimes(1);
    // Both addressing substrates are refreshed (worktree + staged).
    expect(getDiff).toHaveBeenCalledWith(
      expect.objectContaining({ staged: false, path: '' }),
    );
    expect(getDiff).toHaveBeenCalledWith(
      expect.objectContaining({ staged: true, path: '' }),
    );
  });

  it('does nothing when staging an empty path list', async () => {
    const stage = vi.fn(() => Promise.resolve({}));
    store = storeWith({ stage });

    await store.stage([]);

    expect(stage).not.toHaveBeenCalled();
  });

  it('unstages paths then refreshes the status', async () => {
    const unstage = vi.fn(() => Promise.resolve({}));
    const getStatus = vi.fn(() => Promise.resolve<GetStatusResponse>({ files: FILES }));
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    store = storeWith({ unstage, getStatus, getDiff });

    await store.unstage(['b.ts']);

    expect(unstage).toHaveBeenCalledWith({ repoId: 'repo-1', paths: ['b.ts'] });
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('maps non-IPC stage failures and degrades IPC_UNAVAILABLE', async () => {
    store = storeWith({
      stage: () => Promise.reject({ code: 'GIT_FAILED', message: 'nope' }),
    });
    await store.stage(['a.ts']);
    expect(store.error()).toEqual({ code: 'GIT_FAILED', message: 'nope', details: {} });

    store = storeWith({
      stage: () => {
        throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
      },
    });
    await store.stage(['a.ts']);
    expect(store.offline()).toBe(true);
    expect(store.error()).toBeNull();
  });

  it('does nothing when unstaging an empty path list', async () => {
    const unstage = vi.fn(() => Promise.resolve({}));
    store = storeWith({ unstage });

    await store.unstage([]);

    expect(unstage).not.toHaveBeenCalled();
  });

  it('sets the message and clears a previous commit error', () => {
    store.commitError.set({ code: 'GIT_FAILED', message: 'old', details: {} });
    store.setMessage('hello');

    expect(store.commitMessage()).toBe('hello');
    expect(store.commitError()).toBeNull();
  });

  it('refuses to commit without staged files', async () => {
    const commitFn = vi.fn(() => Promise.resolve(commit('c'.repeat(40))));
    store = storeWith({ getStatus: () => ({ files: [] }), commit: commitFn });
    store.setMessage('msg');

    await store.commit();

    expect(commitFn).not.toHaveBeenCalled();
  });

  it('commits, clears the message, reloads status and asks the graph to reload', async () => {
    const commitFn = vi.fn(() => Promise.resolve(commit('c'.repeat(40))));
    const getStatus = vi.fn(() => Promise.resolve<GetStatusResponse>({ files: FILES }));
    store = storeWith({ getStatus, commit: commitFn });
    await store.loadStatus();
    getStatus.mockClear();
    store.setMessage('feat: x');

    await store.commit();

    expect(commitFn).toHaveBeenCalledWith({
      repoId: 'repo-1',
      message: 'feat: x',
      author: undefined,
    });
    expect(store.commitMessage()).toBe('');
    expect(store.graphReloadRequested()).toBe(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(store.offline()).toBe(false);
  });

  it('maps commit failures and degrades IPC_UNAVAILABLE', async () => {
    store = storeWith({
      getStatus: () => ({ files: FILES }),
      commit: () => Promise.reject({ code: 'GIT_FAILED', message: 'commit boom' }),
    });
    await store.loadStatus();
    store.setMessage('msg');
    await store.commit();

    expect(store.commitError()).toEqual({ code: 'GIT_FAILED', message: 'commit boom', details: {} });
    expect(store.commitMessage()).toBe('msg');

    store = storeWith({
      getStatus: () => ({ files: FILES }),
      commit: () => {
        throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
      },
    });
    await store.loadStatus();
    store.setMessage('msg');
    await store.commit();

    expect(store.offline()).toBe(true);
    expect(store.commitError()).toBeNull();
  });

  it('loads the working-tree diff from HEAD to the empty oid', async () => {
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    store = storeWith({ getDiff });
    store.setHeadOid('head-oid');

    await store.loadWorkingTreeDiff();

    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: 'head-oid',
      to: '',
      path: '',
      staged: false,
    });
    expect(store.diff()).not.toBeNull();
    expect(store.diffLoading()).toBe(false);
  });

  it('falls back to an empty HEAD for the working-tree diff', async () => {
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    store = storeWith({ getDiff });

    await store.loadWorkingTreeDiff();

    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: '',
      to: '',
      path: '',
      staged: false,
    });
  });

  it('loads a commit diff against its first parent (or the empty tree for a root)', async () => {
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    store = storeWith({ getDiff });

    await store.loadCommitDiff(commit('child', ['parent']));
    expect(getDiff).toHaveBeenLastCalledWith({
      repoId: 'repo-1',
      from: 'parent',
      to: 'child',
      path: '',
      staged: false,
    });

    await store.loadCommitDiff(commit('root'));
    expect(getDiff).toHaveBeenLastCalledWith({
      repoId: 'repo-1',
      from: '',
      to: 'root',
      path: '',
      staged: false,
    });
  });

  // -- ADR-032: read-only commit changed-file list --------------------------

  it('reads a commit changed-file paths without touching the viewer or addressing diffs', async () => {
    const getDiff = vi.fn(() =>
      Promise.resolve({ ...diff(), files: [fileDiff('a.ts'), fileDiff('b.ts')] }),
    );
    store = storeWith({ getDiff });
    // Sentinel viewer + addressing substrates the read must leave untouched.
    const viewer = diff();
    const worktree = { ...diff(), additions: 99 };
    const staged = { ...diff(), deletions: 7 };
    store.diff.set(viewer);
    store.diffContext.set('worktree');
    store.unstagedDiff.set(worktree);
    store.stagedDiff.set(staged);

    const result = await store.readCommitChangedFiles(commit('child', ['parent']));

    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: 'parent',
      to: 'child',
      path: '',
      staged: false,
    });
    expect(result).toEqual(['a.ts', 'b.ts']);
    // A read, not a load: no substrate or viewer signal was written.
    expect(store.diff()).toBe(viewer);
    expect(store.diffContext()).toBe('worktree');
    expect(store.unstagedDiff()).toBe(worktree);
    expect(store.stagedDiff()).toBe(staged);
  });

  it('reads a root commit against the empty tree (from is the empty oid)', async () => {
    const getDiff = vi.fn(() => Promise.resolve({ ...diff(), files: [fileDiff('root.ts')] }));
    store = storeWith({ getDiff });

    const result = await store.readCommitChangedFiles(commit('root'));

    expect(getDiff).toHaveBeenLastCalledWith({
      repoId: 'repo-1',
      from: '',
      to: 'root',
      path: '',
      staged: false,
    });
    expect(result).toEqual(['root.ts']);
  });

  it('is an empty read without a repository', async () => {
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    store = new StatusStore(makeBridge({ getDiff }));

    const result = await store.readCommitChangedFiles(commit('c'));

    expect(result).toEqual([]);
    expect(getDiff).not.toHaveBeenCalled();
  });

  it('degrades a failed commit file read without throwing', async () => {
    store = storeWith({
      getDiff: () => Promise.reject({ code: 'DIFF_FAILED', message: 'no diff' }),
    });

    await expect(store.readCommitChangedFiles(commit('c'))).resolves.toEqual([]);
    expect(store.error()).toEqual({ code: 'DIFF_FAILED', message: 'no diff', details: {} });

    store = storeWith({
      getDiff: () => {
        throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
      },
    });

    await expect(store.readCommitChangedFiles(commit('c'))).resolves.toEqual([]);
    expect(store.offline()).toBe(true);
    expect(store.error()).toBeNull();
  });

  it('selecting a path loads the working-tree diff', async () => {
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    store = storeWith({ getDiff });

    store.setSelectedPath('a.ts');
    await vi.waitFor(() => expect(getDiff).toHaveBeenCalled());
    expect(store.selectedPath()).toBe('a.ts');

    getDiff.mockClear();
    store.setSelectedPath(null);
    expect(getDiff).not.toHaveBeenCalled();
  });

  it('maps diff failures and degrades IPC_UNAVAILABLE', async () => {
    store = storeWith({
      getDiff: () => Promise.reject({ code: 'DIFF_FAILED', message: 'no diff' }),
    });
    await store.loadWorkingTreeDiff();
    expect(store.diffError()).toEqual({ code: 'DIFF_FAILED', message: 'no diff', details: {} });

    store = storeWith({
      getDiff: () => {
        throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
      },
    });
    await store.loadWorkingTreeDiff();
    expect(store.offline()).toBe(true);
    expect(store.diff()).toBeNull();
  });

  it('does not load a diff without a repository', async () => {
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    store = new StatusStore(makeBridge({ getDiff }));

    await store.loadWorkingTreeDiff();
    await store.loadCommitDiff(commit('x'));

    expect(getDiff).not.toHaveBeenCalled();
  });

  it('reloads the status and tracks loading around it', async () => {
    let resolveStatus: ((value: GetStatusResponse) => void) | undefined;
    const getStatus = vi.fn(
      () =>
        new Promise<GetStatusResponse>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    store = storeWith({ getStatus });

    store.reload();
    expect(store.canCommit()).toBe(false);

    resolveStatus?.({ files: FILES });
    await vi.waitFor(() => expect(store.loading()).toBe(false));
    expect(store.files()).toHaveLength(2);
  });

  it('tracks repoId and headOid setters', () => {
    store.setRepoId('other');
    store.setHeadOid('h');

    expect(store.repoId()).toBe('other');
    expect(store.headOid()).toBe('h');
  });
});

describe('StatusStore — per-file/hunk staging and discard', () => {
  const worktree: Diff = { ...diff(), files: [fileDiff('a.ts')] };
  const staged: Diff = { ...diff(), files: [fileDiff('a.ts', { status: 'A' })] };

  function getStatus(): Promise<GetStatusResponse> {
    return Promise.resolve({ files: FILES });
  }

  function byStage(req: unknown): Promise<Diff> {
    return Promise.resolve((req as { staged: boolean }).staged ? staged : worktree);
  }

  it('loads the staged diff (HEAD->index) into the Unstage substrate', async () => {
    const getDiff = vi.fn(byStage);
    const store = storeWith({ getDiff });
    store.setHeadOid('head-oid');

    await store.loadStagedDiff();

    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: 'head-oid',
      to: '',
      path: '',
      staged: true,
    });
    expect(store.stagedDiff()).not.toBeNull();
    expect(store.stagedDiffFiles().map((f) => f.path)).toEqual(['a.ts']);
    expect(store.stagedDiffLoading()).toBe(false);
  });

  it('exposes the worktree and staged per-file sections', async () => {
    const getDiff = vi.fn(byStage);
    const store = storeWith({ getDiff });

    await store.loadWorkingTreeDiff();
    await store.loadStagedDiff();

    expect(store.unstagedDiffFiles().map((f) => f.path)).toEqual(['a.ts']);
    expect(store.stagedDiffFiles().map((f) => f.path)).toEqual(['a.ts']);
    expect(store.unstagedDiffFiles()[0].status).toBe('M');
    expect(store.stagedDiffFiles()[0].status).toBe('A');
  });

  it('sets both the displayed diff and the worktree substrate from one load', async () => {
    const getDiff = vi.fn(byStage);
    const store = storeWith({ getDiff });

    await store.loadWorkingTreeDiff();

    expect(store.diffContext()).toBe('worktree');
    expect(store.diff()).toBe(store.unstagedDiff());
  });

  it('records the commit context when showing a commit diff', async () => {
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    const store = storeWith({ getDiff });

    await store.loadCommitDiff(commit('c'));

    expect(store.diffContext()).toBe('commit');
  });

  it('flags a truncated diff without crashing', async () => {
    const getDiff = vi.fn(() => Promise.resolve({ ...diff(), truncated: true }));
    const store = storeWith({ getDiff });

    await store.loadWorkingTreeDiff();
    await store.loadStagedDiff();

    expect(store.diffTruncated()).toBe(true);
    expect(store.unstagedDiffTruncated()).toBe(true);
    expect(store.stagedDiffTruncated()).toBe(true);
  });

  it('loads both addressing diffs when a path is selected', async () => {
    const getDiff = vi.fn(byStage);
    const store = storeWith({ getDiff });

    store.setSelectedPath('a.ts');
    await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(2));

    expect(getDiff).toHaveBeenCalledWith(expect.objectContaining({ staged: false }));
    expect(getDiff).toHaveBeenCalledWith(expect.objectContaining({ staged: true }));
  });

  it('stageHunk sends indices only and refreshes status + diffs', async () => {
    const stageHunk = vi.fn(() => Promise.resolve({}));
    const getDiff = vi.fn(byStage);
    const getStatus = vi.fn(() => Promise.resolve<GetStatusResponse>({ files: FILES }));
    const store = storeWith({ stageHunk, getStatus, getDiff });

    await store.stageHunk('a.ts', 2);

    expect(stageHunk).toHaveBeenCalledWith({
      repoId: 'repo-1',
      path: 'a.ts',
      hunkIndex: 2,
      lineIndices: [],
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getDiff).toHaveBeenCalledWith(expect.objectContaining({ staged: false }));
    expect(getDiff).toHaveBeenCalledWith(expect.objectContaining({ staged: true }));
  });

  it('stageHunk forwards selected line indices', async () => {
    const stageHunk = vi.fn(() => Promise.resolve({}));
    const store = storeWith({ stageHunk, getStatus, getDiff: byStage });

    await store.stageHunk('a.ts', 1, [0, 3]);

    expect(stageHunk).toHaveBeenCalledWith({
      repoId: 'repo-1',
      path: 'a.ts',
      hunkIndex: 1,
      lineIndices: [0, 3],
    });
  });

  it('unstageHunk sends the exact index payload', async () => {
    const unstageHunk = vi.fn(() => Promise.resolve({}));
    const store = storeWith({ unstageHunk, getStatus, getDiff: byStage });

    await store.unstageHunk('b.ts', 0, [2]);

    expect(unstageHunk).toHaveBeenCalledWith({
      repoId: 'repo-1',
      path: 'b.ts',
      hunkIndex: 0,
      lineIndices: [2],
    });
  });

  it('discardHunk sends the exact index payload', async () => {
    const discardHunk = vi.fn(() => Promise.resolve({}));
    const store = storeWith({ discardHunk, getStatus, getDiff: byStage });

    await store.discardHunk('c.ts', 4);

    expect(discardHunk).toHaveBeenCalledWith({
      repoId: 'repo-1',
      path: 'c.ts',
      hunkIndex: 4,
      lineIndices: [],
    });
  });

  it('discardFiles sends the file paths and refreshes', async () => {
    const discard = vi.fn(() => Promise.resolve({}));
    const getStatus = vi.fn(() => Promise.resolve<GetStatusResponse>({ files: FILES }));
    const store = storeWith({ discard, getStatus, getDiff: byStage });

    await store.discardFiles(['x.ts', 'y.ts']);

    expect(discard).toHaveBeenCalledWith({ repoId: 'repo-1', paths: ['x.ts', 'y.ts'] });
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('does nothing when discarding an empty path list', async () => {
    const discard = vi.fn(() => Promise.resolve({}));
    const store = storeWith({ discard });

    await store.discardFiles([]);

    expect(discard).not.toHaveBeenCalled();
  });

  it('does nothing without a repository', async () => {
    const stageHunk = vi.fn(() => Promise.resolve({}));
    const store = new StatusStore(makeBridge({ stageHunk }));

    await store.stageHunk('a.ts', 0);
    await store.discardFiles(['a.ts']);

    expect(stageHunk).not.toHaveBeenCalled();
  });

  it('maps hunk mutation failures and degrades IPC_UNAVAILABLE', async () => {
    const store = storeWith({
      stageHunk: () => Promise.reject({ code: 'GIT_FAILED', message: 'nope' }),
      getStatus,
      getDiff: byStage,
    });
    await store.stageHunk('a.ts', 0);
    expect(store.error()).toEqual({ code: 'GIT_FAILED', message: 'nope', details: {} });

    const offline = storeWith({
      stageHunk: () => {
        throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
      },
      getStatus,
      getDiff: byStage,
    });
    await offline.stageHunk('a.ts', 0);
    expect(offline.offline()).toBe(true);
    expect(offline.error()).toBeNull();
  });

  it('keeps a displayed commit diff when a hunk is staged', async () => {
    const getDiff = vi.fn(() => Promise.resolve(diff()));
    const store = storeWith({ getDiff, stageHunk: () => Promise.resolve({}), getStatus });

    await store.loadCommitDiff(commit('c'));
    const shown = store.diff();

    await store.stageHunk('a.ts', 0);

    expect(store.diff()).toBe(shown);
    expect(store.unstagedDiff()).not.toBeNull();
  });

  it('refreshes the displayed diff when a hunk is staged in worktree context', async () => {
    const getDiff = vi.fn(byStage);
    const store = storeWith({ getDiff, stageHunk: () => Promise.resolve({}), getStatus });

    await store.loadWorkingTreeDiff();
    await store.stageHunk('a.ts', 0);

    expect(store.diffContext()).toBe('worktree');
    expect(store.diff()).toBe(store.unstagedDiff());
  });

  it('maps staged-diff failures and degrades IPC_UNAVAILABLE', async () => {
    const store = storeWith({
      getDiff: () => Promise.reject({ code: 'DIFF_FAILED', message: 'no staged' }),
    });
    await store.loadStagedDiff();
    expect(store.stagedDiffError()).toEqual({
      code: 'DIFF_FAILED',
      message: 'no staged',
      details: {},
    });

    const offline = storeWith({
      getDiff: () => {
        throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
      },
    });
    await offline.loadStagedDiff();
    expect(offline.offline()).toBe(true);
    expect(offline.stagedDiff()).toBeNull();
  });
});
