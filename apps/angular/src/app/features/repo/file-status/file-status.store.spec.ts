import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch, Commit, Diff, FileDiff, FileStatus, Hunk } from '@contracts/domain';
import { IpcBridge } from '@core/services/ipc-bridge.service';
import { StatusStore } from '../status/status.store';
import { FileStatusStore } from './file-status.store';

function file(path: string, isStaged: boolean): FileStatus {
  return {
    path,
    staged: isStaged ? 'M' : ' ',
    unstaged: isStaged ? ' ' : 'M',
    isStaged,
    isConflicted: false,
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

function worktreeDiff(overrides: Partial<Diff> = {}): Diff {
  return {
    from: undefined,
    to: undefined,
    hunks: [],
    additions: 1,
    deletions: 0,
    isBinary: false,
    hasConflictMarkers: false,
    files: [fileDiff('a.ts')],
    truncated: false,
    ...overrides,
  };
}

function stagedDiff(): Diff {
  return worktreeDiff({ files: [fileDiff('a.ts', { status: 'A' })] });
}

function branch(name: string, tip: string | undefined, overrides: Partial<Branch> = {}): Branch {
  return {
    name,
    refName: overrides.isRemote ? `refs/remotes/${name}` : `refs/heads/${name}`,
    tip: tip ? { hex: tip, kind: 'SHA1' } : undefined,
    upstream: '',
    isCurrent: false,
    isRemote: false,
    behind: 0,
    ...overrides,
  };
}

type Handler = (req: unknown) => unknown;
type Handlers = Partial<
  Record<
    | 'getStatus'
    | 'getDiff'
    | 'getBranches'
    | 'stage'
    | 'unstage'
    | 'stageHunk'
    | 'unstageHunk'
    | 'discardHunk'
    | 'discard'
    | 'commit',
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

function makeStores(handlers: Handlers): { store: FileStatusStore; status: StatusStore } {
  const bridge = makeBridge(handlers);
  const status = new StatusStore(bridge);
  return { store: new FileStatusStore(bridge, status), status };
}

function storeWith(handlers: Handlers, repoId = 'repo-1'): FileStatusStore {
  const store = makeStores(handlers).store;
  store.setRepoId(repoId);
  return store;
}

function byStage(req: unknown): Promise<Diff> {
  return Promise.resolve((req as { staged: boolean }).staged ? STAGED_DIFF : WORKTREE_DIFF);
}

/** Request object of the most recent call of a mocked bridge handler. */
function lastPayload(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = mock.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

const FILES: FileStatus[] = [file('b.ts', true), file('a.ts', false)];
const WORKTREE_DIFF: Diff = worktreeDiff();
const STAGED_DIFF: Diff = stagedDiff();
const BRANCHES: Branch[] = [
  branch('origin/main', 'origin-main-oid', { isRemote: true }),
  branch('main', 'main-oid'),
  branch('develop', 'develop-oid', { isCurrent: true }),
];

describe('FileStatusStore — variants', () => {
  let store: FileStatusStore;

  beforeEach(() => {
    store = storeWith({ getStatus: () => Promise.resolve({ files: FILES }) });
  });

  it('opens the local variant and delegates status + both diffs', async () => {
    const getStatus = vi.fn(() => Promise.resolve({ files: FILES }));
    const getDiff = vi.fn(byStage);
    store = storeWith({ getStatus, getDiff });

    await store.openLocal();

    expect(store.variant()).toBe('local');
    expect(store.isLocal()).toBe(true);
    expect(store.selectedPath()).toBeNull();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: '',
      to: '',
      path: '',
      staged: false,
    });
    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: '',
      to: '',
      path: '',
      staged: true,
    });
    // The local viewer diff still comes from StatusStore.
    expect(store.wholeDiff()).toBe(WORKTREE_DIFF);
    expect(store.commitDiff()).toBeNull();
  });

  it('opens a commit diff against its first parent', async () => {
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    store = storeWith({ getDiff });

    await store.openCommit(commit('child', ['parent']));

    expect(store.variant()).toBe('commit');
    expect(store.isLocal()).toBe(false);
    expect(store.activeCommit()?.oid?.hex).toBe('child');
    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: 'parent',
      to: 'child',
      path: '',
      staged: false,
    });
    expect(store.commitDiff()).not.toBeNull();
    expect(store.diffLoading()).toBe(false);
    expect(store.diffError()).toBeNull();
  });

  it('opens a root-commit diff with an empty from side', async () => {
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    store = storeWith({ getDiff });

    await store.openCommit(commit('root'));

    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: '',
      to: 'root',
      path: '',
      staged: false,
    });
  });

  it('diffs a merge commit against its FIRST parent (never the last)', async () => {
    const getDiff = vi.fn((_req: unknown) => Promise.resolve(worktreeDiff()));
    const invoke = vi.fn((method: string, req: unknown) =>
      method === 'getDiff' ? getDiff(req) : Promise.resolve({}),
    );
    const bridge = { invoke } as unknown as IpcBridge;
    const store = new FileStatusStore(bridge, new StatusStore(bridge));
    store.setRepoId('repo-1');

    await store.openCommit(commit('merge', ['p1', 'p2']));

    expect(store.variant()).toBe('commit');
    expect(store.activeCommit()?.oid?.hex).toBe('merge');
    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: 'p1',
      to: 'merge',
      path: '',
      staged: false,
    });
    // parents[0] is the diff base — never parents.at(-1) ('p2').
    expect(invoke).not.toHaveBeenCalledWith('getDiff', expect.objectContaining({ from: 'p2' }));
    expect(getDiff).not.toHaveBeenCalledWith(expect.objectContaining({ from: 'p2' }));
  });

  it('opens the PR variant with a resolved base and target', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: BRANCHES }));
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    store = storeWith({ getBranches, getDiff });

    await store.openPr();

    expect(store.variant()).toBe('pr');
    expect(getBranches).toHaveBeenCalledTimes(1);
    expect(store.branches()).toHaveLength(3);
    expect(store.baseRef()).toBe('main');
    expect(store.baseRefOid()).toBe('main-oid');
    expect(store.targetRef()).toBe('develop');
    expect(store.targetRefOid()).toBe('develop-oid');
    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: 'main-oid',
      to: 'develop-oid',
      path: '',
      staged: false,
    });
    expect(store.commitDiff()).not.toBeNull();
    expect(store.diffError()).toBeNull();
  });

  it('reuses already loaded branches instead of re-invoking getBranches', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: BRANCHES }));
    store = storeWith({ getBranches, getDiff: () => Promise.resolve(worktreeDiff()) });

    await store.loadBranches();
    await store.openPr();

    expect(getBranches).toHaveBeenCalledTimes(1);
  });

  it('re-defaults the target when it resolves to the base', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: BRANCHES }));
    store = storeWith({ getBranches, getDiff: () => Promise.resolve(worktreeDiff()) });
    await store.openPr();

    store.setTargetRef('main');
    expect(store.targetRef()).toBe('main');
    expect(store.targetRefOid()).toBe('main-oid');

    await store.openPr();

    expect(store.targetRef()).toBe('develop');
    expect(store.targetRefOid()).toBe('develop-oid');
  });

  it('records PR_REFS_UNRESOLVED when the base or target has no oid', async () => {
    const getBranches = vi.fn(() =>
      Promise.resolve({ branches: [branch('main', undefined), branch('origin/main', undefined, { isRemote: true })] }),
    );
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    store = storeWith({ getBranches, getDiff });

    await store.openPr();

    expect(store.variant()).toBe('pr');
    expect(store.diffError()?.code).toBe('PR_REFS_UNRESOLVED');
    expect(store.diffError()?.message).toBeTruthy();
    expect(store.commitDiff()).toBeNull();
    expect(getDiff).not.toHaveBeenCalled();
  });

  it('records PR_REFS_UNRESOLVED when the target cannot be resolved', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: [branch('main', 'main-oid')] }));
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    store = storeWith({ getBranches, getDiff });

    await store.openPr();

    expect(store.baseRefOid()).toBe('main-oid');
    expect(store.targetRef()).toBe('');
    expect(store.diffError()?.code).toBe('PR_REFS_UNRESOLVED');
    expect(getDiff).not.toHaveBeenCalled();
  });

  it('clears every per-variant signal', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: BRANCHES }));
    store = storeWith({ getBranches, getDiff: () => Promise.resolve(worktreeDiff()) });
    await store.openPr();
    expect(store.commitDiff()).not.toBeNull();

    store.clearVariant();

    expect(store.variant()).toBe('local');
    expect(store.activeCommit()).toBeNull();
    expect(store.commitDiff()).toBeNull();
    expect(store.selectedPath()).toBeNull();
    expect(store.branches()).toEqual([]);
    expect(store.baseRef()).toBe('');
    expect(store.baseRefOid()).toBe('');
    expect(store.targetRef()).toBe('');
    expect(store.targetRefOid()).toBe('');
    expect(store.diffError()).toBeNull();
    expect(store.branchesError()).toBeNull();
  });
});

