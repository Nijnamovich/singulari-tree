import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSource } from '@contracts/auth';
import type { AuthStatus, GitHubRepo, RateLimit } from '@contracts/auth';
import type { AppError } from '@core/services/ipc-bridge.service';
import { GithubAccount } from './github-account';
import { GithubAccountStore } from './github-account.store';

function makeRepo(id: number): GitHubRepo {
  return {
    id,
    name: `repo-${id}`,
    fullName: `Nijnamovich/repo-${id}`,
    private: false,
    htmlUrl: `https://github.com/Nijnamovich/repo-${id}`,
    description: `repo ${id}`,
    language: 'TypeScript',
    stargazersCount: 0,
    updatedAt: '2026-01-02T10:00:00Z',
    nodeId: `node-${id}`,
    defaultBranch: 'main',
    ownerLogin: 'Nijnamovich',
    ownerAvatarUrl: 'https://avatars.example/u',
    visibility: 'public',
    fork: false,
    archived: false,
    disabled: false,
    cloneUrl: `https://github.com/Nijnamovich/repo-${id}.git`,
    sshUrl: `git@github.com:Nijnamovich/repo-${id}.git`,
    gitUrl: `git://github.com/Nijnamovich/repo-${id}.git`,
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
    source: AuthSource.AUTH_SOURCE_GITHUB_CLI,
    accountLogin: 'Nijnamovich',
    name: 'David',
    avatarUrl: 'https://avatars.example/u',
    email: 'dave@example.com',
    scopes: ['repo'],
    rateLimit: undefined,
    ...overrides,
  };
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

interface StubOptions {
  authenticated?: boolean;
  loading?: boolean;
  offline?: boolean;
  error?: AppError | null;
  status?: AuthStatus | undefined;
  repos?: GitHubRepo[];
  hasMore?: boolean;
  rateLimit?: RateLimit | undefined;
}

/** Minimal `GithubAccountStore` stand-in exposing only what the container reads. */
function makeStore(opts: StubOptions = {}) {
  return {
    status: signal<AuthStatus | undefined>(opts.status),
    repos: signal<GitHubRepo[]>(opts.repos ?? []),
    rateLimit: signal<RateLimit | undefined>(opts.rateLimit),
    loading: signal(opts.loading ?? false),
    error: signal<AppError | null>(opts.error ?? null),
    offline: signal(opts.offline ?? false),
    authenticated: signal(opts.authenticated ?? false),
    hasMore: signal(opts.hasMore ?? false),
    refreshStatus: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    loadRepos: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
  };
}

async function setup(opts: StubOptions = {}) {
  const store = makeStore(opts);
  await TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: GithubAccountStore, useValue: store },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(GithubAccount);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, store };
}

function query<T extends Element>(fixture: { nativeElement: unknown }, testId: string): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

describe('GithubAccount', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the status and, when authenticated, the first repo page on init', async () => {
    const { store } = await setup({ authenticated: true, status: makeStatus() });

    expect(store.refreshStatus).toHaveBeenCalledTimes(1);
    expect(store.loadRepos).toHaveBeenCalledTimes(1);
  });

  it('does not load repos on init when unauthenticated', async () => {
    const { store } = await setup({ authenticated: false, status: makeStatus({ authenticated: false }) });

    expect(store.refreshStatus).toHaveBeenCalledTimes(1);
    expect(store.loadRepos).not.toHaveBeenCalled();
  });

  it('renders the connect action and the loading state', async () => {
    const { fixture } = await setup({ loading: true, authenticated: false });

    const connect = query<HTMLElement>(fixture, 'gh-connect');
    expect(connect).not.toBeNull();
    expect(connect!.querySelector('button')?.disabled).toBe(true);
    expect(query(fixture, 'gh-loading')).not.toBeNull();
  });

  it('renders the offline notice', async () => {
    const { fixture } = await setup({ offline: true, authenticated: false });

    expect(query(fixture, 'gh-offline')?.textContent).toContain('GitHub core offline');
  });

  it('renders the terminal error message', async () => {
    const { fixture } = await setup({
      error: { code: 'GITHUB_API_ERROR', message: 'boom', details: {} },
      authenticated: false,
    });

    expect(query(fixture, 'gh-error')?.textContent).toContain('boom');
  });

  it('renders the list-response rate limit', async () => {
    const { fixture } = await setup({
      authenticated: true,
      status: makeStatus(),
      rateLimit: makeRateLimit({ resource: 'core', remaining: 4999, limit: 5000 }),
    });

    expect(query(fixture, 'gh-rate-limit')?.textContent).toContain('4999/5000');
  });

  it('falls back to the status rate limit when the list has none', async () => {
    const { fixture } = await setup({
      authenticated: true,
      status: makeStatus({ rateLimit: makeRateLimit({ resource: 'search', remaining: 28, limit: 30 }) }),
    });

    const text = query(fixture, 'gh-rate-limit')?.textContent ?? '';
    expect(text).toContain('search');
    expect(text).toContain('28/30');
  });

  it('connect() loads repos once authentication succeeds', async () => {
    const { fixture, store } = await setup({ authenticated: false, status: makeStatus({ authenticated: false }) });
    store.connect.mockImplementation(async () => {
      store.authenticated.set(true);
    });

    query<HTMLButtonElement>(fixture, 'gh-connect')!.click();
    await fixture.whenStable();

    expect(store.connect).toHaveBeenCalledTimes(1);
    expect(store.loadRepos).toHaveBeenCalledTimes(1);
  });

  it('connect() keeps the repo list untouched when authentication fails', async () => {
    const { fixture, store } = await setup({ authenticated: false, status: makeStatus({ authenticated: false }) });

    query<HTMLButtonElement>(fixture, 'gh-connect')!.click();
    await fixture.whenStable();

    expect(store.connect).toHaveBeenCalledTimes(1);
    expect(store.loadRepos).not.toHaveBeenCalled();
  });

  it('loadMore() delegates to the store', async () => {
    const { fixture, store } = await setup({
      authenticated: true,
      status: makeStatus(),
      repos: [makeRepo(1)],
      hasMore: true,
    });

    query<HTMLButtonElement>(fixture, 'gh-load-more')!.click();
    await fixture.whenStable();

    expect(store.loadMore).toHaveBeenCalledTimes(1);
  });

  it('logout() delegates to the store', async () => {
    const { fixture, store } = await setup({ authenticated: true, status: makeStatus() });

    const logout = query<HTMLButtonElement>(fixture, 'gh-logout');
    expect(logout).not.toBeNull();
    logout!.click();
    await fixture.whenStable();

    expect(store.logout).toHaveBeenCalledTimes(1);
  });

  it('sourceLabel() maps known sources and falls back to unknown', async () => {
    const { fixture } = await setup({ authenticated: true, status: makeStatus() });
    const component = fixture.componentInstance;

    expect(component.sourceLabel(AuthSource.AUTH_SOURCE_GITHUB_CLI)).toBe('gh CLI');
    expect(component.sourceLabel(AuthSource.AUTH_SOURCE_OAUTH)).toBe('OAuth');
    expect(component.sourceLabel(AuthSource.AUTH_SOURCE_NONE)).toBe('none');
    expect(component.sourceLabel(undefined)).toBe('unknown');
    expect(component.sourceLabel(999 as AuthSource)).toBe('unknown');
  });
});
