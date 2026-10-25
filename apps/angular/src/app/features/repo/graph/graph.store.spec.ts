import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, Lane, Repository } from '@contracts/domain';
import type { GetCommitsResponse } from '@contracts/gitcore';
import { BranchLensStore } from '@core/services/branch-lens.store';
import { GraphSessionStore } from '@core/services/graph-session.store';
import { IpcBridge } from '@core/services/ipc-bridge.service';
import { LiveRegionService } from '@singularitree/ui-kit';
import { COMMIT_FOCUS_MAX_LOADS, GRAPH_WINDOW_SIZE, GraphStore, WIP_OID } from './graph.store';

const REPO: Repository = {
  id: 'repo-1',
  fsPath: '/tmp/repo',
  commonDir: '/tmp/repo/.git',
  name: 'repo',
  createdAt: '2026-01-01T00:00:00Z',
  lastOpenedAt: '2026-01-01T00:00:00Z',
};

const REPO_TWO: Repository = {
  ...REPO,
  id: 'repo-2',
  fsPath: '/tmp/repo-2',
  commonDir: '/tmp/repo-2/.git',
  name: 'repo-2',
};

/** Bridge that opens `REPO`/`REPO_TWO` by path and lists both as recents. */
function makeTwoRepoBridge(getCommits: Handler): IpcBridge {
  return makeBridge({
    getCommits,
    openRepository: (req) =>
      Promise.resolve((req as { fsPath: string }).fsPath === REPO.fsPath ? REPO : REPO_TWO),
    listRepositories: () => Promise.resolve({ repositories: [REPO, REPO_TWO] }),
    watch: () => Promise.resolve({}),
  });
}

function makeCommit(index: number, refs: Commit['refs'] = []): Commit {
  const hex = index.toString(16).padStart(40, '0');
  return {
    oid: { hex, kind: 'SHA1' },
    parents: [],
    author: { name: `Author ${index}`, email: `author${index}@example.com`, when: '2026-01-02T10:00:00Z' },
    committer: undefined,
    message: `commit ${index}`,
    treeOid: undefined,
    committedAt: '2026-01-02T10:05:00Z',
    refs,
  };
}

function makePage(count: number, startIndex = 0, total = count): GetCommitsResponse {
  const commits = Array.from({ length: count }, (_, i) => makeCommit(startIndex + i));
  const lanes: Lane[] = commits.map((_, i) => ({
    index: i % 3,
    color: i % 8,
    continues: i % 2 === 0,
  }));
  return { commits, total, lanes, inRefs: [] };
}

type Handler = (req: unknown) => unknown;
type Handlers = Partial<
  Record<
    'getCommits' | 'openRepository' | 'listRepositories' | 'getCommitStats' | 'reset' | 'watch',
    Handler
  >
>;

function makeBridge(handlers: Handlers): IpcBridge {
  return {
    invoke: vi.fn((method: string, req: unknown) => {
      // The gauge is fetched after every page; default it to "no stats" so
      // existing window tests stay focused and need not declare a handler.
      if (method === 'getCommitStats' && !handlers.getCommitStats) {
        return Promise.resolve({ stats: [] });
      }
      const handler = handlers[method as keyof Handlers];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return handler(req);
    }),
  } as unknown as IpcBridge;
}

/** Install a mocked `window.gitClientApi` and return the IpcBridge over it. */
function installApi(impl: Record<string, (req: unknown) => unknown>): IpcBridge {
  (window as unknown as { gitClientApi?: unknown }).gitClientApi = impl;
  return new IpcBridge();
}

function clearApi(): void {
  delete (window as unknown as { gitClientApi?: unknown }).gitClientApi;
}