describe('FileStatusStore — refs', () => {
  it('resolves the default base from local main first', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: BRANCHES }));
    const store = storeWith({ getBranches });

    const resolved = await store.resolveDefaultBase();

    expect(resolved).toEqual({ name: 'main', oid: 'main-oid', isRemote: false });
    expect(store.baseRef()).toBe('main');
    expect(store.baseRefOid()).toBe('main-oid');
  });

  it('falls back to the current branch when no preferred name exists', async () => {
    const getBranches = vi.fn(() =>
      Promise.resolve({ branches: [branch('feature', 'feature-oid'), branch('develop', 'develop-oid', { isCurrent: true })] }),
    );
    const store = storeWith({ getBranches });

    await store.resolveDefaultBase();

    expect(store.baseRef()).toBe('develop');
    expect(store.baseRefOid()).toBe('develop-oid');
  });

  it('falls back to the first remote-tracking branch', async () => {
    const getBranches = vi.fn(() =>
      Promise.resolve({ branches: [branch('origin/trunk', 'trunk-oid', { isRemote: true })] }),
    );
    const store = storeWith({ getBranches });

    const resolved = await store.resolveDefaultBase();

    expect(resolved).toEqual({ name: 'origin/trunk', oid: 'trunk-oid', isRemote: true });
  });

  it('returns null when no branch qualifies', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: [branch('main', undefined)] }));
    const store = storeWith({ getBranches });

    expect(await store.resolveDefaultBase()).toBeNull();
    expect(store.baseRef()).toBe('');
    expect(store.baseRefOid()).toBe('');
  });

  it('re-issues the PR diff after a base override', async () => {
    const getBranches = vi.fn(() =>
      Promise.resolve({ branches: [...BRANCHES, branch('release', 'release-oid')] }),
    );
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    const store = storeWith({ getBranches, getDiff });
    await store.openPr();
    getDiff.mockClear();

    store.setBaseRef('release');

    expect(store.baseRef()).toBe('release');
    expect(store.baseRefOid()).toBe('release-oid');
    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: 'release-oid',
      to: 'develop-oid',
      path: '',
      staged: false,
    });
  });

  it('re-issues the PR diff after a target override', async () => {
    const getBranches = vi.fn(() =>
      Promise.resolve({ branches: [...BRANCHES, branch('release', 'release-oid')] }),
    );
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    const store = storeWith({ getBranches, getDiff });
    await store.openPr();
    getDiff.mockClear();

    store.setTargetRef('release');

    expect(store.targetRef()).toBe('release');
    expect(store.targetRefOid()).toBe('release-oid');
    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-1',
      from: 'main-oid',
      to: 'release-oid',
      path: '',
      staged: false,
    });
  });

  it('never fires a diff for an unknown ref override', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: BRANCHES }));
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    const store = storeWith({ getBranches, getDiff });
    await store.openPr();
    getDiff.mockClear();

    store.setBaseRef('nope');

    expect(store.baseRef()).toBe('nope');
    expect(store.baseRefOid()).toBe('');
    expect(getDiff).not.toHaveBeenCalled();
  });

  it('ignores a ref override outside the PR variant', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: BRANCHES }));
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    const store = storeWith({ getBranches, getDiff });
    await store.loadBranches();
    getDiff.mockClear();

    store.setTargetRef('develop');

    expect(store.targetRef()).toBe('develop');
    expect(store.targetRefOid()).toBe('develop-oid');
    expect(getDiff).not.toHaveBeenCalled();
  });

  it('forwards repoId and headOid to the status store', async () => {
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    const { store, status } = makeStores({ getDiff });

    store.setRepoId('repo-2');
    store.setHeadOid('head-oid');
    await store.openLocal();

    expect(store.repoId()).toBe('repo-2');
    expect(status.repoId()).toBe('repo-2');
    expect(status.headOid()).toBe('head-oid');
    expect(getDiff).toHaveBeenCalledWith({
      repoId: 'repo-2',
      from: 'head-oid',
      to: '',
      path: '',
      staged: false,
    });
  });
});

