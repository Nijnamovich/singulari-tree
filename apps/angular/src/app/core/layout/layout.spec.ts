import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Commit, Repository, Stash } from '@contracts/domain';
import type { GitFlowConfig, GitFlowResult, MergeResponse } from '@contracts/gitcore';
import { BranchLensStore } from '@core/services/branch-lens.store';
import { CommitFocusService } from '@core/services/commit-focus.service';
import {
  IpcBridge,
  type AppError,
  type DeepLinkPayload,
  type MenuNavigatePayload,
} from '@core/services/ipc-bridge.service';
import { RepoState, type ConflictState } from '@core/services/repo-state.service';
import { WorkspacesStore, type RepoTab } from '@core/services/workspaces.store';
import { GithubAccountStore } from '@features/github-account/github-account.store';
import { RemoteOpsStore } from '@features/remote/remote-ops.store';
import type {
  PushRowView,
  RemoteBranchOption,
  RemoteDialogKind,
  RemoteOpProgress,
  RemoteOption,
  RepoFetchState,
} from '@features/remote/remote-models';
import { LayoutComponent } from './layout';
import { LiveRegionService } from '@singularitree/ui-kit';

@Component({
  selector: 'st-spec-stub-page',
  standalone: true,
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class StubPageComponent {}

/**
 * The vitest jsdom environment exposes `window.localStorage` but does not copy
 * it onto `globalThis`, which the shell reads as a bare global. Install a small
 * in-memory implementation so persistence can be asserted deterministically.
 */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

function makeRepository(index: number): Repository {
  const name = `local-${index}`;
  return {
    id: `repo-${index}`,
    fsPath: `/tmp/${name}`,
    commonDir: `/tmp/${name}/.git`,
    name,
    createdAt: '2026-01-02T10:00:00Z',
    lastOpenedAt: '2026-01-02T10:00:00Z',
  };
}

function makeStash(index: number, message = `WIP ${index}`): Stash {
  return { index, oid: undefined, message, branchName: 'main' };
}

interface StubRepoStateOptions {
  repos?: Repository[];
  activeId?: string | null;
  branches?: string[];
  currentBranch?: string;
  currentBranchBehind?: number;
  remoteBranches?: string[];
  tags?: string[];
  remotes?: string[];
  refsLoading?: boolean;
  refsError?: AppError | null;
  refsOffline?: boolean;
  reposLoading?: boolean;
  reposError?: AppError | null;
  reposOffline?: boolean;
  removingId?: string | null;
  checkoutRunning?: boolean;
  stashRunning?: boolean;
  checkoutError?: AppError | null;
  refOpRunning?: boolean;
  refOpError?: AppError | null;
  conflict?: ConflictState | null;
  cherryPickDialog?: { source: string } | null;
  cherryPreview?: Commit | null;
  cherryPreviewLoading?: boolean;
  cherryPreviewError?: AppError | null;
  stashes?: Stash[];
  stashesLoading?: boolean;
  stashesError?: AppError | null;
  stashOpRunning?: boolean;
  stashOpError?: AppError | null;
  gitFlowConfig?: GitFlowConfig | null;
  gitFlowConfigLoading?: boolean;
  gitFlowConfigError?: AppError | null;
  gitFlowRunning?: boolean;
  gitFlowError?: AppError | null;
  gitFlowResult?: GitFlowResult | null;
}

function makeRepoState(opts: StubRepoStateOptions = {}) {
  const repos = signal<Repository[]>(opts.repos ?? []);
  const activeId = signal<string | null>(opts.activeId ?? null);
  const conflict = signal<ConflictState | null>(opts.conflict ?? null);
  return {
    repos,
    activeId,
    activeRepo: computed<Repository | null>(() => {
      const id = activeId();
      return id ? (repos().find((r) => r.id === id) ?? null) : null;
    }),
    reposLoading: signal(opts.reposLoading ?? false),
    reposError: signal<AppError | null>(opts.reposError ?? null),
    reposOffline: signal(opts.reposOffline ?? false),
    removingId: signal<string | null>(opts.removingId ?? null),
    branches: signal<string[]>(opts.branches ?? []),
    currentBranch: signal(opts.currentBranch ?? ''),
    currentBranchBehind: signal(opts.currentBranchBehind ?? 0),
    remoteBranches: signal<string[]>(opts.remoteBranches ?? []),
    tags: signal<string[]>(opts.tags ?? []),
    remotes: signal<string[]>(opts.remotes ?? []),
    refsLoading: signal(opts.refsLoading ?? false),
    refsError: signal<AppError | null>(opts.refsError ?? null),
    refsOffline: signal(opts.refsOffline ?? false),
    checkoutRunning: signal(opts.checkoutRunning ?? false),
    stashRunning: signal(opts.stashRunning ?? false),
    checkoutError: signal<AppError | null>(opts.checkoutError ?? null),
    refOpRunning: signal(opts.refOpRunning ?? false),
    refOpError: signal<AppError | null>(opts.refOpError ?? null),
    conflict,
    mergeConflict: computed<MergeResponse | null>(() => {
      const current = conflict();
      return current && current.operation === 'merge'
        ? { hasConflict: current.hasConflict, oid: current.oid }
        : null;
    }),
    cherryPickDialog: signal<{ source: string } | null>(opts.cherryPickDialog ?? null),
    cherryPreview: signal<Commit | null>(opts.cherryPreview ?? null),
    cherryPreviewLoading: signal(opts.cherryPreviewLoading ?? false),
    cherryPreviewError: signal<AppError | null>(opts.cherryPreviewError ?? null),
    stashes: signal<Stash[]>(opts.stashes ?? []),
    stashesLoading: signal(opts.stashesLoading ?? false),
    stashesError: signal<AppError | null>(opts.stashesError ?? null),
    stashOpRunning: signal(opts.stashOpRunning ?? false),
    stashOpError: signal<AppError | null>(opts.stashOpError ?? null),
    gitFlowConfig: signal<GitFlowConfig | null>(opts.gitFlowConfig ?? null),
    gitFlowConfigLoading: signal(opts.gitFlowConfigLoading ?? false),
    gitFlowConfigError: signal<AppError | null>(opts.gitFlowConfigError ?? null),
    gitFlowRunning: signal(opts.gitFlowRunning ?? false),
    gitFlowError: signal<AppError | null>(opts.gitFlowError ?? null),
    gitFlowResult: signal<GitFlowResult | null>(opts.gitFlowResult ?? null),
    statusRefreshRequested: signal(0),
    loadRepositories: vi.fn(async () => {}),
    reposLoaded: signal(false),
    whenRepositoriesLoaded: vi.fn(async () => {}),
    setActive: vi.fn(),
    clearActive: vi.fn(),
    loadRefs: vi.fn(async () => {}),
    loadStashes: vi.fn(async () => {}),
    removeRepository: vi.fn(async () => true),
    openRepositoryPath: vi.fn(async (): Promise<Repository | null> => null),
    checkoutBranch: vi.fn(async () => {}),
    stashPush: vi.fn(async () => true),
    stashApply: vi.fn(async () => true),
    stashPop: vi.fn(async () => true),
    stashDrop: vi.fn(async () => true),
    clearStashOpError: vi.fn(),
    dismissCheckoutError: vi.fn(),
    clearRefOpError: vi.fn(),
    dismissConflict: vi.fn(),
    dismissMergeConflict: vi.fn(),
    cherryPick: vi.fn(async () => true),
    openCherryPick: vi.fn(),
    closeCherryPick: vi.fn(),
    resolveCherryPickSource: vi.fn(async () => {}),
    revert: vi.fn(async () => true),
    createBranch: vi.fn(async () => true),
    renameBranch: vi.fn(async () => true),
    deleteBranch: vi.fn(async () => true),
    createTag: vi.fn(async () => true),
    deleteTag: vi.fn(async () => true),
    merge: vi.fn(async () => true),
    loadGitFlowConfig: vi.fn(async () => {}),
    saveGitFlowConfig: vi.fn(async () => true),
    startGitFlow: vi.fn(async () => true),
    finishGitFlow: vi.fn(async () => true),
    clearGitFlowError: vi.fn(),
    dismissGitFlowResult: vi.fn(),
  };
}

interface StubRemoteOpsOptions {
  activeDialog?: RemoteDialogKind | null;
  remoteOptions?: RemoteOption[];
  localBranchNames?: string[];
  currentBranch?: string;
  pushRows?: PushRowView[];
}

/**
 * Minimal `RemoteOpsStore` stand-in exposing only the members the shell
 * template reads. Every method is a spy so the toolbar wiring can be asserted
 * without crossing the IPC bridge.
 */
function makeRemoteOps(opts: StubRemoteOpsOptions = {}) {
  return {
    activeDialog: signal<RemoteDialogKind | null>(opts.activeDialog ?? null),
    remoteOptions: signal<RemoteOption[]>(opts.remoteOptions ?? []),
    remoteBranchesByRemote: signal<Record<string, RemoteBranchOption[]>>({}),
    localBranchNames: signal<string[]>(opts.localBranchNames ?? []),
    currentBranch: signal(opts.currentBranch ?? ''),
    pushRows: signal<PushRowView[]>(opts.pushRows ?? []),
    refsLoading: signal(false),
    offline: signal(false),
    running: signal(false),
    progress: signal<RemoteOpProgress | null>(null),
    opError: signal<AppError | null>(null),
    refsError: signal<AppError | null>(null),
    fetchStatus: signal<Readonly<Record<string, RepoFetchState>>>({}),
    fetchRepoId: signal<string | null>(null),
    fetchError: signal<AppError | null>(null),
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    loadRefs: vi.fn(async () => {}),
    runPull: vi.fn(async () => {}),
    runPush: vi.fn(async () => {}),
    runFetch: vi.fn(async () => {}),
    fetchRepo: vi.fn(async () => {}),
    fetchRepoIfStale: vi.fn(async () => {}),
    invalidateFetch: vi.fn(),
    clearFetch: vi.fn(),
  };
}

interface StubIpcBridge {
  onMenuNavigate: ReturnType<typeof vi.fn>;
  onDeepLink: ReturnType<typeof vi.fn>;
  signalDeepLinkReady: ReturnType<typeof vi.fn>;
  emitMenuNavigate: (payload: MenuNavigatePayload) => void;
  emitDeepLink: (payload: DeepLinkPayload) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  unsubscribeDeepLink: ReturnType<typeof vi.fn>;
}

/**
 * `IpcBridge` stand-in that captures the native-menu and deep-link listeners so
 * tests can push payloads and assert each unsubscribe on destroy.
 */
function makeIpcBridge(): StubIpcBridge {
  let menuListener: ((payload: MenuNavigatePayload) => void) | null = null;
  let deepLinkListener: ((payload: DeepLinkPayload) => void) | null = null;
  const unsubscribe = vi.fn();
  const unsubscribeDeepLink = vi.fn();
  const onMenuNavigate = vi.fn((cb: (payload: MenuNavigatePayload) => void) => {
    menuListener = cb;
    return unsubscribe;
  });
  const onDeepLink = vi.fn((cb: (payload: DeepLinkPayload) => void) => {
    deepLinkListener = cb;
    return unsubscribeDeepLink;
  });
  return {
    onMenuNavigate,
    onDeepLink,
    signalDeepLinkReady: vi.fn(),
    emitMenuNavigate: (payload) => menuListener?.(payload),
    emitDeepLink: (payload) => deepLinkListener?.(payload),
    unsubscribe,
    unsubscribeDeepLink,
  };
}

/** `GithubAccountStore` stand-in exposing only the startup auto-connect hook. */
function makeGithubAccount() {
  return { autoConnectOnce: vi.fn(async () => {}) };
}

/** Minimal `WorkspacesStore` stand-in with real tab/active signals. */
function makeWorkspaces(initialTabs: RepoTab[] = [], initialActive: string | null = null) {
  const tabs = signal<RepoTab[]>(initialTabs);
  const activeTabId = signal<string | null>(initialActive);
  return {
    tabs,
    activeTabId,
    openTab: vi.fn((repo: Repository) => {
      tabs.update((prev) =>
        prev.some((tab) => tab.repoId === repo.id)
          ? prev
          : [...prev, { repoId: repo.id, fsPath: repo.fsPath, name: repo.name }],
      );
      activeTabId.set(repo.id);
    }),
    selectTab: vi.fn((id: string) => activeTabId.set(id)),
    closeTab: vi.fn((id: string) => {
      const current = tabs();
      const index = current.findIndex((tab) => tab.repoId === id);
      const next = current.filter((tab) => tab.repoId !== id);
      tabs.set(next);
      if (activeTabId() === id) {
        activeTabId.set(next[Math.min(index, next.length - 1)]?.repoId ?? null);
      }
    }),
    rehydrate: vi.fn(),
    reconcile: vi.fn(),
  };
}

/** Minimal `CommitFocusService` stand-in with a real pending signal. */
function makeCommitFocus() {
  const pending = signal<{ repoId: string; oid: string } | null>(null);
  return {
    pending,
    request: vi.fn((repoId: string, oid: string) => pending.set({ repoId, oid })),
    clear: vi.fn(() => pending.set(null)),
    consume: vi.fn((repoId: string) => {
      const value = pending();
      if (value && value.repoId === repoId) {
        pending.set(null);
        return value.oid;
      }
      return null;
    }),
  };
}

/** Install an in-memory `navigator.clipboard` for copy/read assertions. */
function stubClipboard(initial = ''): { writeText: Mock; readText: Mock } {
  const writeText = vi.fn(async () => {});
  const readText = vi.fn(async () => initial);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText, readText },
    configurable: true,
  });
  return { writeText, readText };
}