describe('GraphStore', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore(
      makeBridge({
        getCommits: () => makePage(0),
      }),
    );
  });

  afterEach(() => {
    clearApi();
  });

  it('loads a window and builds lane-aligned rows with the 200+100 limit', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(300, 0, 1000)));
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);

    await store.loadWindow(0);

    expect(getCommits).toHaveBeenCalledWith({
      repoId: REPO.id,
      offset: 0,
      limit: GRAPH_WINDOW_SIZE + 100,
      refs: [],
    });
    expect(store.commits()).toHaveLength(300);
    expect(store.lanes()).toHaveLength(300);
    expect(store.total()).toBe(1000);
    expect(store.hasMore()).toBe(true);
    expect(store.isLoading()).toBe(false);
    expect(store.offline()).toBe(false);

    const rows = store.rows();
    expect(rows).toHaveLength(300);
    // lanes[i] is index-aligned with commits[i] (parallel-array contract).
    rows.forEach((row, i) => {
      expect(row.commit.oid?.hex).toBe(makeCommit(i).oid?.hex);
      expect(row.lane.index).toBe(i % 3);
    });
    expect(store.maxLane()).toBe(2);
  });

  it('appends the next window on loadMore and is a no-op while loading or exhausted', async () => {
    let resolveFirst: ((value: GetCommitsResponse) => void) | undefined;
    const getCommits = vi.fn((req: unknown) => {
      const { offset } = req as { offset: number };
      if (offset === 0) {
        return new Promise<GetCommitsResponse>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(makePage(300, offset, 1000));
    });
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);

    const first = store.loadWindow(0);
    expect(store.isLoading()).toBe(true);
    store.loadMore(); // ignored: still loading
    expect(getCommits).toHaveBeenCalledTimes(1);

    resolveFirst?.(makePage(300, 0, 1000));
    await first;

    store.loadMore();
    await vi.waitFor(() => expect(store.commits()).toHaveLength(600));

    expect(getCommits).toHaveBeenCalledTimes(2);
    expect(getCommits).toHaveBeenLastCalledWith({
      repoId: REPO.id,
      offset: 300,
      limit: 300,
      refs: [],
    });
    expect(store.lanes()).toHaveLength(600);
    expect(store.offset()).toBe(600);
  });

  it('discards a superseded loadWindow response so a stale page cannot clobber the newest one', async () => {
    let resolveStale: ((value: GetCommitsResponse) => void) | undefined;
    let resolveFresh: ((value: GetCommitsResponse) => void) | undefined;
    let calls = 0;
    const getCommits = vi.fn(() => {
      calls++;
      return new Promise<GetCommitsResponse>((resolve) => {
        if (calls === 1) resolveStale = resolve;
        else resolveFresh = resolve;
      });
    });
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);

    // The first request predates the commit (2 rows, no `wip commit`); the second
    // is the post-commit reload (3 rows). On CI the first can resolve last — its
    // getCommits is served from the pre-invalidation L1 cache window — so the
    // store must discard it and keep the newest page.
    const stale = makePage(2, 0, 2);
    const fresh = makePage(3, 0, 3);

    const first = store.loadWindow(0);
    const second = store.loadWindow(0);
    expect(getCommits).toHaveBeenCalledTimes(2);

    // Newest resolves first; the superseded request then resolves last.
    resolveFresh?.(fresh);
    await second;
    resolveStale?.(stale);
    await first;

    expect(store.commits()).toHaveLength(3);
    expect(store.commits().map((commit) => commit.oid?.hex)).toEqual(
      fresh.commits.map((commit) => commit.oid?.hex),
    );
    expect(store.total()).toBe(3);
    expect(store.isLoading()).toBe(false);
  });

  it('ignores a superseded loadWindow failure instead of blanking the newest page', async () => {
    let rejectStale: ((reason?: unknown) => void) | undefined;
    let resolveFresh: ((value: GetCommitsResponse) => void) | undefined;
    let calls = 0;
    const getCommits = vi.fn(() => {
      calls++;
      return new Promise<GetCommitsResponse>((resolve, reject) => {
        if (calls === 1) rejectStale = reject;
        else resolveFresh = resolve;
      });
    });
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);

    const fresh = makePage(3, 0, 3);
    const first = store.loadWindow(0);
    const second = store.loadWindow(0);

    resolveFresh?.(fresh);
    await second;
    // A stale IPC_UNAVAILABLE used to degrade the store to an empty window,
    // blanking the newer page; it must now be ignored entirely.
    rejectStale?.({ code: 'IPC_UNAVAILABLE', message: 'offline' });
    await first;

    expect(store.commits()).toHaveLength(3);
    expect(store.total()).toBe(3);
    expect(store.offline()).toBe(false);
    expect(store.isLoading()).toBe(false);
  });

  it('tolerates a missing lanes array by defaulting neutral lanes', async () => {
    const getCommits = vi.fn(() =>
      Promise.resolve({
        commits: [makeCommit(0), makeCommit(1)],
        total: 2,
        lanes: [],
        inRefs: [],
      } as GetCommitsResponse),
    );
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);

    await store.loadWindow(0);

    expect(store.lanes()).toEqual([
      { index: 0, color: 0, continues: false },
      { index: 0, color: 0, continues: false },
    ]);
    expect(store.rows().every((row) => row.lane.index === 0)).toBe(true);
  });

  it('degrades to an empty page when the IPC bridge is unavailable', async () => {
    const getCommits = vi.fn(() => {
      throw { code: 'IPC_UNAVAILABLE', message: 'Not running inside Electron' };
    });
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);

    await store.loadWindow(0);

    expect(store.offline()).toBe(true);
    expect(store.error()).toBeNull();
    expect(store.commits()).toEqual([]);
    expect(store.total()).toBe(0);
    expect(store.rows()).toEqual([]);
    expect(store.isLoading()).toBe(false);
  });

  it('records non-IPC failures on the error signal', async () => {
    const getCommits = vi.fn(() => Promise.reject({ code: 'GIT_FAILED', message: 'boom' }));
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);

    await store.loadWindow(0);

    expect(store.error()).toEqual({ code: 'GIT_FAILED', message: 'boom', details: {} });
    expect(store.offline()).toBe(false);
  });

  it('opens a repository and loads its first window', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const openRepository = vi.fn(() => Promise.resolve(REPO));
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    store = new GraphStore(makeBridge({ getCommits, openRepository, listRepositories }));

    const repo = await store.openRepository('/tmp/repo');

    expect(openRepository).toHaveBeenCalledWith({ fsPath: '/tmp/repo' });
    expect(repo).toEqual(REPO);
    expect(store.repoId()).toBe('repo-1');
    expect(store.offline()).toBe(false);
    expect(store.commits()).toHaveLength(2);
  });

  it('loads recent repositories from listRepositories', async () => {
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    store = new GraphStore(makeBridge({ listRepositories }));

    await store.loadRecentRepos();

    expect(listRepositories).toHaveBeenCalledWith({});
    expect(store.recentRepos()).toEqual([REPO]);
    expect(store.offline()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('degrades loadRecentRepos to an empty list when the bridge is unavailable', async () => {
    const listRepositories = vi.fn(() => {
      throw { code: 'IPC_UNAVAILABLE', message: 'Not running inside Electron' };
    });
    store = new GraphStore(makeBridge({ listRepositories }));
    store.recentRepos.set([REPO]);

    await store.loadRecentRepos();

    expect(store.offline()).toBe(true);
    expect(store.error()).toBeNull();
    expect(store.recentRepos()).toEqual([]);
  });

  it('records non-IPC failures from listRepositories on the error signal', async () => {
    const listRepositories = vi.fn(() => Promise.reject({ code: 'GIT_FAILED', message: 'boom' }));
    store = new GraphStore(makeBridge({ listRepositories }));

    await store.loadRecentRepos();

    expect(store.error()).toEqual({ code: 'GIT_FAILED', message: 'boom', details: {} });
    expect(store.offline()).toBe(false);
  });

  it('refreshes the recents list after a successful open', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const openRepository = vi.fn(() => Promise.resolve(REPO));
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    store = new GraphStore(makeBridge({ getCommits, openRepository, listRepositories }));

    await store.openRepository('/tmp/repo');

    expect(listRepositories).toHaveBeenCalledWith({});
    expect(store.recentRepos()).toEqual([REPO]);
  });

  it('kicks off the repository-scoped watch when a repository opens', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(1, 0, 1)));
    const openRepository = vi.fn(() => Promise.resolve(REPO));
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    const watch = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ getCommits, openRepository, listRepositories, watch }));

    await store.openRepository('/tmp/repo');

    // ADR-0030: the watch kickoff relocated from StatusWorkspace to the store.
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith({ repoId: REPO.id });
  });

  it('degrades openRepository to null when the bridge is unavailable', async () => {
    store = new GraphStore(
      makeBridge({
        openRepository: () => {
          throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
        },
      }),
    );

    await expect(store.openRepository('/tmp/repo')).resolves.toBeNull();
    expect(store.offline()).toBe(true);
  });

  it('clears the repository on a failed open so no stale window survives', async () => {
    let call = 0;
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const getCommitStats = vi.fn((req: unknown) => {
      const { oids } = req as { oids: string[] };
      return Promise.resolve({
        stats: oids.map((oid) => ({ oid, additions: 1, deletions: 1, filesChanged: 1 })),
      });
    });
    const openRepository = vi.fn(() => {
      call++;
      return call === 1
        ? Promise.resolve(REPO)
        : Promise.reject({ code: 'GIT_FAILED', message: 'boom' });
    });
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    const watch = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(
      makeBridge({ getCommits, getCommitStats, openRepository, listRepositories, watch }),
    );

    // First open mounts repo-1's window; select a commit and let the gauge
    // cache fill so the paging/gauge residue is observable too.
    await store.openRepository('/tmp/repo');
    store.select(makeCommit(0).oid?.hex ?? '');
    expect(store.repoId()).toBe('repo-1');
    expect(store.commits()).toHaveLength(2);
    await vi.waitFor(() => expect(store.commitStats().size).toBeGreaterThan(0));
    expect(store.offset()).toBe(2);

    // A failed open must leave NO repository open: the previous repo's commits,
    // selection, paging offset and gauge cache cannot survive it (RepoPage's
    // `repoId()` gate then routes to the relocate panel / picker).
    await expect(store.openRepository('/tmp/other')).resolves.toBeNull();

    expect(store.repoId()).toBeNull();
    expect(store.commits()).toEqual([]);
    expect(store.lanes()).toEqual([]);
    expect(store.total()).toBe(0);
    expect(store.selectedOid()).toBeNull();
    expect(store.filter()).toBe('');
    expect(store.offset()).toBe(0);
    expect(store.commitStats().size).toBe(0);
    expect(store.error()).toEqual({ code: 'GIT_FAILED', message: 'boom', details: {} });
    // No extra watch was started for the failed open.
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith({ repoId: 'repo-1' });
  });

  it('clears the repository on an IPC_UNAVAILABLE open failure (offline, no stale window)', async () => {
    let call = 0;
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const getCommitStats = vi.fn((req: unknown) => {
      const { oids } = req as { oids: string[] };
      return Promise.resolve({
        stats: oids.map((oid) => ({ oid, additions: 1, deletions: 1, filesChanged: 1 })),
      });
    });
    const openRepository = vi.fn(() => {
      call++;
      return call === 1
        ? Promise.resolve(REPO)
        : Promise.reject({ code: 'IPC_UNAVAILABLE', message: 'offline' });
    });
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    store = new GraphStore(makeBridge({ getCommits, getCommitStats, openRepository, listRepositories }));

    await store.openRepository('/tmp/repo');
    expect(store.repoId()).toBe('repo-1');
    await vi.waitFor(() => expect(store.commitStats().size).toBeGreaterThan(0));

    await expect(store.openRepository('/tmp/other')).resolves.toBeNull();

    expect(store.offline()).toBe(true);
    expect(store.repoId()).toBeNull();
    expect(store.commits()).toEqual([]);
    expect(store.total()).toBe(0);
    expect(store.offset()).toBe(0);
    expect(store.commitStats().size).toBe(0);
  });

  it('discards a superseded open so a late resolve installs nothing', async () => {
    const repoA = { ...REPO, id: 'repo-a', fsPath: '/tmp/a' };
    const repoB = { ...REPO, id: 'repo-b', fsPath: '/tmp/b' };
    let resolveA: ((value: Repository) => void) | undefined;
    let resolveB: ((value: Repository) => void) | undefined;
    const openRepository = vi.fn((req: unknown) => {
      const { fsPath } = req as { fsPath: string };
      return new Promise<Repository>((resolve) => {
        if (fsPath === '/tmp/a') resolveA = resolve;
        else resolveB = resolve;
      });
    });
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [] }));
    const watch = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ getCommits, openRepository, listRepositories, watch }));

    // The user switches tabs: A is opened, then B; B resolves first and A (the
    // tab the user left) resolves last.
    const openingA = store.openRepository('/tmp/a');
    const openingB = store.openRepository('/tmp/b');

    resolveB?.(repoB);
    await openingB;
    resolveA?.(repoA);
    await expect(openingA).resolves.toBeNull();

    // Only B installed its repo, loaded its window and started a watch.
    expect(store.repoId()).toBe('repo-b');
    expect(store.commits()).toHaveLength(2);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith({ repoId: 'repo-b' });
  });

  it('clears the previous repo rows while the switched-to window is in flight', async () => {
    const repoA = { ...REPO, id: 'repo-a', fsPath: '/tmp/a' };
    const repoB = { ...REPO, id: 'repo-b', fsPath: '/tmp/b' };
    let resolveWindow: ((value: GetCommitsResponse) => void) | undefined;
    let getCommitsCalls = 0;
    const getCommits = vi.fn(() => {
      getCommitsCalls++;
      // A's window resolves immediately; B's stays in flight.
      if (getCommitsCalls === 1) return Promise.resolve(makePage(2, 0, 2));
      return new Promise<GetCommitsResponse>((resolve) => {
        resolveWindow = resolve;
      });
    });
    const openRepository = vi.fn((req: unknown) =>
      Promise.resolve((req as { fsPath: string }).fsPath === '/tmp/a' ? repoA : repoB),
    );
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [] }));
    const watch = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ getCommits, openRepository, listRepositories, watch }));

    await store.openRepository('/tmp/a');
    expect(store.repoId()).toBe('repo-a');
    expect(store.commits()).toHaveLength(2);

    // Switch to B: its `open` resolves immediately, but its `getCommits` does not.
    const switching = store.openRepository('/tmp/b');
    await vi.waitFor(() => expect(store.repoId()).toBe('repo-b'));

    // A's rows must not render under B's identity while B's window loads.
    expect(store.commits()).toEqual([]);
    expect(store.lanes()).toEqual([]);
    expect(store.total()).toBe(0);
    expect(store.loading()).toBe(true);

    resolveWindow?.(makePage(3, 0, 3));
    await switching;

    // The successful load repopulates the new repo's window.
    expect(store.commits()).toHaveLength(3);
    expect(store.total()).toBe(3);
  });

  it('filters loaded rows by message, author, oid and refs', async () => {
    const page: GetCommitsResponse = {
      commits: [
        makeCommit(0, [{ name: 'main', kind: 'head' }]),
        makeCommit(1),
      ],
      total: 2,
      lanes: [
        { index: 0, color: 0, continues: false },
        { index: 1, color: 1, continues: false },
      ],
      inRefs: [],
    };
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(page) }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    expect(store.filteredRows()).toHaveLength(2);

    store.setFilter('Author 1');
    expect(store.filteredRows().map((row) => row.commit.message)).toEqual(['commit 1']);

    store.setFilter('main');
    expect(store.filteredRows().map((row) => row.commit.message)).toEqual(['commit 0']);

    store.setFilter('0000000');
    expect(store.filteredRows()).toHaveLength(2);

    store.setFilter('   ');
    expect(store.filteredRows()).toHaveLength(2);
  });

  it('selects commits and the synthetic WIP node', async () => {
    store = new GraphStore(
      makeBridge({ getCommits: () => Promise.resolve(makePage(2)) }),
    );
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    expect(store.selectedRow()).toBeNull();
    expect(store.isWipSelected()).toBe(false);

    const oid = makeCommit(1).oid?.hex ?? '';
    store.select(oid);
    expect(store.selectedRow()?.commit.oid?.hex).toBe(oid);
    expect(store.isWipSelected()).toBe(false);

    store.select(WIP_OID);
    expect(store.isWipSelected()).toBe(true);
    expect(store.selectedRow()).toBeNull();
  });

  it('does nothing while no repository is open', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(1)));
    store = new GraphStore(makeBridge({ getCommits }));

    await store.loadWindow(0);
    store.loadMore();

    expect(getCommits).not.toHaveBeenCalled();
    expect(store.rows()).toEqual([]);
  });

  it('tracks selectedIndex over filteredRows (-1 when none/WIP/not found)', async () => {
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(makePage(3)) }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    expect(store.selectedIndex()).toBe(-1);

    store.select(makeCommit(1).oid?.hex ?? '');
    expect(store.selectedIndex()).toBe(1);

    store.select(WIP_OID);
    expect(store.selectedIndex()).toBe(-1);

    store.select('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(store.selectedIndex()).toBe(-1);
  });

  it('selectNext/selectPrevious move within filtered rows and clamp at bounds', async () => {
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(makePage(3)) }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    store.selectNext();
    expect(store.selectedIndex()).toBe(0);
    expect(store.selectedOid()).toBe(makeCommit(0).oid?.hex);

    store.selectNext();
    expect(store.selectedIndex()).toBe(1);

    store.selectPrevious();
    expect(store.selectedIndex()).toBe(0);

    store.selectPrevious(); // clamp at first
    expect(store.selectedIndex()).toBe(0);

    store.selectNext();
    store.selectNext();
    store.selectNext(); // clamp at last
    expect(store.selectedIndex()).toBe(2);
    expect(store.selectedOid()).toBe(makeCommit(2).oid?.hex);
  });

  it('navigates only within the filtered rows', async () => {
    const page: GetCommitsResponse = {
      commits: [makeCommit(0, [{ name: 'main', kind: 'head' }]), makeCommit(1), makeCommit(2)],
      total: 3,
      lanes: [
        { index: 0, color: 0, continues: false },
        { index: 1, color: 1, continues: false },
        { index: 2, color: 2, continues: false },
      ],
      inRefs: [],
    };
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(page) }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    store.setFilter('Author 2');
    expect(store.filteredRows()).toHaveLength(1);

    store.selectNext();
    expect(store.selectedOid()).toBe(makeCommit(2).oid?.hex);
    expect(store.selectedIndex()).toBe(0);
  });

  it('is a no-op for keyboard navigation when there are no rows', () => {
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(makePage(0)) }));
    store.repoId.set(REPO.id);

    store.selectNext();
    store.selectPrevious();

    expect(store.selectedOid()).toBeNull();
    expect(store.selectedIndex()).toBe(-1);
  });

  // -- commit change-size gauge (ADR-0023) ---------------------------------

  it('loads the gauge for the loaded window in one batched call and caches it', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(3, 0, 3)));
    const getCommitStats = vi.fn((req: unknown) => {
      const { oids } = req as { oids: string[] };
      return Promise.resolve({
        stats: oids.map((oid, i) => ({
          oid,
          additions: i + 1,
          deletions: i,
          filesChanged: 1,
        })),
      });
    });
    store = new GraphStore(makeBridge({ getCommits, getCommitStats }));
    store.repoId.set(REPO.id);

    await store.loadWindow(0);

    await vi.waitFor(() => expect(getCommitStats).toHaveBeenCalledTimes(1));
    expect(getCommitStats).toHaveBeenCalledWith({
      repoId: REPO.id,
      oids: [0, 1, 2].map((i) => makeCommit(i).oid?.hex),
    });
    expect(store.statsFor(makeCommit(1).oid?.hex)).toEqual({
      oid: makeCommit(1).oid?.hex,
      additions: 2,
      deletions: 1,
      filesChanged: 1,
    });
    expect(store.statsError()).toBeNull();
  });

  it('never re-requests cached oids and asks only for the missing ones', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const getCommitStats = vi.fn((req: unknown) => {
      const { oids } = req as { oids: string[] };
      return Promise.resolve({
        stats: oids.map((oid) => ({ oid, additions: 1, deletions: 0, filesChanged: 1 })),
      });
    });
    store = new GraphStore(makeBridge({ getCommits, getCommitStats }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);
    await vi.waitFor(() => expect(getCommitStats).toHaveBeenCalledTimes(1));

    getCommitStats.mockClear();
    await store.loadStats([makeCommit(0).oid?.hex ?? '', makeCommit(1).oid?.hex ?? '']);
    expect(getCommitStats).not.toHaveBeenCalled();

    const fresh = 'f'.repeat(40);
    await store.loadStats([makeCommit(0).oid?.hex ?? '', fresh]);
    expect(getCommitStats).toHaveBeenCalledWith({ repoId: REPO.id, oids: [fresh] });
  });

  it('omits a gauge for an unmeasured oid and for an undefined oid', async () => {
    store.repoId.set(REPO.id);
    expect(store.statsFor(undefined)).toBeNull();
    expect(store.statsFor('a'.repeat(40))).toBeNull();
  });

  it('does not fetch stats without a repository', async () => {
    const getCommitStats = vi.fn(() => Promise.resolve({ stats: [] }));
    store = new GraphStore(makeBridge({ getCommitStats }));

    await store.loadStats(['a'.repeat(40)]);

    expect(getCommitStats).not.toHaveBeenCalled();
  });

  it('records a non-IPC gauge failure on statsError without breaking the window', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(1, 0, 1)));
    const getCommitStats = vi.fn(() => Promise.reject({ code: 'GIT_FAILED', message: 'numstat' }));
    store = new GraphStore(makeBridge({ getCommits, getCommitStats }));
    store.repoId.set(REPO.id);

    await store.loadWindow(0);

    await vi.waitFor(() =>
      expect(store.statsError()).toEqual({ code: 'GIT_FAILED', message: 'numstat', details: {} }),
    );
    expect(store.commits()).toHaveLength(1);
    expect(store.offline()).toBe(false);
  });

  it('degrades the gauge to offline when the bridge is unavailable', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(1, 0, 1)));
    const getCommitStats = vi.fn(() => {
      throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
    });
    store = new GraphStore(makeBridge({ getCommits, getCommitStats }));
    store.repoId.set(REPO.id);

    await store.loadWindow(0);

    await vi.waitFor(() => expect(store.offline()).toBe(true));
    expect(store.statsError()).toBeNull();
  });

  it('loads the gauge through a real bridge over window.gitClientApi', async () => {
    const oid = makeCommit(0).oid?.hex ?? '';
    const getCommitStats = vi.fn(() =>
      Promise.resolve({ stats: [{ oid, additions: 3, deletions: 2, filesChanged: 1 }] }),
    );
    store = new GraphStore(installApi({ getCommitStats }));
    store.repoId.set(REPO.id);

    await store.loadStats([oid]);

    expect(getCommitStats).toHaveBeenCalledWith({ repoId: REPO.id, oids: [oid] });
    expect(store.statsFor(oid)?.additions).toBe(3);
  });

  // -- reset (ADR-0021) ----------------------------------------------------

  it('resets to an oid with the named mode and reloads the graph', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const reset = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ getCommits, reset }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);
    getCommits.mockClear();

    const ok = await store.reset('a'.repeat(40), 'HARD');

    expect(ok).toBe(true);
    expect(reset).toHaveBeenCalledWith({ repoId: REPO.id, to: 'a'.repeat(40), mode: 'HARD' });
    expect(store.resetRunning()).toBe(false);
    expect(store.resetError()).toBeNull();
    await vi.waitFor(() => expect(getCommits).toHaveBeenCalled());
  });

  it('rejects an unspecified reset mode without calling the bridge', async () => {
    const reset = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ reset }));
    store.repoId.set(REPO.id);

    const ok = await store.reset('a'.repeat(40), 'NOPE' as never);

    expect(ok).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it('no-ops a reset without a repository or a target', async () => {
    const reset = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ reset }));

    await expect(store.reset('a'.repeat(40), 'SOFT')).resolves.toBe(false);
    store.repoId.set(REPO.id);
    await expect(store.reset('', 'SOFT')).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it('ignores a re-entrant reset while one is running', async () => {
    let release: (() => void) | undefined;
    const reset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    store = new GraphStore(makeBridge({ reset }));
    store.repoId.set(REPO.id);

    const first = store.reset('a'.repeat(40), 'MIXED');
    expect(store.resetRunning()).toBe(true);
    const second = await store.reset('b'.repeat(40), 'SOFT');
    expect(second).toBe(false);
    expect(reset).toHaveBeenCalledTimes(1);

    release?.();
    await expect(first).resolves.toBe(true);
  });

  it('records a non-IPC reset failure and returns false', async () => {
    const reset = vi.fn(() => Promise.reject({ code: 'RESET_FAILED', message: 'boom' }));
    store = new GraphStore(makeBridge({ reset }));
    store.repoId.set(REPO.id);

    const ok = await store.reset('a'.repeat(40), 'SOFT');

    expect(ok).toBe(false);
    expect(store.resetError()).toEqual({ code: 'RESET_FAILED', message: 'boom', details: {} });
    expect(store.resetRunning()).toBe(false);
  });

  it('degrades a reset to offline on IPC_UNAVAILABLE', async () => {
    const reset = vi.fn(() => {
      throw { code: 'IPC_UNAVAILABLE', message: 'offline' };
    });
    store = new GraphStore(makeBridge({ reset }));
    store.repoId.set(REPO.id);

    await expect(store.reset('a'.repeat(40), 'SOFT')).resolves.toBe(false);
    expect(store.offline()).toBe(true);
    expect(store.resetError()).toBeNull();
  });

  // -- focusCommit (deep-link commit focus) --------------------------------

  it('focusCommit ignores a blank oid', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(300, 0, 1000)));
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);
    getCommits.mockClear();

    await store.focusCommit('');

    expect(getCommits).not.toHaveBeenCalled();
    expect(store.selectedOid()).toBeNull();
  });

  it('focusCommit selects an already-loaded commit without paging', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(300, 0, 1000)));
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);
    getCommits.mockClear();

    await store.focusCommit(makeCommit(5).oid?.hex as string);

    expect(store.selectedOid()).toBe(makeCommit(5).oid?.hex);
    expect(getCommits).not.toHaveBeenCalled();
  });

  it('focusCommit pages forward until the commit appears', async () => {
    const target = makeCommit(350).oid?.hex as string;
    const getCommits = vi.fn((req: unknown) =>
      Promise.resolve(makePage(300, (req as { offset: number }).offset, 1000)),
    );
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);
    getCommits.mockClear();

    await store.focusCommit(target);

    expect(store.selectedOid()).toBe(target);
    expect(store.commits().some((commit) => commit.oid?.hex === target)).toBe(true);
    expect(getCommits).toHaveBeenCalledTimes(1);
  });

  it('focusCommit stops at the bounded load count when the commit is never found', async () => {
    const getCommits = vi.fn((req: unknown) =>
      Promise.resolve(makePage(300, (req as { offset: number }).offset, 100_000)),
    );
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);
    getCommits.mockClear();

    const target = 'f'.repeat(40);
    await store.focusCommit(target);

    expect(store.selectedOid()).toBe(target);
    expect(getCommits).toHaveBeenCalledTimes(COMMIT_FOCUS_MAX_LOADS);
  });

  it('focusCommit stops early when a page makes no progress', async () => {
    const getCommits = vi.fn(() => Promise.resolve({ commits: [], total: 1000, lanes: [] }));
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);
    getCommits.mockClear();

    await store.focusCommit('f'.repeat(40));

    expect(getCommits).toHaveBeenCalledTimes(1);
  });

  it('does not page focusCommit for another commit while locked, keeping the pin', async () => {
    const getCommits = vi.fn((req: unknown) =>
      Promise.resolve(makePage(300, (req as { offset: number }).offset, 1000)),
    );
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    const lockedOid = makeCommit(0).oid?.hex as string;
    store.select(lockedOid);
    store.lock();
    getCommits.mockClear();

    // The target is a foreign commit the pin refuses: paging could never reveal
    // it, so the store must not load any window and must leave the pin in place.
    await store.focusCommit(makeCommit(350).oid?.hex as string);

    expect(getCommits).not.toHaveBeenCalled();
    expect(store.selectedOid()).toBe(lockedOid);
    expect(store.lockedOid()).toBe(lockedOid);
  });

  // -- CDK viewport scroll memory (P3) -------------------------------------

  it('remembers a scroll offset, restores it once and then clears it', () => {
    store.rememberScrollOffset(420);
    store.requestScrollRestore();

    expect(store.pendingScrollOffset()).toBe(420);
    // Handed back exactly once...
    expect(store.consumeScrollRestore()).toBe(420);
    // ...then cleared, so a re-mounted viewport cannot restore a stale position.
    expect(store.consumeScrollRestore()).toBeNull();
    expect(store.pendingScrollOffset()).toBeNull();
    // The remembered offset itself is untouched by the consume.
    expect(store.scrollOffset()).toBe(420);
  });

  it('resets the offset and any pending restore when the filter changes', () => {
    store.rememberScrollOffset(300);
    store.requestScrollRestore();

    store.setFilter('Author 1');

    expect(store.filter()).toBe('Author 1');
    expect(store.scrollOffset()).toBe(0);
    expect(store.pendingScrollOffset()).toBeNull();
    expect(store.consumeScrollRestore()).toBeNull();
  });

  it('resets the offset and any pending restore when a repository opens', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(1, 0, 1)));
    const openRepository = vi.fn(() => Promise.resolve(REPO));
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    const watch = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ getCommits, openRepository, listRepositories, watch }));
    store.rememberScrollOffset(512);
    store.requestScrollRestore();

    await store.openRepository('/tmp/repo');

    expect(store.scrollOffset()).toBe(0);
    expect(store.pendingScrollOffset()).toBeNull();
  });

  it('leaves the offset and pending restore intact when the WIP node is selected', () => {
    store.rememberScrollOffset(256);
    store.requestScrollRestore();

    store.select(WIP_OID);

    // WIP is pinned outside the viewport: selecting it never touches offset math.
    expect(store.isWipSelected()).toBe(true);
    expect(store.scrollOffset()).toBe(256);
    expect(store.pendingScrollOffset()).toBe(256);
    expect(store.consumeScrollRestore()).toBe(256);
  });

  // -- commit selection lock (padlock) -------------------------------------

  it('locks the selected commit (oid + commit), unlocks keeping the selection and releases both', async () => {
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(makePage(3)) }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    const oid = makeCommit(1).oid?.hex as string;
    store.select(oid);
    store.lock();

    expect(store.lockedOid()).toBe(oid);
    expect(store.lockedCommit()?.oid?.hex).toBe(oid);
    expect(store.selectedOid()).toBe(oid);

    // Unlock lifts the pin but keeps the selection (the padlock's "off" intent).
    store.unlock();
    expect(store.lockedOid()).toBeNull();
    expect(store.lockedCommit()).toBeNull();
    expect(store.selectedOid()).toBe(oid);

    // Release drops the lock AND the selection together (the pinned pane resets).
    store.lock();
    store.release();
    expect(store.lockedOid()).toBeNull();
    expect(store.lockedCommit()).toBeNull();
    expect(store.selectedOid()).toBeNull();
  });

  it('refuses a foreign selection while locked, still allows the locked oid and blocks null', async () => {
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(makePage(3)) }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    const lockedOid = makeCommit(1).oid?.hex as string;
    const otherOid = makeCommit(2).oid?.hex as string;
    store.select(lockedOid);
    store.lock();

    // A different commit is refused: the pin holds.
    store.select(otherOid);
    expect(store.selectedOid()).toBe(lockedOid);

    // WIP is a foreign target too.
    store.select(WIP_OID);
    expect(store.selectedOid()).toBe(lockedOid);

    // Re-selecting the locked commit is allowed and is an effective no-op.
    store.select(lockedOid);
    expect(store.selectedOid()).toBe(lockedOid);

    // `null` is refused as well: only `release()` clears a locked selection.
    store.select(null);
    expect(store.selectedOid()).toBe(lockedOid);

    store.release();
    expect(store.selectedOid()).toBeNull();
    expect(store.lockedOid()).toBeNull();
  });

  it('is a no-op locking with nothing selected, the WIP node or an oid absent from the rows', async () => {
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(makePage(3)) }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    store.lock(); // nothing selected
    expect(store.lockedOid()).toBeNull();
    expect(store.lockedCommit()).toBeNull();

    store.select(WIP_OID);
    store.lock(); // WIP is not a real commit to pin
    expect(store.lockedOid()).toBeNull();

    store.select('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'); // not in rows()
    store.lock();
    expect(store.lockedOid()).toBeNull();
  });

  it('blocks keyboard next/previous while locked', async () => {
    store = new GraphStore(makeBridge({ getCommits: () => Promise.resolve(makePage(3)) }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    const oid = makeCommit(1).oid?.hex as string;
    store.select(oid);
    store.lock();

    // Arrows route through `select`, so they hit the same guard as a row click.
    store.selectNext();
    expect(store.selectedOid()).toBe(oid);
    store.selectPrevious();
    expect(store.selectedOid()).toBe(oid);
  });

  it('clears the lock when another repository opens', async () => {
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const openRepository = vi.fn(() => Promise.resolve(REPO));
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    const watch = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ getCommits, openRepository, listRepositories, watch }));

    await store.openRepository('/tmp/repo');
    store.select(makeCommit(0).oid?.hex as string);
    store.lock();
    expect(store.lockedOid()).not.toBeNull();

    // A different repository invalidates the pin: the locked commit belonged to
    // the previous repo's DAG, so it cannot survive the switch.
    await store.openRepository('/tmp/repo');

    expect(store.lockedOid()).toBeNull();
    expect(store.lockedCommit()).toBeNull();
    expect(store.selectedOid()).toBeNull();
  });

  it('clears the lock on a failed open too', async () => {
    let call = 0;
    const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
    const openRepository = vi.fn(() => {
      call++;
      return call === 1
        ? Promise.resolve(REPO)
        : Promise.reject({ code: 'GIT_FAILED', message: 'boom' });
    });
    const listRepositories = vi.fn(() => Promise.resolve({ repositories: [REPO] }));
    const watch = vi.fn(() => Promise.resolve({}));
    store = new GraphStore(makeBridge({ getCommits, openRepository, listRepositories, watch }));

    await store.openRepository('/tmp/repo');
    store.select(makeCommit(0).oid?.hex as string);
    store.lock();
    expect(store.lockedOid()).not.toBeNull();

    await expect(store.openRepository('/tmp/other')).resolves.toBeNull();

    expect(store.lockedOid()).toBeNull();
    expect(store.lockedCommit()).toBeNull();
  });

  it('keeps the lock and selection across a reload that drops the locked row', async () => {
    let call = 0;
    const getCommits = vi.fn(() => {
      call++;
      // First window contains the commit; the reload returns a window that does not.
      return Promise.resolve(call === 1 ? makePage(3) : makePage(2, 10, 2));
    });
    store = new GraphStore(makeBridge({ getCommits }));
    store.repoId.set(REPO.id);
    await store.loadWindow(0);

    const oid = makeCommit(1).oid?.hex as string;
    store.select(oid);
    store.lock();
    expect(store.rows().some((row) => row.commit.oid?.hex === oid)).toBe(true);

    store.reload();
    await vi.waitFor(() => expect(store.commits()).toHaveLength(2));

    // The freshly loaded window no longer contains the locked oid...
    expect(store.rows().some((row) => row.commit.oid?.hex === oid)).toBe(false);
    // ...yet the lock (and the cached commit) survive so the pinned pane still renders.
    expect(store.lockedOid()).toBe(oid);
    expect(store.lockedCommit()?.oid?.hex).toBe(oid);
    expect(store.selectedOid()).toBe(oid);
  });

  it('announces a blocked selection through the root live region while locked', async () => {
    // Built inside an injection context so the constructor can resolve the real
    // root `LiveRegionService` (the plain `new GraphStore(bridge)` path degrades
    // it to null by design).
    const graphStore = TestBed.runInInjectionContext(
      () => new GraphStore(makeBridge({ getCommits: () => Promise.resolve(makePage(2)) })),
    );
    const liveRegion = TestBed.inject(LiveRegionService);
    graphStore.repoId.set(REPO.id);
    await graphStore.loadWindow(0);

    const lockedOid = makeCommit(0).oid?.hex as string;
    graphStore.select(lockedOid);
    graphStore.lock();

    graphStore.select(makeCommit(1).oid?.hex as string);

    // The pin holds and the refusal was published to the shared live region.
    expect(graphStore.selectedOid()).toBe(lockedOid);
    expect(liveRegion.message()).toBe(
      'Commit selection is locked. Release the lock to select another commit.',
    );
  });

  // -- graph session persistence (root in-memory session store) ------------

  describe('graph session persistence', () => {
    it('restores the selection when switching back to a repo tab', async () => {
      const session = new GraphSessionStore();
      store = new GraphStore(
        makeTwoRepoBridge(() => Promise.resolve(makePage(3))),
        session,
      );

      await store.openRepository(REPO.fsPath);
      const oid = makeCommit(1).oid?.hex as string;
      store.select(oid);

      // Switching to another tab blanks the live signals for that repo...
      await store.openRepository(REPO_TWO.fsPath);
      expect(store.selectedOid()).toBeNull();

      // ...but switching back restores repo-1's own selection.
      await store.openRepository(REPO.fsPath);
      expect(store.selectedOid()).toBe(oid);
    });

    it('restores the lock (and cached commit) when the locked row left the window', async () => {
      const session = new GraphSessionStore();
      let repoOneOpens = 0;
      const getCommits = vi.fn((req: unknown) => {
        const { repoId } = req as { repoId: string };
        if (repoId !== REPO.id) return Promise.resolve(makePage(2, 20, 2));
        repoOneOpens++;
        // The first open contains the locked commit; the reopen after the tab
        // switch returns a window that no longer contains it.
        return Promise.resolve(repoOneOpens === 1 ? makePage(3) : makePage(2, 10, 2));
      });
      store = new GraphStore(makeTwoRepoBridge(getCommits), session);

      await store.openRepository(REPO.fsPath);
      const lockedOid = makeCommit(1).oid?.hex as string;
      store.select(lockedOid);
      store.lock();

      await store.openRepository(REPO_TWO.fsPath);
      await store.openRepository(REPO.fsPath);

      // The reloaded window does not contain the pinned commit...
      expect(store.rows().some((row) => row.commit.oid?.hex === lockedOid)).toBe(false);
      // ...yet the padlock and its cached commit are restored.
      expect(store.lockedOid()).toBe(lockedOid);
      expect(store.lockedCommit()?.oid?.hex).toBe(lockedOid);
      expect(store.selectedOid()).toBe(lockedOid);

      // A foreign selection is refused exactly like before the tab switch.
      store.select(makeCommit(2).oid?.hex as string);
      expect(store.selectedOid()).toBe(lockedOid);
      expect(store.lockedOid()).toBe(lockedOid);
    });

    it('keeps each repo tab selection isolated', async () => {
      const session = new GraphSessionStore();
      store = new GraphStore(
        makeTwoRepoBridge(() => Promise.resolve(makePage(3))),
        session,
      );

      await store.openRepository(REPO.fsPath);
      const repoOneOid = makeCommit(1).oid?.hex as string;
      store.select(repoOneOid);

      await store.openRepository(REPO_TWO.fsPath);
      // repo-2 has no saved session, so repo-1's selection is never shared.
      expect(store.selectedOid()).toBeNull();
      expect(session.read(REPO_TWO.id)).toBeNull();

      const repoTwoOid = makeCommit(2).oid?.hex as string;
      store.select(repoTwoOid);

      await store.openRepository(REPO.fsPath);
      expect(store.selectedOid()).toBe(repoOneOid);

      await store.openRepository(REPO_TWO.fsPath);
      expect(store.selectedOid()).toBe(repoTwoOid);
    });

    it('persists unlock and release (and a cleared selection) to the saved session', async () => {
      const session = new GraphSessionStore();
      store = new GraphStore(
        makeTwoRepoBridge(() => Promise.resolve(makePage(3))),
        session,
      );

      await store.openRepository(REPO.fsPath);
      const oid = makeCommit(1).oid?.hex as string;
      store.select(oid);
      store.lock();

      expect(session.read(REPO.id)).toEqual({
        selectedOid: oid,
        lockedOid: oid,
        lockedCommit: expect.objectContaining({ oid: { hex: oid, kind: 'SHA1' } }),
      });

      // Unlock keeps the selection in the saved state but clears the pin.
      store.unlock();
      expect(session.read(REPO.id)).toEqual({
        selectedOid: oid,
        lockedOid: null,
        lockedCommit: null,
      });

      // Release clears both.
      store.lock();
      store.release();
      expect(session.read(REPO.id)).toEqual({
        selectedOid: null,
        lockedOid: null,
        lockedCommit: null,
      });

      // An ordinary clear-to-null selection is persisted too.
      store.select(oid);
      store.select(null);
      expect(session.read(REPO.id)?.selectedOid).toBeNull();
    });

    it('does not erase the saved session when an open fails', async () => {
      const session = new GraphSessionStore();
      let call = 0;
      const getCommits = vi.fn(() => Promise.resolve(makePage(3)));
      const openRepository = vi.fn(() => {
        call++;
        return call === 2
          ? Promise.reject({ code: 'GIT_FAILED', message: 'boom' })
          : Promise.resolve(REPO);
      });
      store = new GraphStore(
        makeBridge({
          getCommits,
          openRepository,
          listRepositories: () => Promise.resolve({ repositories: [REPO] }),
          watch: () => Promise.resolve({}),
        }),
        session,
      );

      await store.openRepository(REPO.fsPath);
      const oid = makeCommit(1).oid?.hex as string;
      store.select(oid);
      store.lock();

      await expect(store.openRepository('/tmp/other')).resolves.toBeNull();

      // The live signals are cleared by the failure...
      expect(store.repoId()).toBeNull();
      expect(store.selectedOid()).toBeNull();
      expect(store.lockedOid()).toBeNull();
      // ...but the repo's saved session survives for a later successful open.
      expect(session.read(REPO.id)).toEqual({
        selectedOid: oid,
        lockedOid: oid,
        lockedCommit: expect.objectContaining({ oid: { hex: oid, kind: 'SHA1' } }),
      });

      await store.openRepository(REPO.fsPath);
      expect(store.selectedOid()).toBe(oid);
      expect(store.lockedOid()).toBe(oid);
    });
  });

  // -- branch lens (ADR-0042) ----------------------------------------------

  describe('branch lens', () => {
    it('sends the lensed ref to getCommits and falls back to an empty scope', async () => {
      const lens = new BranchLensStore();
      const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
      store = new GraphStore(makeBridge({ getCommits }), null, lens);
      store.repoId.set(REPO.id);

      await store.loadWindow(0);
      expect(getCommits).toHaveBeenLastCalledWith({
        repoId: REPO.id,
        offset: 0,
        limit: GRAPH_WINDOW_SIZE + 100,
        refs: [],
      });

      lens.set('feature/x', 'local');
      await store.loadWindow(0);
      expect(getCommits).toHaveBeenLastCalledWith({
        repoId: REPO.id,
        offset: 0,
        limit: GRAPH_WINDOW_SIZE + 100,
        refs: ['feature/x'],
      });
    });

    it('maps inRefs onto lensOids, replacing on reload and unioning on append', async () => {
      const getCommits = vi.fn((req: unknown) => {
        const { offset } = req as { offset: number };
        if (offset <= 0) {
          return Promise.resolve<GetCommitsResponse>({
            commits: [makeCommit(0), makeCommit(1), makeCommit(2)],
            total: 5,
            lanes: [],
            inRefs: [true, false, true],
          });
        }
        return Promise.resolve<GetCommitsResponse>({
          commits: [makeCommit(3), makeCommit(4)],
          total: 5,
          lanes: [],
          inRefs: [false, true],
        });
      });
      store = new GraphStore(makeBridge({ getCommits }));
      store.repoId.set(REPO.id);

      await store.loadWindow(0);
      const first = [makeCommit(0), makeCommit(2)].map((commit) => commit.oid?.hex as string);
      expect([...store.lensOids()].sort()).toEqual([...first].sort());

      // Appending a window keeps the earlier highlights...
      await store.loadWindow(3);
      const appended = [...first, makeCommit(4).oid?.hex as string];
      expect([...store.lensOids()].sort()).toEqual([...appended].sort());

      // ...while a replacing page rebuilds the set from that response only.
      await store.loadWindow(0);
      expect([...store.lensOids()].sort()).toEqual([...first].sort());
    });

    it('resets the remembered scroll and reloads offset 0 for a lens change', async () => {
      const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
      store = new GraphStore(makeBridge({ getCommits }));
      store.repoId.set(REPO.id);
      await store.loadWindow(0);
      store.rememberScrollOffset(420);
      store.requestScrollRestore();
      const loadWindow = vi.spyOn(store, 'loadWindow');

      store.reloadForLens();

      expect(store.scrollOffset()).toBe(0);
      expect(store.pendingScrollOffset()).toBeNull();
      expect(loadWindow).toHaveBeenCalledWith(0);
      await vi.waitFor(() => expect(getCommits).toHaveBeenCalledTimes(2));
    });

    it('does not carry the lens across a repository open', async () => {
      const lens = new BranchLensStore();
      const getCommits = vi.fn(() => Promise.resolve(makePage(2, 0, 2)));
      store = new GraphStore(makeTwoRepoBridge(getCommits), null, lens);
      lens.set('feature/x', 'local');

      await store.openRepository(REPO.fsPath);
      // Repo A's window was walked with the active lens scope...
      expect(getCommits).toHaveBeenLastCalledWith({
        repoId: REPO.id,
        offset: 0,
        limit: GRAPH_WINDOW_SIZE + 100,
        refs: ['feature/x'],
      });

      // ...and opening another repository drops the view-only scope (the root
      // `RepoState` clears it on activation), so repo B's walk is a plain HEAD
      // walk: no stale ref survives the switch.
      lens.clear();
      await store.openRepository(REPO_TWO.fsPath);

      expect(getCommits).toHaveBeenLastCalledWith({
        repoId: REPO_TWO.id,
        offset: 0,
        limit: GRAPH_WINDOW_SIZE + 100,
        refs: [],
      });
      expect(store.lensOids().size).toBe(0);
    });

    it('resets lensOids when another repository opens (success and failure)', async () => {
      const getCommits = vi.fn((req: unknown) => {
        const { repoId } = req as { repoId: string };
        const commits = [makeCommit(0), makeCommit(1)];
        return Promise.resolve<GetCommitsResponse>({
          commits,
          total: commits.length,
          lanes: [],
          inRefs: commits.map(() => repoId === REPO.id),
        });
      });
      const openRepository = vi.fn((req: unknown) => {
        const { fsPath } = req as { fsPath: string };
        if (fsPath === REPO.fsPath) return Promise.resolve(REPO);
        if (fsPath === REPO_TWO.fsPath) return Promise.resolve(REPO_TWO);
        return Promise.reject({ code: 'GIT_FAILED', message: 'boom' });
      });
      store = new GraphStore(
        makeBridge({
          getCommits,
          openRepository,
          listRepositories: () => Promise.resolve({ repositories: [REPO, REPO_TWO] }),
          watch: () => Promise.resolve({}),
        }),
      );

      await store.openRepository(REPO.fsPath);
      expect(store.lensOids().size).toBe(2);

      await store.openRepository(REPO_TWO.fsPath);
      expect(store.lensOids().size).toBe(0);

      // A failed open leaves no repository, so no lens highlights either.
      await store.openRepository(REPO.fsPath);
      expect(store.lensOids().size).toBe(2);
      await expect(store.openRepository('/tmp/missing')).resolves.toBeNull();
      expect(store.lensOids().size).toBe(0);
    });
  });
});