describe('FileStatusStore — selection and derived state', () => {
  it('loads the hunk substrate for a local selection', async () => {
    const getDiff = vi.fn(byStage);
    const store = storeWith({ getDiff });

    await store.openLocal();
    getDiff.mockClear();
    store.selectFile('a.ts');
    await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(2));

    expect(store.selectedPath()).toBe('a.ts');
    expect(store.selectedUnstagedFile()?.path).toBe('a.ts');
    expect(store.selectedStagedFile()?.path).toBe('a.ts');
    expect(getDiff).toHaveBeenCalledWith(expect.objectContaining({ staged: false, path: '' }));
    expect(getDiff).toHaveBeenCalledWith(expect.objectContaining({ staged: true, path: '' }));
  });

  it('does not load the hunk substrate for a commit selection', async () => {
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    const store = storeWith({ getDiff });

    await store.openCommit(commit('child', ['parent']));
    getDiff.mockClear();
    store.selectFile('a.ts');

    expect(store.selectedPath()).toBe('a.ts');
    expect(getDiff).not.toHaveBeenCalled();
    expect(store.selectedUnstagedFile()).toBeNull();
    expect(store.selectedStagedFile()).toBeNull();
  });

  it('clears the selection when a null path is selected', () => {
    const store = storeWith({ getDiff: byStage });
    store.selectFile(null);
    expect(store.selectedPath()).toBeNull();
  });

  it('switches wholeDiff between the worktree diff and the own diff', async () => {
    const { store, status } = makeStores({ getDiff: byStage });

    store.setRepoId('repo-1');
    await store.openLocal();
    expect(store.wholeDiff()).toBe(status.diff());
    expect(store.wholeDiff()?.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(store.truncated()).toBe(false);

    await store.openCommit(commit('child', ['parent']));
    expect(store.wholeDiff()).toBe(store.commitDiff());
  });

  it('flags a truncated diff', async () => {
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff({ truncated: true })));
    const store = storeWith({ getDiff });

    await store.openCommit(commit('root'));

    expect(store.truncated()).toBe(true);
  });

  it('exposes the status-store file list and messages', async () => {
    const getStatus = vi.fn(() => Promise.resolve({ files: FILES }));
    const store = storeWith({ getStatus, getDiff: byStage });

    await store.openLocal();
    store.setMessage('feat: x');

    expect(store.stagedFiles().map((f) => f.path)).toEqual(['b.ts']);
    expect(store.unstagedFiles().map((f) => f.path)).toEqual(['a.ts']);
    expect(store.filesLoading()).toBe(false);
    expect(store.statusError()).toBeNull();
    expect(store.commitMessage()).toBe('feat: x');
    expect(store.commitError()).toBeNull();
    expect(store.graphReloadRequested()).toBe(0);
  });

  it('lists conflicted and untracked files on the unstaged side', async () => {
    const conflicted: FileStatus = {
      path: 'conflict.ts',
      staged: 'U',
      unstaged: 'U',
      isStaged: false,
      isConflicted: true,
    };
    const untracked: FileStatus = {
      path: 'new.ts',
      staged: ' ',
      unstaged: '?',
      isStaged: false,
      isConflicted: false,
    };
    const store = storeWith({
      getStatus: () => Promise.resolve({ files: [conflicted, untracked] }),
      getDiff: byStage,
    });

    await store.openLocal();

    // Both ride the unstaged list (they are !isStaged); a conflict is not hidden,
    // and the untracked file is not dropped.
    expect(store.unstagedFiles().map((f) => f.path)).toEqual(['conflict.ts', 'new.ts']);
    expect(store.stagedFiles()).toEqual([]);
    expect(store.unstagedFiles()[0].isConflicted).toBe(true);
  });

  it('surfaces the status-store error messages', async () => {
    const getStatus = vi.fn(() => Promise.reject({ code: 'GIT_FAILED', message: 'status boom' }));
    const store = storeWith({ getStatus, getDiff: byStage });

    await store.openLocal();

    expect(store.statusError()).toBe('status boom');
  });

  it('surfaces the commit error message', async () => {
    const commitFn = vi.fn(() => Promise.reject({ code: 'GIT_FAILED', message: 'commit boom' }));
    const store = storeWith({
      getStatus: () => Promise.resolve({ files: FILES }),
      commit: commitFn,
      getDiff: byStage,
    });

    await store.openLocal();
    store.setMessage('msg');
    await store.commit();

    expect(store.commitError()).toBe('commit boom');
    expect(store.commitMessage()).toBe('msg');
  });

  it('keeps rightLoading/rightError on the status store locally', async () => {
    const getDiff = vi.fn(byStage);
    const store = storeWith({ getDiff });

    await store.openLocal();
    expect(store.rightLoading()).toBe(false);
    expect(store.rightError()).toBeNull();
    expect(store.isLocal()).toBe(true);
  });

  it('points rightLoading/rightError at the own diff outside the local variant', async () => {
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    const store = storeWith({ getDiff });

    await store.openCommit(commit('root'));

    expect(store.rightLoading()).toBe(false);
    expect(store.rightError()).toBeNull();
  });
});