async function setup(
  repoStateOpts: StubRepoStateOptions = {},
  remoteOpsOpts: StubRemoteOpsOptions = {},
  workspaces: ReturnType<typeof makeWorkspaces> = makeWorkspaces(),
  commitFocus: ReturnType<typeof makeCommitFocus> = makeCommitFocus(),
) {
  const repoState = makeRepoState(repoStateOpts);
  const remoteOps = makeRemoteOps(remoteOpsOpts);
  const ipcBridge = makeIpcBridge();
  const githubAccount = makeGithubAccount();
  await TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', component: StubPageComponent }]),
      { provide: RepoState, useValue: repoState },
      { provide: RemoteOpsStore, useValue: remoteOps },
      { provide: WorkspacesStore, useValue: workspaces },
      { provide: CommitFocusService, useValue: commitFocus },
      { provide: IpcBridge, useValue: ipcBridge },
      { provide: GithubAccountStore, useValue: githubAccount },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(LayoutComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, repoState, remoteOps, ipcBridge, githubAccount, workspaces, commitFocus };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function query<T extends Element>(fixture: { nativeElement: unknown }, testId: string): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

function queryAll<T extends Element>(fixture: { nativeElement: unknown }, testId: string): T[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<T>(`[data-testid="${testId}"]`),
  );
}

/**
 * The native `<button>` inside a `<st-button>` host carrying `testId`. The
 * top-bar wraps its actions in `st-button`, so the testid lands on the host and
 * the disabled/click state lives on the inner button.
 */
function innerButton<T extends HTMLButtonElement>(
  fixture: { nativeElement: unknown },
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(
    `[data-testid="${testId}"] button`,
  );
}

