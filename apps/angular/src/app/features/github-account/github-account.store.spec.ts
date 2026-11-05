import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSource } from '@contracts/auth';
import type {
  AuthStatus,
  GitHubRepo,
  ListGitHubReposRequest,
  PageInfo,
  RateLimit,
} from '@contracts/auth';
import { IpcBridge } from '@core/services/ipc-bridge.service';
import { GithubAccountStore } from './github-account.store';

function makeRepo(index: number): GitHubRepo {
  return {
    id: index,
    name: `repo-${index}`,
    fullName: `Nijnamovich/repo-${index}`,
    private: index % 2 === 0,
    htmlUrl: `https://github.com/Nijnamovich/repo-${index}`,
    description: `repo ${index}`,
    language: 'TypeScript',
    stargazersCount: index,
    updatedAt: '2026-01-02T10:00:00Z',
    nodeId: `node-${index}`,
    defaultBranch: 'main',
    ownerLogin: 'Nijnamovich',
    ownerAvatarUrl: 'https://avatars.example/u',
    visibility: index % 2 === 0 ? 'private' : 'public',
    fork: false,
    archived: false,
    disabled: false,
    cloneUrl: `https://github.com/Nijnamovich/repo-${index}.git`,
    sshUrl: `git@github.com:Nijnamovich/repo-${index}.git`,
    gitUrl: `git://github.com/Nijnamovich/repo-${index}.git`,
    pushedAt: '2026-01-02T10:00:00Z',
    createdAt: '2025-01-02T10:00:00Z',
    forksCount: 0,
    openIssuesCount: 0,
    topics: [],
    licenseSpdxId: 'MIT',
    isTemplate: false,
    homepage: '',
  };
}

function makeStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    authenticated: true,
    source: 2,
    accountLogin: 'Nijnamovich',
    name: 'David',
    avatarUrl: 'https://avatars.example/u',
    email: '',
    scopes: ['repo'],
    rateLimit: undefined,
    ...overrides,
  };
}

function makePageInfo(overrides: Partial<PageInfo> = {}): PageInfo {
  return { page: 1, perPage: 30, nextPage: 0, hasMore: false, total: 0, ...overrides };
}

function makeRateLimit(overrides: Partial<RateLimit> = {}): RateLimit {
  return {
    resource: 'core',
    limit: 5000,
    remaining: 4999,
    reset: 1767272400,
    resetAt: '2026-01-02T10:00:00Z',
    ...overrides,
  };
}

type Handler = (req: unknown) => unknown;
type Handlers = Partial<
  Record<'getAuthStatus' | 'connectGitHubFromCLI' | 'listGitHubRepos' | 'logout', Handler>
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