describe('FileStatusStore — delegated mutations', () => {
  function mutationStore(handlers: Handlers): FileStatusStore {
    return storeWith({ getStatus: () => Promise.resolve({ files: FILES }), getDiff: byStage, ...handlers });
  }

  it('forwards stage and unstage verbatim', async () => {
    const stage = vi.fn(() => Promise.resolve({}));
    const unstage = vi.fn(() => Promise.resolve({}));
    const store = mutationStore({ stage, unstage });

    await store.stage(['a.ts', 'b.ts']);
    expect(stage).toHaveBeenCalledWith({ repoId: 'repo-1', paths: ['a.ts', 'b.ts'] });

    await store.unstage(['b.ts']);
    expect(unstage).toHaveBeenCalledWith({ repoId: 'repo-1', paths: ['b.ts'] });
  });

  it('forwards hunk mutations as indices only (never a patch)', async () => {
    const stageHunk = vi.fn(() => Promise.resolve({}));
    const unstageHunk = vi.fn(() => Promise.resolve({}));
    const discardHunk = vi.fn(() => Promise.resolve({}));
    const store = mutationStore({ stageHunk, unstageHunk, discardHunk });

    await store.stageHunk('a.ts', 2, [1, 3]);
    await store.unstageHunk('b.ts', 0, [2]);
    await store.discardHunk('c.ts', 4);

    expect(stageHunk).toHaveBeenCalledWith({
      repoId: 'repo-1',
      path: 'a.ts',
      hunkIndex: 2,
      lineIndices: [1, 3],
    });
    expect(unstageHunk).toHaveBeenCalledWith({
      repoId: 'repo-1',
      path: 'b.ts',
      hunkIndex: 0,
      lineIndices: [2],
    });
    expect(discardHunk).toHaveBeenCalledWith({
      repoId: 'repo-1',
      path: 'c.ts',
      hunkIndex: 4,
      lineIndices: [],
    });

    for (const mock of [stageHunk, unstageHunk, discardHunk]) {
      expect(Object.keys(lastPayload(mock)).sort()).toEqual([
        'hunkIndex',
        'lineIndices',
        'path',
        'repoId',
      ]);
      expect(JSON.stringify(lastPayload(mock))).not.toContain('+++');
    }
  });

  it('forwards discardFiles verbatim', async () => {
    const discard = vi.fn(() => Promise.resolve({}));
    const store = mutationStore({ discard });

    await store.discardFiles(['x.ts', 'y.ts']);

    expect(discard).toHaveBeenCalledWith({ repoId: 'repo-1', paths: ['x.ts', 'y.ts'] });
  });

  it('forwards the message and the commit', async () => {
    const commitFn = vi.fn(() => Promise.resolve(commit('c'.repeat(40))));
    const store = mutationStore({ commit: commitFn });

    await store.openLocal();
    store.setMessage('feat: x');
    await store.commit();

    expect(commitFn).toHaveBeenCalledWith({
      repoId: 'repo-1',
      message: 'feat: x',
      author: undefined,
    });
    expect(store.commitMessage()).toBe('');
    expect(store.graphReloadRequested()).toBe(1);
  });
});