describe('LayoutComponent', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it('renders no hardcoded mock data', async () => {
    const { fixture } = await setup();

    const rendered = text(fixture);
    for (const mock of [
      'DFCustomerPortal_SPA_AIR.X',
      'feature/layout-shell',
      'v0.1.0',
      'david',
      'origin/main',
    ]) {
      expect(rendered).not.toContain(mock);
    }
  });

  it('shows the local empty state when there are no repositories', async () => {
    const { fixture } = await setup({ repos: [] });

    expect(query(fixture, 'repo-drawer-no-repos')).not.toBeNull();
    expect(query(fixture, 'repo-drawer-no-repos')?.textContent).toContain('No repositories');
  });

  it('renders a repo card per local repository', async () => {
    const { fixture } = await setup({ repos: [makeRepository(1), makeRepository(2)] });

    expect(query(fixture, 'repo-drawer-list')).not.toBeNull();
    const cards = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid="repo-card"]',
    );
    expect(cards.length).toBe(2);
  });

  it('loads the local repositories on init', async () => {
    const { repoState } = await setup();

    expect(repoState.loadRepositories).toHaveBeenCalledTimes(1);
  });

  it('activates the matching repository when a repo card is clicked', async () => {
    const repo = makeRepository(1);
    const { fixture, repoState } = await setup({ repos: [repo] });
    const card = query<HTMLElement>(fixture, 'repo-card');

    card!.click();

    expect(repoState.setActive).toHaveBeenCalledTimes(1);
    expect(repoState.setActive).toHaveBeenCalledWith(repo);
  });

  it('removes a repository from the drawer, clearing the active selection', async () => {
    const repo = makeRepository(1);
    const { fixture, repoState } = await setup({ repos: [repo], activeId: repo.id });

    query<HTMLButtonElement>(fixture, 'repo-drawer-remove')!.click();
    fixture.detectChanges();

    expect(repoState.removeRepository).toHaveBeenCalledTimes(1);
    expect(repoState.removeRepository).toHaveBeenCalledWith(repo.id);
  });

  it('persists the drawer pinned state to localStorage', async () => {
    const { fixture } = await setup();

    expect(localStorage.getItem('st:drawerPinned')).toBe('true');

    fixture.componentInstance.onDrawerToggled();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.drawerPinned()).toBe(false);
    expect(localStorage.getItem('st:drawerPinned')).toBe('false');
  });

  it('restores a persisted unpinned drawer state on init', async () => {
    localStorage.setItem('st:drawerPinned', 'false');

    const { fixture } = await setup();

    expect(fixture.componentInstance.drawerPinned()).toBe(false);
  });

  it('controls the sidebar workspace selection through the parent signal', async () => {
    const { fixture } = await setup();
    const el = fixture.nativeElement as HTMLElement;
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const items = el.querySelectorAll<HTMLElement>('.st-rail__item');
    expect(items.length).toBe(3);
    items[2].click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeWorkspace()).toBe('repos');
    expect(items[2].classList.contains('st-rail__item--active')).toBe(true);
  });

  it('routes the WORKSPACE "Commit analyzer" entry to /repo/file-status', async () => {
    const { fixture } = await setup();
    const el = fixture.nativeElement as HTMLElement;
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const items = Array.from(el.querySelectorAll<HTMLElement>('.st-rail__item'));
    const fileStatus = items.find((item) => item.textContent?.includes('Commit analyzer'));
    expect(fileStatus).toBeDefined();
    fileStatus!.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeWorkspace()).toBe('status');
    expect(navigate).toHaveBeenCalledWith(['/repo', 'file-status']);
    // The routed screen renders through the shared router outlet.
    expect(el.querySelector('router-outlet')).not.toBeNull();
  });

  it('leaves the file-status screen when WORKSPACE "History" is picked', async () => {
    const { fixture } = await setup();
    const el = fixture.nativeElement as HTMLElement;
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const items = Array.from(el.querySelectorAll<HTMLElement>('.st-rail__item'));
    items.find((item) => item.textContent?.includes('Commit analyzer'))!.click();
    fixture.detectChanges();
    navigate.mockClear();

    items.find((item) => item.textContent?.includes('History'))!.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeWorkspace()).toBe('history');
    expect(navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('syncs the WORKSPACE highlight to the URL on navigation from outside the sidebar', async () => {
    const { fixture } = await setup();
    const router = TestBed.inject(Router);

    // A graph hand-off navigates straight to File status, bypassing the sidebar.
    await router.navigateByUrl('/repo/file-status');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.activeWorkspace()).toBe('status');

    await router.navigateByUrl('/repo');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.activeWorkspace()).toBe('history');

    // `/repos` starts with `/repo` but maps to the Repositories WORKSPACE
    // entry, so the highlight follows it rather than clearing.
    await router.navigateByUrl('/repos');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.activeWorkspace()).toBe('repos');
  });

  it('routes the WORKSPACE "Repositories" entry to /repos', async () => {
    const { fixture } = await setup();
    const el = fixture.nativeElement as HTMLElement;
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const items = Array.from(el.querySelectorAll<HTMLElement>('.st-rail__item'));
    const repos = items.find((item) => item.textContent?.includes('Repositories'));
    expect(repos).toBeDefined();
    repos!.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeWorkspace()).toBe('repos');
    expect(navigate).toHaveBeenCalledWith(['/repos']);
  });

  it('renders the drawer pin toggle and toggles the pinned state', async () => {
    const { fixture } = await setup({ repos: [makeRepository(1)] });
    const el = fixture.nativeElement as HTMLElement;
    const drawer = el.querySelector<HTMLElement>('[data-testid="repo-drawer"]');
    expect(drawer).not.toBeNull();

    const pin = el.querySelector<HTMLElement>('[data-testid="repo-drawer-pin"]');
    expect(pin).not.toBeNull();
    expect(pin!.getAttribute('aria-pressed')).toBe('true');

    pin!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.drawerPinned()).toBe(false);
    expect(localStorage.getItem('st:drawerPinned')).toBe('false');
  });

  it('closing the unpinned drawer popover restores focus to the toggle', async () => {
    const { fixture } = await setup({ repos: [makeRepository(1)] });
    fixture.componentInstance.drawerPinned.set(false);
    fixture.componentInstance.drawerOpen.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // With the drawer unpinned and open, the floating popover is mounted.
    expect(query(fixture, 'popover')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.drawerOpen()).toBe(false);
    const toggle = query<HTMLElement>(fixture, 'top-bar-drawer-toggle');
    expect(toggle).not.toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('renders the real branch/remote names supplied by RepoState', async () => {
    const { fixture } = await setup({ branches: ['main', 'feature/x'], remotes: ['origin'] });
    const el = fixture.nativeElement as HTMLElement;

    const branches = el.querySelector('[data-testid="st-sidebar-branches"]');
    expect(branches?.textContent).toContain('main');
    expect(branches?.textContent).toContain('feature/x');
    expect(el.querySelector('[data-testid="st-sidebar-remotes"]')?.textContent).toContain('origin');
    expect(el.querySelector('[data-testid="st-sidebar-branches-empty"]')).toBeNull();
  });

  it('flows RepoState current branch/behind into the toolbar and sidebar badges', async () => {
    const { fixture } = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
      currentBranchBehind: 5,
    });
    const el = fixture.nativeElement as HTMLElement;

    const toolbarBadge = el.querySelector('[data-testid="top-bar-pull-badge"]');
    expect(toolbarBadge?.textContent?.trim()).toBe('5');

    const sidebarBadges = el.querySelectorAll('[data-testid="st-sidebar-branch-badge"]');
    expect(sidebarBadges).toHaveLength(1);
    expect(sidebarBadges[0].textContent?.trim()).toBe('5');
  });

  it('passes real remote branches into the sidebar REMOTES section', async () => {
    const { fixture } = await setup({
      remotes: ['origin'],
      remoteBranches: ['origin/david/topic'],
    });
    const el = fixture.nativeElement as HTMLElement;

    const items = Array.from(
      el.querySelectorAll('[data-testid="st-sidebar-remote-branches"]'),
    ).map((li) => li.textContent?.trim());
    expect(items).toEqual(['david/topic']);
  });

  it('renders a real tag name once the TAGS section is expanded', async () => {
    const { fixture } = await setup({ tags: ['v0.1.0'] });
    const el = fixture.nativeElement as HTMLElement;

    const tagsHead = Array.from(el.querySelectorAll<HTMLButtonElement>('.st-rail__head')).find((b) =>
      b.textContent?.includes('Tags'),
    );
    expect(tagsHead).toBeDefined();
    tagsHead!.click();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="st-sidebar-tags"]')?.textContent).toContain('v0.1.0');
  });

  it('shows the "No branches" empty state when RepoState has no refs', async () => {
    const { fixture } = await setup();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="st-sidebar-branches-empty"]')?.textContent).toContain(
      'No branches',
    );
  });

  it('disables the remote-op buttons when no repository is active', async () => {
    const { fixture } = await setup({ activeId: null });

    for (const testId of ['top-bar-pull', 'top-bar-push', 'top-bar-fetch']) {
      expect(innerButton(fixture, testId)?.disabled).toBe(true);
    }
  });

  it('enables the remote-op buttons when a repository is active', async () => {
    const { fixture } = await setup({ activeId: 'repo-1' });

    for (const testId of ['top-bar-pull', 'top-bar-push', 'top-bar-fetch']) {
      expect(innerButton(fixture, testId)?.disabled).toBe(false);
    }
  });

  it('opens the pull dialog from the top bar', async () => {
    const { fixture, remoteOps } = await setup({ activeId: 'repo-1' });

    innerButton(fixture, 'top-bar-pull')!.click();

    expect(remoteOps.openDialog).toHaveBeenCalledTimes(1);
    expect(remoteOps.openDialog).toHaveBeenCalledWith('pull');
  });

  it('opens the push dialog from the top bar', async () => {
    const { fixture, remoteOps } = await setup({ activeId: 'repo-1' });

    innerButton(fixture, 'top-bar-push')!.click();

    expect(remoteOps.openDialog).toHaveBeenCalledTimes(1);
    expect(remoteOps.openDialog).toHaveBeenCalledWith('push');
  });

  it('opens the fetch dialog from the top bar', async () => {
    const { fixture, remoteOps } = await setup({ activeId: 'repo-1' });

    innerButton(fixture, 'top-bar-fetch')!.click();

    expect(remoteOps.openDialog).toHaveBeenCalledTimes(1);
    expect(remoteOps.openDialog).toHaveBeenCalledWith('fetch');
  });

  it('renders the fetch dialog only while the store has fetch active', async () => {
    const { fixture, remoteOps } = await setup({ activeId: 'repo-1' });

    expect(query(fixture, 'fetch-dialog')).toBeNull();

    remoteOps.activeDialog.set('fetch');
    fixture.detectChanges();

    expect(query(fixture, 'fetch-dialog')).not.toBeNull();
    expect(query(fixture, 'pull-dialog')).toBeNull();
    expect(query(fixture, 'push-dialog')).toBeNull();
  });

  it('renders the pull dialog only while the store has pull active', async () => {
    const { fixture, remoteOps } = await setup({ activeId: 'repo-1' });

    expect(query(fixture, 'pull-dialog')).toBeNull();

    remoteOps.activeDialog.set('pull');
    fixture.detectChanges();

    expect(query(fixture, 'pull-dialog')).not.toBeNull();
    expect(query(fixture, 'fetch-dialog')).toBeNull();
    expect(query(fixture, 'push-dialog')).toBeNull();
  });

  it('routes the pull dialog submit to the store', async () => {
    const { fixture, remoteOps } = await setup(
      { activeId: 'repo-1' },
      {
        activeDialog: 'pull',
        remoteOptions: [{ name: 'origin', url: 'git@example.com:org/repo.git' }],
        localBranchNames: ['main', 'feature'],
        currentBranch: 'main',
      },
    );

    query<HTMLButtonElement>(fixture, 'pull-submit')!.click();
    fixture.detectChanges();

    expect(remoteOps.runPull).toHaveBeenCalledTimes(1);
    expect(remoteOps.runPull).toHaveBeenCalledWith({
      remote: 'origin',
      branch: 'main',
      intoLocalBranch: 'main',
      noCommit: false,
      log: false,
      noFf: false,
      rebase: false,
    });
  });

  it('routes the push dialog submit to the store', async () => {
    const { fixture, remoteOps } = await setup(
      { activeId: 'repo-1' },
      {
        activeDialog: 'push',
        remoteOptions: [{ name: 'origin', url: 'git@example.com:org/repo.git' }],
        pushRows: [
          {
            localBranch: 'main',
            isCurrent: true,
            upstream: 'refs/remotes/origin/main',
            defaultRemoteBranch: 'main',
          },
        ],
      },
    );

    const checkbox = query<HTMLInputElement>(fixture, 'push-row-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    query<HTMLButtonElement>(fixture, 'push-submit')!.click();
    fixture.detectChanges();

    expect(remoteOps.runPush).toHaveBeenCalledTimes(1);
    expect(remoteOps.runPush).toHaveBeenCalledWith({
      remote: 'origin',
      branches: [{ localBranch: 'main', remoteBranch: 'main', track: false }],
      tags: false,
      force: false,
    });
  });

  it('routes the fetch dialog submit to the store', async () => {
    const { fixture, remoteOps } = await setup(
      { activeId: 'repo-1' },
      {
        activeDialog: 'fetch',
        remoteOptions: [{ name: 'origin', url: 'git@example.com:org/repo.git' }],
      },
    );

    query<HTMLButtonElement>(fixture, 'fetch-submit')!.click();
    fixture.detectChanges();

    expect(remoteOps.runFetch).toHaveBeenCalledTimes(1);
    expect(remoteOps.runFetch).toHaveBeenCalledWith({
      allRemotes: true,
      remote: 'origin',
      prune: false,
      tags: false,
      force: false,
    });
  });

  it('does not render the retired in-app chrome controls', async () => {
    const { fixture } = await setup();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('st-shell-menubar')).toBeNull();
    expect(el.querySelector('[data-testid="theme-toggle"]')).toBeNull();
  });

  it('triggers the account auto-connect once at startup', async () => {
    const { githubAccount } = await setup();

    expect(githubAccount.autoConnectOnce).toHaveBeenCalledTimes(1);
  });

  it('navigates on a known native-menu route', async () => {
    const { fixture, ipcBridge } = await setup();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    ipcBridge.emitMenuNavigate({ route: '/github-account' });
    fixture.detectChanges();

    expect(ipcBridge.onMenuNavigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/github-account');
  });

  it('ignores empty and unknown native-menu routes', async () => {
    const { fixture, ipcBridge } = await setup();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    ipcBridge.emitMenuNavigate({ route: '' });
    ipcBridge.emitMenuNavigate({ route: '/nope' });
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
  });

  it('unsubscribes from the native-menu listener on destroy', async () => {
    const { fixture, ipcBridge } = await setup();

    fixture.destroy();

    expect(ipcBridge.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('opens the switch confirmation before any checkout on a local branch double-click', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    const row = queryAll<HTMLElement>(fixture, 'st-sidebar-branch').find(
      (el) => el.textContent?.trim() === 'feature/x',
    );
    expect(row).not.toBeNull();
    row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();

    expect(query(fixture, 'switch-branch-message')?.textContent?.trim()).toBe(
      "Are you sure you want to switch your working copy to a branch 'feature/x'?",
    );
    // The confirmation must precede the checkout: no IPC yet.
    expect(repoState.checkoutBranch).not.toHaveBeenCalled();
  });

  it('checks out a local branch only after confirming the switch dialog', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    clickBranch(fixture, 'feature/x');
    fixture.detectChanges();
    expect(repoState.checkoutBranch).not.toHaveBeenCalled();

    query<HTMLButtonElement>(fixture, 'switch-branch-confirm')!.click();

    expect(repoState.checkoutBranch).toHaveBeenCalledTimes(1);
    expect(repoState.checkoutBranch).toHaveBeenCalledWith('feature/x', false, false, false);
  });

  it('checks out the local branch with force=true when the switch checkbox is armed', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    clickBranch(fixture, 'feature/x');
    fixture.detectChanges();
    const checkbox = query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    query<HTMLButtonElement>(fixture, 'switch-branch-confirm')!.click();

    expect(repoState.checkoutBranch).toHaveBeenCalledWith('feature/x', false, true, false);
  });

  it('opens the switch confirmation before any checkout on a remote-tracking branch double-click', async () => {
    const { fixture, repoState } = await setup({
      remotes: ['origin'],
      remoteBranches: ['origin/david/topic'],
    });

    const row = query<HTMLElement>(fixture, 'st-sidebar-remote-branches');
    expect(row).not.toBeNull();
    row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();

    expect(query(fixture, 'switch-branch-message')?.textContent?.trim()).toBe(
      "Are you sure you want to switch your working copy to a branch 'origin/david/topic'?",
    );
    expect(repoState.checkoutBranch).not.toHaveBeenCalled();

    query<HTMLButtonElement>(fixture, 'switch-branch-confirm')!.click();

    expect(repoState.checkoutBranch).toHaveBeenCalledWith('origin/david/topic', true, false, false);
  });

  it('does not open the confirmation or checkout when the current local branch is clicked', async () => {
    const { fixture, repoState } = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
    });

    clickBranch(fixture, 'main');
    fixture.detectChanges();

    expect(query(fixture, 'switch-branch-message')).toBeNull();
    expect(repoState.checkoutBranch).not.toHaveBeenCalled();
  });

  it('cancels the pre-checkout confirmation without any IPC call', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    clickBranch(fixture, 'feature/x');
    fixture.detectChanges();

    query<HTMLButtonElement>(fixture, 'switch-branch-cancel')!.click();
    fixture.detectChanges();

    expect(repoState.checkoutBranch).not.toHaveBeenCalled();
    expect(query(fixture, 'switch-branch-message')).toBeNull();
  });

  it('cancelling a plain confirm prompt leaves a pre-existing checkout error untouched', async () => {
    const { fixture, repoState } = await setup({
      branches: ['main', 'feature/x'],
      checkoutError: {
        code: 'CHECKOUT_FAILED',
        message: 'Your local changes would be overwritten by checkout.',
        details: { reason: 'dirty_working_tree' },
      },
    });

    clickBranch(fixture, 'feature/x');
    fixture.detectChanges();
    expect(query(fixture, 'switch-branch-message')).not.toBeNull();

    query<HTMLButtonElement>(fixture, 'switch-branch-cancel')!.click();
    fixture.detectChanges();

    // No checkout was attempted, so `confirm` cancel is a true no-op: it must
    // not touch the unrelated checkout error and must issue no IPC.
    expect(repoState.checkoutBranch).not.toHaveBeenCalled();
    expect(repoState.stashPush).not.toHaveBeenCalled();
    expect(repoState.dismissCheckoutError).not.toHaveBeenCalled();
    expect(query(fixture, 'switch-branch-message')).toBeNull();
  });

  it('renders the checkout-error banner from RepoState and dismisses through the store', async () => {
    const { fixture, repoState } = await setup({
      checkoutError: {
        code: 'CHECKOUT_FAILED',
        message: 'Your local changes would be overwritten by checkout.',
        details: { reason: 'dirty_working_tree', paths: 'src/a.ts\nsrc/b.ts' },
      },
    });

    expect(query(fixture, 'checkout-error-message')?.textContent).toContain(
      'Your local changes would be overwritten by checkout.',
    );
    const paths = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="checkout-error-path"]',
      ),
    ).map((el) => el.textContent?.trim());
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);

    query<HTMLButtonElement>(fixture, 'checkout-error-dismiss')!.click();

    expect(repoState.dismissCheckoutError).toHaveBeenCalledTimes(1);
  });

  it('does not render the checkout-error banner when RepoState has no error', async () => {
    const { fixture } = await setup();

    expect(query(fixture, 'checkout-error-banner')).toBeNull();
  });

  // -- attempt-then-prompt branch switch -----------------------------------

  /** Double-click the sidebar branch row whose visible label matches `name`. */
  function clickBranch(fixture: { nativeElement: unknown }, name: string): void {
    const row = queryAll<HTMLElement>(fixture, 'st-sidebar-branch').find(
      (el) => el.textContent?.trim() === name,
    );
    if (!row) throw new Error(`branch row '${name}' not found`);
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }

  async function openDirtyPrompt(
    fixture: {
      nativeElement: unknown;
      detectChanges: () => void;
      whenStable: () => Promise<void>;
    },
    repoState: ReturnType<typeof makeRepoState>,
    branchName = 'feature/x',
  ): Promise<void> {
    // Every switch now starts with the pre-checkout confirmation.
    clickBranch(fixture, branchName);
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'switch-branch-confirm')!.click();
    fixture.detectChanges();
    // The unforced checkout was blocked by the dirty tree.
    repoState.checkoutError.set({
      code: 'CHECKOUT_FAILED',
      message: 'Your local changes would be overwritten by checkout.',
      details: { reason: 'dirty_working_tree' },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('keeps the dirty dialog open while the checkout operation is running', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });
    await openDirtyPrompt(fixture, repoState);
    expect(query(fixture, 'switch-branch-hint')).not.toBeNull();

    // A retry starts by nulling `checkoutError` while the checkout is still in
    // flight; the dialog must not flicker away before it settles.
    repoState.checkoutRunning.set(true);
    repoState.checkoutError.set(null);
    fixture.detectChanges();

    expect(query(fixture, 'switch-branch-message')).not.toBeNull();
    expect(query(fixture, 'switch-branch-hint')).not.toBeNull();

    // Once the operation settles the effect closes it.
    repoState.checkoutRunning.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(query(fixture, 'switch-branch-message')).toBeNull();
  });

  it('falls through to the dirty dialog when the unforced switch is blocked', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    await openDirtyPrompt(fixture, repoState);

    // The confirm dialog was replaced by the dirty escalation, not left open.
    expect(query(fixture, 'switch-branch-message')?.textContent?.trim()).toBe(
      "Are you sure you want to switch your working copy to a branch 'feature/x'?",
    );
    expect(query(fixture, 'switch-branch-hint')).not.toBeNull();
    expect(query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')?.checked).toBe(false);
    // The banner must not duplicate the error while the dialog owns it.
    expect(query(fixture, 'checkout-error-banner')).toBeNull();
  });

  it('routes the Force checkout action with force=true and no untracked clean', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });
    await openDirtyPrompt(fixture, repoState);

    const checkbox = query<HTMLInputElement>(fixture, 'switch-branch-force-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    query<HTMLButtonElement>(fixture, 'switch-branch-force')!.click();

    expect(repoState.checkoutBranch).toHaveBeenCalledWith('feature/x', false, true, false);
  });

  it('routes Save changes through stashPush then the plain checkout', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });
    await openDirtyPrompt(fixture, repoState);

    query<HTMLButtonElement>(fixture, 'switch-branch-save')!.click();
    await vi.waitFor(() =>
      expect(repoState.checkoutBranch).toHaveBeenCalledWith('feature/x', false, false, false),
    );

    expect(repoState.stashPush).toHaveBeenCalledWith(
      "Auto-stash before switching to 'feature/x'",
    );
  });

  it('does not retry the checkout when stashing fails', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });
    repoState.stashPush.mockResolvedValue(false);
    await openDirtyPrompt(fixture, repoState);
    // The initial blocked attempt already called checkoutBranch; only assert on retries.
    repoState.checkoutBranch.mockClear();

    query<HTMLButtonElement>(fixture, 'switch-branch-save')!.click();
    await vi.waitFor(() => expect(repoState.stashPush).toHaveBeenCalledTimes(1));

    expect(repoState.checkoutBranch).not.toHaveBeenCalled();
  });

  it('dismisses the dialog through the store on Cancel', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });
    await openDirtyPrompt(fixture, repoState);

    query<HTMLButtonElement>(fixture, 'switch-branch-cancel')!.click();
    fixture.detectChanges();

    expect(repoState.dismissCheckoutError).toHaveBeenCalledTimes(1);
    expect(query(fixture, 'switch-branch-message')).toBeNull();
  });

  it('escalates to the untracked warning and cleans untracked files on confirm', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });
    await openDirtyPrompt(fixture, repoState);

    repoState.checkoutError.set({
      code: 'CHECKOUT_FAILED',
      message: 'The following untracked working tree files would be overwritten by checkout.',
      details: { reason: 'untracked_working_tree' },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(query(fixture, 'switch-branch-warning')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'All untracked files and folders will be permanently deleted. Ignored files are kept.',
    );
    expect(query(fixture, 'switch-branch-force-checkbox')).toBeNull();

    query<HTMLButtonElement>(fixture, 'switch-branch-force')!.click();

    expect(repoState.checkoutBranch).toHaveBeenCalledWith('feature/x', false, true, true);
  });

  it('keeps the fallback banner for a non-dirty checkout failure', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    clickBranch(fixture, 'feature/x');
    fixture.detectChanges();
    // Confirm the pre-checkout dialog, then the checkout fails for a non-dirty reason.
    query<HTMLButtonElement>(fixture, 'switch-branch-confirm')!.click();
    fixture.detectChanges();
    repoState.checkoutError.set({
      code: 'CHECKOUT_FAILED',
      message: 'reference is not a tree',
      details: { reason: 'git_error' },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(query(fixture, 'switch-branch-message')).toBeNull();
    expect(query(fixture, 'checkout-error-banner')).not.toBeNull();
  });

  // -- branch lens (ADR-0042) ----------------------------------------------

  it('clears the lens instead of lensing the current local branch', async () => {
    const { fixture } = await setup({ branches: ['main', 'feature/x'], currentBranch: 'main' });
    const lens = TestBed.inject(BranchLensStore);
    lens.set('feature/x', 'local');
    const clear = vi.spyOn(lens, 'clear');
    const toggle = vi.spyOn(lens, 'toggle');

    fixture.componentInstance.onLensToggled({ ref: 'main', kind: 'local' });

    // The current branch's history already is the HEAD walk: never lens it.
    expect(clear).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
    expect(lens.active()).toBe(false);
    expect(lens.ref()).toBeNull();
  });

  it('toggles the lens for a non-current local branch', async () => {
    const { fixture } = await setup({ branches: ['main', 'feature/x'], currentBranch: 'main' });
    const lens = TestBed.inject(BranchLensStore);
    const toggle = vi.spyOn(lens, 'toggle');

    fixture.componentInstance.onLensToggled({ ref: 'feature/x', kind: 'local' });

    expect(toggle).toHaveBeenCalledWith('feature/x', 'local');
    expect(lens.ref()).toBe('feature/x');
    expect(lens.kind()).toBe('local');
  });

  it('clears an active lens before opening the local checkout confirmation', async () => {
    const { fixture, repoState } = await setup({
      branches: ['main', 'other'],
      currentBranch: 'main',
    });
    const lens = TestBed.inject(BranchLensStore);
    lens.set('feature/x', 'local');
    const clear = vi.spyOn(lens, 'clear');

    fixture.componentInstance.onBranchSelected('other');

    // Checkout is the terminal "no lens" state: drop the scope first, then ask.
    expect(clear).toHaveBeenCalledTimes(1);
    expect(lens.active()).toBe(false);
    expect(fixture.componentInstance.checkoutPrompt()).toEqual({
      name: 'other',
      isRemote: false,
      mode: 'confirm',
    });
    expect(repoState.checkoutBranch).not.toHaveBeenCalled();
  });

  it('clears an active lens before opening the remote-tracking checkout confirmation', async () => {
    const { fixture, repoState } = await setup({
      remotes: ['origin'],
      remoteBranches: ['origin/other'],
    });
    const lens = TestBed.inject(BranchLensStore);
    lens.set('feature/x', 'local');
    const clear = vi.spyOn(lens, 'clear');

    fixture.componentInstance.onRemoteBranchSelected('origin/other');

    expect(clear).toHaveBeenCalledTimes(1);
    expect(lens.active()).toBe(false);
    expect(fixture.componentInstance.checkoutPrompt()).toEqual({
      name: 'origin/other',
      isRemote: true,
      mode: 'confirm',
    });
    expect(repoState.checkoutBranch).not.toHaveBeenCalled();
  });

  // -- ref mutation dialogs (ADR-028) --------------------------------------

  function openBranchMenu(fixture: { nativeElement: unknown; detectChanges: () => void }, name: string): void {
    const row = queryAll<HTMLElement>(fixture, 'st-sidebar-branch').find(
      (el) => el.textContent?.trim() === name,
    );
    if (!row) throw new Error(`branch row '${name}' not found`);
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
  }

  it('renders and dismisses the merge conflict banner through the store', async () => {
    const { fixture, repoState } = await setup({
      conflict: { operation: 'merge', hasConflict: true, oid: 'abc' },
    });

    expect(query(fixture, 'merge-conflict-banner')).not.toBeNull();

    query<HTMLButtonElement>(fixture, 'merge-conflict-dismiss')!.click();

    expect(repoState.dismissConflict).toHaveBeenCalledTimes(1);
  });

  it('opens the create-branch dialog from the sidebar "+" and routes the submit', async () => {
    const { fixture, repoState } = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
    });

    query<HTMLButtonElement>(fixture, 'st-sidebar-add-branch')!.click();
    fixture.detectChanges();

    expect((query<HTMLInputElement>(fixture, 'branch-create-start')!).value).toBe('main');

    const name = query<HTMLInputElement>(fixture, 'branch-create-name')!;
    name.value = 'topic';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'branch-create-submit')!.click();

    await vi.waitFor(() =>
      expect(repoState.createBranch).toHaveBeenCalledWith('topic', 'main', true),
    );
  });

  it('creates a tag from the sidebar TAGS "+"', async () => {
    const { fixture, repoState } = await setup({ tags: ['v1'] });

    query<HTMLButtonElement>(fixture, 'st-sidebar-add-tag')!.click();
    fixture.detectChanges();

    const name = query<HTMLInputElement>(fixture, 'tag-create-name')!;
    name.value = 'v2';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'tag-create-submit')!.click();

    await vi.waitFor(() =>
      expect(repoState.createTag).toHaveBeenCalledWith('v2', 'HEAD', false, '', false),
    );
  });

  it('renames a branch through its row menu and dialog', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    openBranchMenu(fixture, 'feature/x');
    query<HTMLButtonElement>(fixture, 'st-sidebar-menu-rename')!.click();
    fixture.detectChanges();

    const input = query<HTMLInputElement>(fixture, 'ref-rename-input')!;
    input.value = 'feature/y';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'ref-rename-submit')!.click();

    await vi.waitFor(() =>
      expect(repoState.renameBranch).toHaveBeenCalledWith('feature/x', 'feature/y'),
    );
  });

  it('deletes a branch through its row menu with the force toggle', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    openBranchMenu(fixture, 'feature/x');
    query<HTMLButtonElement>(fixture, 'st-sidebar-menu-delete')!.click();
    fixture.detectChanges();

    expect(query(fixture, 'ref-delete-warning')?.textContent).toContain('feature/x');

    const force = query<HTMLInputElement>(fixture, 'ref-delete-force')!;
    force.checked = true;
    force.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'ref-delete-confirm')!.click();

    await vi.waitFor(() =>
      expect(repoState.deleteBranch).toHaveBeenCalledWith('feature/x', true),
    );
  });

  it('deletes a tag through its row menu (no force toggle)', async () => {
    const { fixture, repoState } = await setup({ tags: ['v0.1.0'] });

    const tagsHead = Array.from(queryAll<HTMLButtonElement>(fixture, 'st-sidebar-tag'));
    expect(tagsHead).toHaveLength(0);
    // Expand TAGS first.
    const head = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.st-rail__head'),
    ).find((b) => b.textContent?.includes('Tags'))!;
    head.click();
    fixture.detectChanges();

    const tag = queryAll<HTMLElement>(fixture, 'st-sidebar-tag')[0];
    tag.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'st-sidebar-menu-delete')!.click();
    fixture.detectChanges();

    expect(query(fixture, 'ref-delete-force')).toBeNull();
    query<HTMLButtonElement>(fixture, 'ref-delete-confirm')!.click();

    await vi.waitFor(() => expect(repoState.deleteTag).toHaveBeenCalledWith('v0.1.0'));
  });

  it('merges a branch into the current one through its row menu', async () => {
    const { fixture, repoState } = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
    });

    openBranchMenu(fixture, 'feature/x');
    query<HTMLButtonElement>(fixture, 'st-sidebar-menu-merge')!.click();
    fixture.detectChanges();

    expect((query<HTMLSelectElement>(fixture, 'merge-ref')!).value).toBe('feature/x');
    query<HTMLButtonElement>(fixture, 'merge-submit')!.click();

    await vi.waitFor(() =>
      expect(repoState.merge).toHaveBeenCalledWith('feature/x', 'MERGE', false, ''),
    );
  });

  it('clears a ref-op error when a ref dialog is cancelled', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    query<HTMLButtonElement>(fixture, 'st-sidebar-add-branch')!.click();
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'branch-create-cancel')!.click();

    expect(repoState.clearRefOpError).toHaveBeenCalled();
  });

  // -- cherry-pick (ADR-0042) ----------------------------------------------

  const PREVIEW_COMMIT: Commit = {
    oid: { hex: 'abc1234' + '0'.repeat(33), kind: 'SHA1' },
    parents: [],
    author: { name: 'Ada', email: 'ada@example.com', when: '2026-01-02T10:00:00Z' },
    committer: undefined,
    message: 'fix: the thing',
    treeOid: undefined,
    committedAt: '2026-01-02T10:05:00Z',
    refs: [],
  };

  it('opens the cherry-pick dialog from the shared store signal and routes the submit', async () => {
    const { fixture, repoState } = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
      cherryPickDialog: { source: PREVIEW_COMMIT.oid!.hex },
      cherryPreview: PREVIEW_COMMIT,
    });

    expect(query(fixture, 'cherry-current')?.textContent).toContain('main');
    expect(query(fixture, 'cherry-preview')).not.toBeNull();

    query<HTMLButtonElement>(fixture, 'cherry-submit')!.click();

    await vi.waitFor(() =>
      expect(repoState.cherryPick).toHaveBeenCalledWith(PREVIEW_COMMIT.oid!.hex, false, false),
    );
  });

  it('previews the settled cherry-pick source through the store', async () => {
    const { fixture, repoState } = await setup({
      branches: ['main'],
      currentBranch: 'main',
      cherryPickDialog: { source: 'main' },
    });

    await vi.waitFor(() =>
      expect(repoState.resolveCherryPickSource).toHaveBeenCalledWith('main'),
    );
    fixture.detectChanges();
  });

  it('closes the cherry-pick dialog and clears its error on cancel', async () => {
    const { fixture, repoState } = await setup({
      cherryPickDialog: { source: 'abc1234' },
    });

    query<HTMLButtonElement>(fixture, 'cherry-cancel')!.click();

    expect(repoState.closeCherryPick).toHaveBeenCalled();
    expect(repoState.clearRefOpError).toHaveBeenCalled();
  });

  // -- stashes (ADR-028) ---------------------------------------------------

  function expandStashes(fixture: { nativeElement: unknown; detectChanges: () => void }): void {
    const head = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.st-rail__head'),
    ).find((b) => b.textContent?.includes('Stashes'))!;
    head.click();
    fixture.detectChanges();
  }

  it('opens the stash push dialog from the sidebar and routes the submit', async () => {
    const { fixture, repoState } = await setup({ stashes: [makeStash(0)] });

    query<HTMLButtonElement>(fixture, 'st-sidebar-stash-push')!.click();
    fixture.detectChanges();

    const message = query<HTMLInputElement>(fixture, 'stash-push-message')!;
    message.value = 'WIP';
    message.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'stash-push-submit')!.click();

    await vi.waitFor(() => expect(repoState.stashPush).toHaveBeenCalledWith('WIP'));
  });

  it('routes stash apply and pop straight to the store', async () => {
    const { fixture, repoState } = await setup({ stashes: [makeStash(0), makeStash(1)] });
    expandStashes(fixture);

    queryAll<HTMLButtonElement>(fixture, 'st-sidebar-stash-apply')[1].click();
    queryAll<HTMLButtonElement>(fixture, 'st-sidebar-stash-pop')[0].click();

    expect(repoState.stashApply).toHaveBeenCalledWith(1, false);
    expect(repoState.stashPop).toHaveBeenCalledWith(0);
  });

  it('confirms a stash drop through the dialog before dropping', async () => {
    const { fixture, repoState } = await setup({ stashes: [makeStash(2, 'WIP on main')] });
    expandStashes(fixture);

    queryAll<HTMLButtonElement>(fixture, 'st-sidebar-stash-drop')[0].click();
    fixture.detectChanges();

    expect(query(fixture, 'stash-drop-warning')?.textContent).toContain('stash@{2}');
    expect(repoState.stashDrop).not.toHaveBeenCalled();

    query<HTMLButtonElement>(fixture, 'stash-drop-confirm')!.click();

    await vi.waitFor(() => expect(repoState.stashDrop).toHaveBeenCalledWith(2));
  });

  it('opens the git-flow dialog on Start and routes the start payload', async () => {
    const { fixture, repoState } = await setup({
      branches: ['main', 'develop'],
      currentBranch: 'develop',
    });

    query<HTMLButtonElement>(fixture, 'st-sidebar-git-flow')!.click();
    fixture.detectChanges();

    expect(repoState.loadGitFlowConfig).toHaveBeenCalledTimes(1);
    expect((query<HTMLInputElement>(fixture, 'git-flow-start-base')!).value).toBe('develop');

    const name = query<HTMLInputElement>(fixture, 'git-flow-start-name')!;
    name.value = 'login';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'git-flow-start-submit')!.click();

    await vi.waitFor(() =>
      expect(repoState.startGitFlow).toHaveBeenCalledWith('FEATURE', 'login', 'develop'),
    );
  });

  it('routes the git-flow finish payload and keeps the dialog open for steps', async () => {
    const { fixture, repoState } = await setup({ branches: ['main', 'feature/x'] });

    query<HTMLButtonElement>(fixture, 'st-sidebar-git-flow')!.click();
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'git-flow-tab-finish')!.click();
    fixture.detectChanges();

    const name = query<HTMLInputElement>(fixture, 'git-flow-finish-name')!;
    name.value = 'login';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'git-flow-finish-submit')!.click();

    await vi.waitFor(() =>
      expect(repoState.finishGitFlow).toHaveBeenCalledWith('FEATURE', 'login', true),
    );
    // The dialog stays open so the returned steps/conflict remain visible.
    expect(query(fixture, 'git-flow-finish-submit')).not.toBeNull();
  });

  it('routes the git-flow config submit to the store', async () => {
    const { fixture, repoState } = await setup();

    query<HTMLButtonElement>(fixture, 'st-sidebar-git-flow')!.click();
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'git-flow-tab-config')!.click();
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'git-flow-config-submit')!.click();

    await vi.waitFor(() =>
      expect(repoState.saveGitFlowConfig).toHaveBeenCalledWith({
        mainBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        versionTagPrefix: 'v',
      }),
    );
  });

  it('shows the git-flow steps and conflict from the store result', async () => {
    const { fixture } = await setup({
      gitFlowResult: {
        branch: 'release/1.0',
        steps: ['checkout main', 'merge release/1.0'],
        hasConflict: true,
      },
    });

    query<HTMLButtonElement>(fixture, 'st-sidebar-git-flow')!.click();
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'git-flow-tab-finish')!.click();
    fixture.detectChanges();

    const steps = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="git-flow-step"]'),
    ).map((el) => el.textContent?.trim());
    expect(steps).toEqual(['checkout main', 'merge release/1.0']);
    expect(query(fixture, 'git-flow-conflict')).not.toBeNull();
  });

  it('clears the git-flow error and result when the dialog is cancelled', async () => {
    const { fixture, repoState } = await setup();

    query<HTMLButtonElement>(fixture, 'st-sidebar-git-flow')!.click();
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'git-flow-cancel')!.click();
    fixture.detectChanges();

    expect(repoState.clearGitFlowError).toHaveBeenCalled();
    expect(repoState.dismissGitFlowResult).toHaveBeenCalled();
    expect(query(fixture, 'git-flow-cancel')).toBeNull();
  });

  // -- repo tabs / workspaces (ADR-024) ------------------------------------

  it('renders header tabs from the workspace store and selects on click', async () => {
    const workspaces = makeWorkspaces(
      [
        { repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' },
        { repoId: 'repo-2', fsPath: '/tmp/local-2', name: 'local-2' },
      ],
      'repo-1',
    );
    const { fixture } = await setup({}, {}, workspaces);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const tabs = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.st-tab');
    expect(tabs).toHaveLength(2);
    tabs[1].click();

    expect(workspaces.selectTab).toHaveBeenCalledWith('repo-2');
    expect(navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('closing the active tab selects the neighbour and routes to the graph', async () => {
    const workspaces = makeWorkspaces(
      [
        { repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' },
        { repoId: 'repo-2', fsPath: '/tmp/local-2', name: 'local-2' },
      ],
      'repo-2',
    );
    const { fixture } = await setup({}, {}, workspaces);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const closes = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      '.st-tab__close',
    );
    closes[1].click();

    expect(workspaces.closeTab).toHaveBeenCalledWith('repo-2');
    expect(navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('closing the last tab routes to the repository manager', async () => {
    const workspaces = makeWorkspaces(
      [{ repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' }],
      'repo-1',
    );
    const { fixture } = await setup({}, {}, workspaces);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.st-tab__close')!.click();

    expect(navigate).toHaveBeenCalledWith(['/repos']);
  });

  it('the "+" header control routes to the repository manager', async () => {
    const { fixture } = await setup();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.st-tab__add')!.click();

    expect(navigate).toHaveBeenCalledWith(['/repos']);
  });

  it('selecting a repository from the drawer opens a tab', async () => {
    const repo = makeRepository(1);
    const { fixture, workspaces } = await setup({ repos: [repo] });

    query<HTMLElement>(fixture, 'repo-card')!.click();

    expect(workspaces.openTab).toHaveBeenCalledWith(repo);
  });

  it('removing a repository closes its tab', async () => {
    const repo = makeRepository(1);
    const { fixture, repoState, workspaces } = await setup({ repos: [repo], activeId: repo.id });
    repoState.removeRepository.mockResolvedValue(true);

    query<HTMLButtonElement>(fixture, 'repo-drawer-remove')!.click();
    await vi.waitFor(() => expect(workspaces.closeTab).toHaveBeenCalledWith(repo.id));
  });

  // -- active-tab sync (ADR-024) -------------------------------------------

  it('sync fetches only the active tab', async () => {
    const workspaces = makeWorkspaces(
      [
        { repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' },
        { repoId: 'repo-2', fsPath: '/tmp/local-2', name: 'local-2' },
      ],
      'repo-2',
    );
    const { fixture, remoteOps } = await setup({}, {}, workspaces);

    const sync = innerButton(fixture, 'top-bar-sync')!;
    expect(sync.disabled).toBe(false);
    expect(sync.textContent).toContain('Sync');
    sync.click();

    expect(remoteOps.fetchRepo).toHaveBeenCalledTimes(1);
    expect(remoteOps.fetchRepo).toHaveBeenCalledWith('repo-2', { force: true });
  });

  it('sync with no active tab is a no-op', async () => {
    const { fixture, remoteOps } = await setup();

    fixture.componentInstance.onSync();

    expect(remoteOps.fetchRepo).not.toHaveBeenCalled();
  });

  it('disables sync when no tab is active', async () => {
    const { fixture } = await setup();

    expect(innerButton(fixture, 'top-bar-sync')!.disabled).toBe(true);
  });

  it('triggers the lazy fetch when the active tab changes', async () => {
    const workspaces = makeWorkspaces(
      [
        { repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' },
        { repoId: 'repo-2', fsPath: '/tmp/local-2', name: 'local-2' },
      ],
      'repo-1',
    );
    const { fixture, remoteOps } = await setup({}, {}, workspaces);

    expect(remoteOps.fetchRepoIfStale).toHaveBeenCalledWith('repo-1');
    remoteOps.fetchRepoIfStale.mockClear();

    workspaces.selectTab('repo-2');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(remoteOps.fetchRepoIfStale).toHaveBeenCalledWith('repo-2');
  });

  it('drops a status line owned by another repository when the tab changes', async () => {
    const workspaces = makeWorkspaces(
      [
        { repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' },
        { repoId: 'repo-2', fsPath: '/tmp/local-2', name: 'local-2' },
      ],
      'repo-1',
    );
    const { fixture, remoteOps } = await setup({}, {}, workspaces);

    remoteOps.fetchRepoId.set('repo-1');
    remoteOps.fetchStatus.set({ 'repo-1': 'success' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(remoteOps.clearFetch).not.toHaveBeenCalled();

    workspaces.selectTab('repo-2');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // repo-1's settled line must not linger over repo-2.
    expect(remoteOps.clearFetch).toHaveBeenCalledTimes(1);
  });

  it('invalidates an in-flight fetch when its tab is closed', async () => {
    const workspaces = makeWorkspaces(
      [
        { repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' },
        { repoId: 'repo-2', fsPath: '/tmp/local-2', name: 'local-2' },
      ],
      'repo-2',
    );
    const { fixture, remoteOps } = await setup({}, {}, workspaces);

    const closes = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      '.st-tab__close',
    );
    closes[1].click();

    expect(remoteOps.invalidateFetch).toHaveBeenCalledWith('repo-2');
  });

  it('announces the single repository being fetched through the live region', async () => {
    const workspaces = makeWorkspaces(
      [{ repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' }],
      'repo-1',
    );
    const { fixture, remoteOps } = await setup({}, {}, workspaces);
    const liveRegion = TestBed.inject(LiveRegionService);

    remoteOps.fetchRepoId.set('repo-1');
    remoteOps.fetchStatus.set({ 'repo-1': 'pending' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(liveRegion.message()).toContain('Fetching repository');
    expect(liveRegion.message()).toContain('local-1');
    expect(liveRegion.message()).not.toContain('1/2');
    const region = (fixture.nativeElement as HTMLElement).querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region!.textContent).toContain('Fetching repository');
    expect(region!.textContent).toContain('local-1');
    expect(region!.textContent).not.toContain('1/2');
  });

  it('settles the live-region announcement with the fetch state', async () => {
    const workspaces = makeWorkspaces(
      [{ repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' }],
      'repo-1',
    );
    const { fixture, remoteOps } = await setup({}, {}, workspaces);
    const liveRegion = TestBed.inject(LiveRegionService);

    remoteOps.fetchRepoId.set('repo-1');
    remoteOps.fetchStatus.set({ 'repo-1': 'pending' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(liveRegion.message()).toContain('Fetching repository');

    // The fetch settles: the announcement must settle too, never keep claiming
    // to fetch.
    remoteOps.fetchStatus.set({ 'repo-1': 'success' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(liveRegion.message()).toContain('Repository up to date');
    expect(liveRegion.message()).not.toContain('Fetching repository');

    // A failure announces the failure.
    remoteOps.fetchStatus.set({ 'repo-1': 'failed' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(liveRegion.message()).toContain('Fetch failed');
  });

  it('clears its own live-region announcement when the fetch line closes', async () => {
    const workspaces = makeWorkspaces(
      [{ repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' }],
      'repo-1',
    );
    const { fixture, remoteOps } = await setup({}, {}, workspaces);
    const liveRegion = TestBed.inject(LiveRegionService);

    remoteOps.fetchRepoId.set('repo-1');
    remoteOps.fetchStatus.set({ 'repo-1': 'pending' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(liveRegion.message()).not.toBe('');

    // The line is dismissed: the shell clears the announcement it owns.
    remoteOps.fetchRepoId.set(null);
    remoteOps.fetchStatus.set({});
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(liveRegion.message()).toBe('');
  });

  it('keeps another producer live-region message when the fetch line closes', async () => {
    const workspaces = makeWorkspaces(
      [{ repoId: 'repo-1', fsPath: '/tmp/local-1', name: 'local-1' }],
      'repo-1',
    );
    const { fixture, remoteOps } = await setup({}, {}, workspaces);
    const liveRegion = TestBed.inject(LiveRegionService);

    remoteOps.fetchRepoId.set('repo-1');
    remoteOps.fetchStatus.set({ 'repo-1': 'pending' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Another producer (the graph's refused-selection notice) takes the region.
    liveRegion.announce('Commit selection is locked.');
    remoteOps.fetchRepoId.set(null);
    remoteOps.fetchStatus.set({});
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The shell must not wipe a message it does not own.
    expect(liveRegion.message()).toBe('Commit selection is locked.');
  });

  // -- deep links (ADR-025) ------------------------------------------------

  it('opens a repository by absolute path from a deep link', async () => {
    const repo = makeRepository(1);
    const { fixture, repoState, workspaces, ipcBridge } = await setup({ repos: [repo] });
    repoState.openRepositoryPath.mockResolvedValue(repo);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    ipcBridge.emitDeepLink({ kind: 'open-path', path: repo.fsPath });
    await vi.waitFor(() => expect(workspaces.openTab).toHaveBeenCalledWith(repo));

    expect(repoState.openRepositoryPath).toHaveBeenCalledWith(repo.fsPath);
    expect(navigate).toHaveBeenCalledWith(['/repo']);
    expect(fixture.componentInstance.activeWorkspace()).toBe('history');
  });

  it('ignores an open-path deep link when the repository cannot be opened', async () => {
    const { fixture, repoState, workspaces, ipcBridge } = await setup();
    repoState.openRepositoryPath.mockResolvedValue(null);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    ipcBridge.emitDeepLink({ kind: 'open-path', path: '/nope' });
    await vi.waitFor(() => expect(repoState.openRepositoryPath).toHaveBeenCalledWith('/nope'));

    expect(workspaces.openTab).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the target repo and focuses the commit from a deep link', async () => {
    const repo = makeRepository(1);
    const { workspaces, commitFocus, ipcBridge } = await setup({ repos: [repo] });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    ipcBridge.emitDeepLink({ kind: 'open-commit', repo: repo.name, oid: 'abc123' });
    await vi.waitFor(() => expect(commitFocus.request).toHaveBeenCalledWith(repo.id, 'abc123'));

    expect(workspaces.openTab).toHaveBeenCalledWith(repo);
    expect(workspaces.selectTab).toHaveBeenCalledWith(repo.id);
    expect(navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('ignores a commit deep link for an unknown repository', async () => {
    const { workspaces, commitFocus, ipcBridge } = await setup({ repos: [] });

    ipcBridge.emitDeepLink({ kind: 'open-commit', repo: 'ghost', oid: 'abc' });
    await Promise.resolve();

    expect(workspaces.openTab).not.toHaveBeenCalled();
    expect(commitFocus.request).not.toHaveBeenCalled();
  });

  it('waits for repositories to load before routing a repo-token deep link', async () => {
    const repo = makeRepository(1);
    const { repoState, workspaces, commitFocus, ipcBridge } = await setup({ repos: [] });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    // Hold the repos-loaded signal so the queued link must wait for it.
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    repoState.whenRepositoriesLoaded.mockReturnValueOnce(loaded);

    ipcBridge.emitDeepLink({ kind: 'open-commit', repo: repo.name, oid: 'abc123' });
    await Promise.resolve();
    await Promise.resolve();

    // Not routed yet: the token cannot resolve against the still-empty list.
    expect(workspaces.openTab).not.toHaveBeenCalled();
    expect(commitFocus.request).not.toHaveBeenCalled();

    // The repository list arrives; the queued link is retried and routed.
    repoState.repos.set([repo]);
    release();
    await vi.waitFor(() => expect(commitFocus.request).toHaveBeenCalledWith(repo.id, 'abc123'));

    expect(workspaces.openTab).toHaveBeenCalledWith(repo);
    expect(navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('acks deep-link readiness once the listener is subscribed', async () => {
    const { ipcBridge } = await setup();

    expect(ipcBridge.signalDeepLinkReady).toHaveBeenCalledTimes(1);
  });

  it('routes a local branch deep link through the switch confirmation before checkout', async () => {
    const repo = makeRepository(1);
    const { fixture, repoState, workspaces, ipcBridge } = await setup({ repos: [repo] });
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    ipcBridge.emitDeepLink({ kind: 'open-branch', repo: repo.name, branch: 'feature/x' });
    await vi.waitFor(() => expect(fixture.componentInstance.checkoutPrompt()).not.toBeNull());
    fixture.detectChanges();

    // A link must not silently switch: it opens the same confirmation dialog as
    // an interactive branch click, before any checkout IPC.
    expect(query(fixture, 'switch-branch-message')?.textContent?.trim()).toBe(
      "Are you sure you want to switch your working copy to a branch 'feature/x'?",
    );
    expect(repoState.checkoutBranch).not.toHaveBeenCalled();

    query<HTMLButtonElement>(fixture, 'switch-branch-confirm')!.click();

    expect(repoState.checkoutBranch).toHaveBeenCalledWith('feature/x', false, false, false);
    expect(workspaces.openTab).toHaveBeenCalledWith(repo);
    expect(workspaces.selectTab).toHaveBeenCalledWith(repo.id);
    expect(repoState.loadRefs).toHaveBeenCalled();
  });

  it('routes a remote-tracking branch deep link through the switch confirmation', async () => {
    const repo = makeRepository(1);
    const { fixture, repoState, ipcBridge } = await setup({
      repos: [repo],
      remoteBranches: ['origin/topic'],
    });

    ipcBridge.emitDeepLink({ kind: 'open-branch', repo: repo.name, branch: 'origin/topic' });
    await vi.waitFor(() => expect(fixture.componentInstance.checkoutPrompt()).not.toBeNull());
    fixture.detectChanges();

    expect(repoState.checkoutBranch).not.toHaveBeenCalled();

    query<HTMLButtonElement>(fixture, 'switch-branch-confirm')!.click();

    expect(repoState.checkoutBranch).toHaveBeenCalledWith('origin/topic', true, false, false);
  });

  it('ignores a branch deep link for an unknown repository', async () => {
    const { repoState, ipcBridge } = await setup({ repos: [] });

    ipcBridge.emitDeepLink({ kind: 'open-branch', repo: 'ghost', branch: 'main' });
    await Promise.resolve();

    expect(repoState.checkoutBranch).not.toHaveBeenCalled();
  });

  it('opens the clone dialog prefilled from a clone deep link', async () => {
    const { fixture, ipcBridge } = await setup();

    ipcBridge.emitDeepLink({ kind: 'clone', url: 'https://example.com/me/app.git' });
    fixture.detectChanges();

    expect(query<HTMLInputElement>(fixture, 'clone-url')?.value).toBe(
      'https://example.com/me/app.git',
    );
  });

  it('ignores a clone deep link with a non-git URL', async () => {
    const { fixture, ipcBridge } = await setup();

    ipcBridge.emitDeepLink({ kind: 'clone', url: 'ftp://example.com/x' });
    fixture.detectChanges();

    expect(query(fixture, 'clone-url')).toBeNull();
  });

  it('ignores a malformed deep-link payload', async () => {
    const { fixture, ipcBridge, workspaces } = await setup();

    ipcBridge.emitDeepLink(undefined as unknown as DeepLinkPayload);
    ipcBridge.emitDeepLink({ kind: 'bogus' } as unknown as DeepLinkPayload);
    fixture.detectChanges();

    expect(workspaces.openTab).not.toHaveBeenCalled();
  });

  it('unsubscribes from the deep-link listener on destroy', async () => {
    const { fixture, ipcBridge } = await setup();

    fixture.destroy();

    expect(ipcBridge.unsubscribeDeepLink).toHaveBeenCalledTimes(1);
  });

  it('closes the clone dialog on cancel', async () => {
    const { fixture, ipcBridge } = await setup();

    ipcBridge.emitDeepLink({ kind: 'clone', url: 'https://example.com/me/app.git' });
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'clone-cancel')!.click();
    fixture.detectChanges();

    expect(query(fixture, 'clone-url')).toBeNull();
  });

  // -- clipboard clone (ADR-025) -------------------------------------------

  it('prefills the clone dialog from a git URL on the clipboard', async () => {
    stubClipboard('git@github.com:org/repo.git');
    const { fixture } = await setup();

    await fixture.componentInstance.onCloneFromClipboard();
    fixture.detectChanges();

    expect(query<HTMLInputElement>(fixture, 'clone-url')?.value).toBe(
      'git@github.com:org/repo.git',
    );
  });

  it('reports a non-git clipboard without a prefilled URL', async () => {
    stubClipboard('just some text');
    const { fixture } = await setup();

    await fixture.componentInstance.onCloneFromClipboard();
    fixture.detectChanges();

    expect(query<HTMLInputElement>(fixture, 'clone-url')?.value).toBe('');
    expect(query(fixture, 'clone-error')?.textContent).toContain('does not contain a Git URL');
  });

  it('copies the active repository remote URL to the clipboard', async () => {
    const repo = makeRepository(1);
    const { fixture, remoteOps } = await setup(
      { repos: [repo], activeId: repo.id },
      { remoteOptions: [{ name: 'origin', url: 'git@github.com:org/repo.git' }] },
    );
    const { writeText } = stubClipboard();

    await fixture.componentInstance.onCopyRepoUrl();

    expect(remoteOps.loadRefs).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('git@github.com:org/repo.git');
  });

  it('copies a repo deep link when the repository has no remote', async () => {
    const repo = makeRepository(1);
    const { fixture } = await setup({ repos: [repo], activeId: repo.id }, { remoteOptions: [] });
    const { writeText } = stubClipboard();

    await fixture.componentInstance.onCopyRepoUrl();

    expect(writeText).toHaveBeenCalledWith(
      `singularitree://open?path=${encodeURIComponent(repo.fsPath)}`,
    );
  });

  it('does not copy when no repository is active', async () => {
    const { fixture } = await setup({ activeId: null });
    const { writeText } = stubClipboard();

    await fixture.componentInstance.onCopyRepoUrl();

    expect(writeText).not.toHaveBeenCalled();
  });

  it('opens the clone dialog from the toolbar clipboard affordance', async () => {
    stubClipboard('https://example.com/me/app.git');
    const { fixture } = await setup();

    innerButton(fixture, 'top-bar-clone-clipboard')!.click();
    await vi.waitFor(() => expect(query(fixture, 'clone-url')).not.toBeNull());
  });

  it('copies the active repo URL from the toolbar', async () => {
    const repo = makeRepository(1);
    const { fixture } = await setup(
      { repos: [repo], activeId: repo.id },
      { remoteOptions: [{ name: 'origin', url: 'https://example.com/me/app.git' }] },
    );
    const { writeText } = stubClipboard();

    innerButton(fixture, 'top-bar-copy-repo-url')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.com/me/app.git'));
  });
});