describe('GithubAccountStore', () => {
  let store: GithubAccountStore;

  beforeEach(() => {
    store = new GithubAccountStore(makeBridge({}));
  });

  it('connect() sets the authenticated status and sends the CLI request', async () => {
    const status = makeStatus({ authenticated: true, accountLogin: 'Nijnamovich' });
    const connectGitHubFromCLI = vi.fn(() => Promise.resolve({ status, user: undefined }));
    store = new GithubAccountStore(makeBridge({ connectGitHubFromCLI }));

    await store.connect();

    expect(connectGitHubFromCLI).toHaveBeenCalledWith({ ghBinary: '', verify: true });
    expect(store.status()).toEqual(status);
    expect(store.authenticated()).toBe(true);
    expect(store.offline()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('connect() forwards an explicit gh binary and verify flag', async () => {
    const connectGitHubFromCLI = vi.fn(() => Promise.resolve({ status: makeStatus(), user: undefined }));
    store = new GithubAccountStore(makeBridge({ connectGitHubFromCLI }));

    await store.connect('/opt/homebrew/bin/gh', false);

    expect(connectGitHubFromCLI).toHaveBeenCalledWith({ ghBinary: '/opt/homebrew/bin/gh', verify: false });
  });

  it('loadRepos() sets repos, pageInfo and rateLimit with the frozen query', async () => {
    const pageInfo = makePageInfo({ page: 1, nextPage: 2, hasMore: true });
    const rateLimit = makeRateLimit();
    const listGitHubRepos = vi.fn(() =>
      Promise.resolve({ repos: [makeRepo(1), makeRepo(2)], pageInfo, rateLimit }),
    );
    store = new GithubAccountStore(makeBridge({ listGitHubRepos }));

    await store.loadRepos();

    const expected: ListGitHubReposRequest = {
      perPage: 30,
      page: 1,
      sort: 'full_name',
      direction: 'asc',
      affiliation: '',
      visibility: '',
      type: '',
    };
    expect(listGitHubRepos).toHaveBeenCalledWith(expected);
    expect(store.repos().map((r) => r.id)).toEqual([1, 2]);
    expect(store.pageInfo()).toEqual(pageInfo);
    expect(store.rateLimit()).toEqual(rateLimit);
    expect(store.hasMore()).toBe(true);
    expect(store.loading()).toBe(false);
  });

  it('loadMore() appends the next page and respects nextPage', async () => {
    const rateLimit = makeRateLimit();
    const listGitHubRepos = vi.fn((req: unknown) => {
      const { page } = req as ListGitHubReposRequest;
      if (page === 1) {
        return Promise.resolve({
          repos: [makeRepo(1)],
          pageInfo: makePageInfo({ page: 1, nextPage: 2, hasMore: true }),
          rateLimit,
        });
      }
      return Promise.resolve({
        repos: [makeRepo(2)],
        pageInfo: makePageInfo({ page: 2, nextPage: 0, hasMore: false }),
        rateLimit,
      });
    });
    store = new GithubAccountStore(makeBridge({ listGitHubRepos }));

    await store.loadRepos();
    await store.loadMore();

    expect(listGitHubRepos).toHaveBeenNthCalledWith(1, {
      perPage: 30,
      page: 1,
      sort: 'full_name',
      direction: 'asc',
      affiliation: '',
      visibility: '',
      type: '',
    });
    expect(listGitHubRepos).toHaveBeenNthCalledWith(2, {
      perPage: 30,
      page: 2,
      sort: 'full_name',
      direction: 'asc',
      affiliation: '',
      visibility: '',
      type: '',
    });
    expect(store.repos().map((r) => r.id)).toEqual([1, 2]);
    expect(store.hasMore()).toBe(false);
  });

  it('loadMore() is a no-op when there is no next page', async () => {
    const listGitHubRepos = vi.fn(() =>
      Promise.resolve({
        repos: [makeRepo(1)],
        pageInfo: makePageInfo({ page: 1, nextPage: 0, hasMore: false }),
        rateLimit: makeRateLimit(),
      }),
    );
    store = new GithubAccountStore(makeBridge({ listGitHubRepos }));

    await store.loadRepos();
    await store.loadMore();

    expect(listGitHubRepos).toHaveBeenCalledTimes(1);
    expect(store.repos().map((r) => r.id)).toEqual([1]);
  });

  it('loadMore() does not re-enter while a request is in flight', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const listGitHubRepos = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    store = new GithubAccountStore(makeBridge({ listGitHubRepos }));

    const first = store.loadRepos();
    expect(store.loading()).toBe(true);
    await store.loadMore(); // ignored: loading
    expect(listGitHubRepos).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      repos: [makeRepo(1)],
      pageInfo: makePageInfo({ page: 1, nextPage: 2, hasMore: true }),
      rateLimit: makeRateLimit(),
    });
    await first;
  });

  it('refreshStatus() loads the current account status', async () => {
    const status = makeStatus({ accountLogin: 'Nijnamovich' });
    const getAuthStatus = vi.fn(() => Promise.resolve({ authenticated: true, login: 'Nijnamovich', status }));
    store = new GithubAccountStore(makeBridge({ getAuthStatus }));

    await store.refreshStatus();

    expect(getAuthStatus).toHaveBeenCalledWith({});
    expect(store.status()).toEqual(status);
    expect(store.authenticated()).toBe(true);
  });

  it('normalizes a string wire source to the numeric AuthSource', async () => {
    const wireStatus = {
      ...makeStatus(),
      source: 'AUTH_SOURCE_GITHUB_CLI',
    } as unknown as AuthStatus;
    const getAuthStatus = vi.fn(() => Promise.resolve({ authenticated: true, login: 'Nijnamovich', status: wireStatus }));
    store = new GithubAccountStore(makeBridge({ getAuthStatus }));

    await store.refreshStatus();

    expect(store.status()?.source).toBe(AuthSource.AUTH_SOURCE_GITHUB_CLI);
  });

  it('normalizes unknown string sources to AUTH_SOURCE_UNSPECIFIED', async () => {
    const wireStatus = {
      ...makeStatus(),
      source: 'SOMETHING_ELSE',
    } as unknown as AuthStatus;
    const getAuthStatus = vi.fn(() => Promise.resolve({ authenticated: true, login: 'Nijnamovich', status: wireStatus }));
    store = new GithubAccountStore(makeBridge({ getAuthStatus }));

    await store.refreshStatus();

    expect(store.status()?.source).toBe(AuthSource.AUTH_SOURCE_UNSPECIFIED);
  });

  it('normalizes a string wire source on connect() too', async () => {
    const wireStatus = {
      ...makeStatus(),
      source: 'AUTH_SOURCE_OAUTH',
    } as unknown as AuthStatus;
    const connectGitHubFromCLI = vi.fn(() => Promise.resolve({ status: wireStatus, user: undefined }));
    store = new GithubAccountStore(makeBridge({ connectGitHubFromCLI }));

    await store.connect();

    expect(store.status()?.source).toBe(AuthSource.AUTH_SOURCE_OAUTH);
  });

  it('logout() clears all account-derived state', async () => {
    const logout = vi.fn(() => Promise.resolve({}));
    store = new GithubAccountStore(makeBridge({ logout }));
    store.status.set(makeStatus());
    store.repos.set([makeRepo(1)]);
    store.pageInfo.set(makePageInfo({ nextPage: 2, hasMore: true }));

    await store.logout();

    expect(logout).toHaveBeenCalledWith({});
    expect(store.status()).toBeUndefined();
    expect(store.authenticated()).toBe(false);
    expect(store.repos()).toEqual([]);
    expect(store.pageInfo()).toBeUndefined();
  });

  it('routes non-IPC failures to the error signal', async () => {
    const listGitHubRepos = vi.fn(() => Promise.reject({ code: 'GITHUB_API_ERROR', message: 'boom' }));
    store = new GithubAccountStore(makeBridge({ listGitHubRepos }));

    await store.loadRepos();

    expect(store.error()).toEqual({ code: 'GITHUB_API_ERROR', message: 'boom', details: {} });
    expect(store.offline()).toBe(false);
  });

  it('degrades to offline when the IPC bridge is unavailable', async () => {
    const listGitHubRepos = vi.fn(() => {
      throw { code: 'IPC_UNAVAILABLE', message: 'Not running inside Electron' };
    });
    store = new GithubAccountStore(makeBridge({ listGitHubRepos }));

    await store.loadRepos();

    expect(store.offline()).toBe(true);
    expect(store.error()).toBeNull();
    expect(store.repos()).toEqual([]);
  });

  it('autoConnectOnce() refreshes status then connects when unauthenticated', async () => {
    const getAuthStatus = vi.fn(() =>
      Promise.resolve({
        authenticated: false,
        login: '',
        status: makeStatus({ authenticated: false }),
      }),
    );
    const connectGitHubFromCLI = vi.fn(() =>
      Promise.resolve({ status: makeStatus({ authenticated: true }), user: undefined }),
    );
    store = new GithubAccountStore(makeBridge({ getAuthStatus, connectGitHubFromCLI }));

    await store.autoConnectOnce();

    expect(getAuthStatus).toHaveBeenCalledTimes(1);
    expect(connectGitHubFromCLI).toHaveBeenCalledTimes(1);
    expect(store.authenticated()).toBe(true);
  });

  it('autoConnectOnce() does not connect when already authenticated', async () => {
    const getAuthStatus = vi.fn(() =>
      Promise.resolve({ authenticated: true, login: 'Nijnamovich', status: makeStatus() }),
    );
    const connectGitHubFromCLI = vi.fn();
    store = new GithubAccountStore(makeBridge({ getAuthStatus, connectGitHubFromCLI }));

    await store.autoConnectOnce();

    expect(getAuthStatus).toHaveBeenCalledTimes(1);
    expect(connectGitHubFromCLI).not.toHaveBeenCalled();
    expect(store.authenticated()).toBe(true);
  });

  it('autoConnectOnce() does not connect when the bridge is unavailable', async () => {
    const getAuthStatus = vi.fn(() => {
      throw { code: 'IPC_UNAVAILABLE', message: 'Not running inside Electron' };
    });
    const connectGitHubFromCLI = vi.fn();
    store = new GithubAccountStore(makeBridge({ getAuthStatus, connectGitHubFromCLI }));

    await store.autoConnectOnce();

    expect(store.offline()).toBe(true);
    expect(connectGitHubFromCLI).not.toHaveBeenCalled();
  });

  it('autoConnectOnce() is idempotent per app lifetime', async () => {
    const getAuthStatus = vi.fn(() =>
      Promise.resolve({
        authenticated: false,
        login: '',
        status: makeStatus({ authenticated: false }),
      }),
    );
    const connectGitHubFromCLI = vi.fn(() =>
      Promise.resolve({ status: makeStatus({ authenticated: false }), user: undefined }),
    );
    store = new GithubAccountStore(makeBridge({ getAuthStatus, connectGitHubFromCLI }));

    await store.autoConnectOnce();
    await store.autoConnectOnce();

    expect(getAuthStatus).toHaveBeenCalledTimes(1);
    expect(connectGitHubFromCLI).toHaveBeenCalledTimes(1);
  });

  it('autoConnectOnce() never throws when refresh fails', async () => {
    const getAuthStatus = vi.fn(() => Promise.reject({ code: 'GITHUB_API_ERROR', message: 'boom' }));
    const connectGitHubFromCLI = vi.fn(() =>
      Promise.reject({ code: 'GITHUB_API_ERROR', message: 'connect boom' }),
    );
    store = new GithubAccountStore(makeBridge({ getAuthStatus, connectGitHubFromCLI }));

    await expect(store.autoConnectOnce()).resolves.toBeUndefined();
    expect(store.error()).toEqual({ code: 'GITHUB_API_ERROR', message: 'connect boom', details: {} });
  });
});