describe('FileStatusStore — error handling', () => {
  it('degrades an unavailable IPC bridge on getDiff', async () => {
    const store = storeWith({
      getDiff: () => {
        throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
      },
    });

    await store.openCommit(commit('root'));

    expect(store.commitDiff()).toBeNull();
    expect(store.diffError()).toBeNull();
    expect(store.diffLoading()).toBe(false);
  });

  it('degrades an unavailable IPC bridge on getBranches', async () => {
    const store = storeWith({
      getBranches: () => Promise.reject({ code: 'IPC_UNAVAILABLE', message: 'offline' }),
    });

    await store.loadBranches();

    expect(store.branches()).toEqual([]);
    expect(store.branchesError()).toBeNull();
    expect(store.branchesLoading()).toBe(false);
  });

  it('records non-IPC diff failures on diffError', async () => {
    const store = storeWith({
      getDiff: () => Promise.reject({ code: 'DIFF_FAILED', message: 'no diff' }),
    });

    await store.openCommit(commit('root'));

    expect(store.diffError()).toEqual({ code: 'DIFF_FAILED', message: 'no diff', details: {} });
    expect(store.commitDiff()).toBeNull();
  });

  it('records non-IPC branch failures on branchesError', async () => {
    const store = storeWith({
      getBranches: () => Promise.reject({ code: 'GIT_FAILED', message: 'no branches' }),
    });

    await store.loadBranches();

    expect(store.branchesError()).toEqual({
      code: 'GIT_FAILED',
      message: 'no branches',
      details: {},
    });
    expect(store.branchesLoading()).toBe(false);
  });

  it('does nothing without a repository', async () => {
    const getBranches = vi.fn(() => Promise.resolve({ branches: BRANCHES }));
    const getDiff = vi.fn(() => Promise.resolve(worktreeDiff()));
    const bridge = makeBridge({ getBranches, getDiff });
    const store = new FileStatusStore(bridge, new StatusStore(bridge));

    await store.openCommit(commit('root'));
    await store.loadBranches();
    await store.openPr();

    expect(getBranches).not.toHaveBeenCalled();
    expect(getDiff).not.toHaveBeenCalled();
    expect(store.diffError()).toEqual({
      code: 'PR_REFS_UNRESOLVED',
      message: expect.any(String),
    });
  });
});
