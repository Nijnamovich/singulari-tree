import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Repository } from '@contracts/domain';
import { IpcBridge, type AppError } from '@core/services/ipc-bridge.service';
import { RepoState } from '@core/services/repo-state.service';
import { WorkspacesStore } from '@core/services/workspaces.store';
import { ReposPage } from './repos-page';

const REPO_A: Repository = {
  id: 'repo-a',
  fsPath: '/tmp/a',
  commonDir: '/tmp/a/.git',
  name: 'a',
  createdAt: '2026-01-01T00:00:00Z',
  lastOpenedAt: '2026-01-01T00:00:00Z',
};

const REPO_B: Repository = {
  ...REPO_A,
  id: 'repo-b',
  fsPath: '/tmp/b',
  name: 'b',
};

interface StubOptions {
  repos?: Repository[];
  reposLoading?: boolean;
  reposError?: AppError | null;
  reposOffline?: boolean;
  removingId?: string | null;
}

/**
 * Minimal `RepoState` stand-in exposing only the members the page reads plus
 * spies for its intents, so the component can be exercised without the bridge.
 */
function makeRepoState(opts: StubOptions = {}) {
  return {
    repos: signal<Repository[]>(opts.repos ?? []),
    reposLoading: signal(opts.reposLoading ?? false),
    reposError: signal<AppError | null>(opts.reposError ?? null),
    reposOffline: signal(opts.reposOffline ?? false),
    removingId: signal<string | null>(opts.removingId ?? null),
    setActive: vi.fn(),
    removeRepository: vi.fn(async () => true),
    loadRepositories: vi.fn(async () => {}),
  };
}

/** Minimal `WorkspacesStore` stand-in exposing the tab-open intent. */
function makeWorkspaces() {
  return { openTab: vi.fn() } as unknown as WorkspacesStore & { openTab: Mock };
}

function makeBridge(): IpcBridge & { invoke: Mock } {
  const invoke = vi.fn(async (method: string) => {
    switch (method) {
      case 'openRepository':
        return REPO_A;
      default:
        throw new Error(`unexpected method ${method}`);
    }
  });
  return { invoke } as unknown as IpcBridge & { invoke: Mock };
}

function makeRouter(): Router & { navigate: Mock } {
  const navigate = vi.fn(async () => true);
  return { navigate } as unknown as Router & { navigate: Mock };
}

async function setup(opts: StubOptions = {}) {
  const repoState = makeRepoState(opts);
  const workspaces = makeWorkspaces();
  const bridge = makeBridge();
  const router = makeRouter();
  await TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: RepoState, useValue: repoState },
      { provide: WorkspacesStore, useValue: workspaces },
      { provide: IpcBridge, useValue: bridge },
      { provide: Router, useValue: router },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(ReposPage);
  fixture.detectChanges();
  await Promise.resolve();
  fixture.detectChanges();
  return { fixture, repoState, workspaces, bridge, router };
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
 * The `data-testid` now sits on the `st-button` host, so native button
 * properties (`disabled`) and clicks go through the inner `<button>` —
 * mirrors `innerButton()` in `repo-relocate-panel.spec.ts`.
 */
function innerButton(fixture: { nativeElement: unknown }, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

describe('ReposPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the persisted repository list on init', async () => {
    const { repoState } = await setup();

    expect(repoState.loadRepositories).toHaveBeenCalledTimes(1);
  });

  it('renders one row per repository in the given order', async () => {
    const { fixture } = await setup({ repos: [REPO_A, REPO_B] });

    const rows = queryAll(fixture, 'repos-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('a');
    expect(rows[1].textContent).toContain('b');
    expect(query(fixture, 'repos-empty')).toBeNull();
  });

  it('shows the empty state when there are no repositories', async () => {
    const { fixture } = await setup({ repos: [] });

    expect(query(fixture, 'repos-empty')).not.toBeNull();
    expect(queryAll(fixture, 'repos-row')).toHaveLength(0);
  });

  it('shows the loading state while the first list load is in flight', async () => {
    const { fixture } = await setup({ repos: [], reposLoading: true });

    expect(query(fixture, 'repos-loading')).not.toBeNull();
    expect(query(fixture, 'repos-empty')).toBeNull();
  });

  it('shows the offline state when the bridge is unavailable', async () => {
    const { fixture } = await setup({ repos: [], reposOffline: true });

    expect(query(fixture, 'repos-offline')?.textContent).toContain('Git core offline');
  });

  it('shows the list error state', async () => {
    const { fixture } = await setup({
      repos: [],
      reposError: { code: 'GIT_FAILED', message: 'boom' },
    });

    expect(query(fixture, 'repos-error')?.textContent).toContain('boom');
  });

  it('opens a repository, registers a tab and routes to the graph page', async () => {
    const { fixture, repoState, workspaces, router } = await setup({ repos: [REPO_A, REPO_B] });

    queryAll<HTMLButtonElement>(fixture, 'repos-open')[0].click();

    expect(workspaces.openTab).toHaveBeenCalledWith(REPO_A);
    expect(repoState.setActive).toHaveBeenCalledTimes(1);
    expect(repoState.setActive).toHaveBeenCalledWith(REPO_A);
    expect(router.navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('adds a repository by path, activates it and routes to the graph page', async () => {
    const { fixture, repoState, workspaces, bridge, router } = await setup({ repos: [] });

    const input = query<HTMLInputElement>(fixture, 'repos-add-input')!;
    input.value = '/tmp/a';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    innerButton(fixture, 'repos-add').click();

    await vi.waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith('openRepository', { fsPath: '/tmp/a' }),
    );
    await vi.waitFor(() => expect(repoState.setActive).toHaveBeenCalledWith(REPO_A));
    expect(workspaces.openTab).toHaveBeenCalledWith(REPO_A);
    expect(router.navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('ignores an empty add path', async () => {
    const { fixture, bridge, repoState } = await setup({ repos: [] });

    const input = query<HTMLInputElement>(fixture, 'repos-add-input')!;
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    innerButton(fixture, 'repos-add').click();
    await Promise.resolve();

    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(repoState.setActive).not.toHaveBeenCalled();
  });

  it('surfaces an add failure as an inline error and stays on the page', async () => {
    const { fixture, bridge, router } = await setup({ repos: [] });
    bridge.invoke.mockRejectedValue({ code: 'NOT_A_GIT_REPO', message: 'nope' });

    const input = query<HTMLInputElement>(fixture, 'repos-add-input')!;
    input.value = '/tmp/a';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    innerButton(fixture, 'repos-add').click();
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
    await Promise.resolve();
    fixture.detectChanges();

    expect(query(fixture, 'repos-error')?.textContent).toContain('nope');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('degrades to offline when add hits IPC_UNAVAILABLE', async () => {
    const { fixture, bridge } = await setup({ repos: [] });
    bridge.invoke.mockRejectedValue({ code: 'IPC_UNAVAILABLE', message: 'no bridge' });

    const input = query<HTMLInputElement>(fixture, 'repos-add-input')!;
    input.value = '/tmp/a';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    innerButton(fixture, 'repos-add').click();
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
    await Promise.resolve();
    fixture.detectChanges();

    expect(query(fixture, 'repos-offline')).not.toBeNull();
  });

  it('browses for a directory, populates the path and enables Add', async () => {
    const { fixture, bridge } = await setup({ repos: [] });
    bridge.invoke.mockResolvedValue({ canceled: false, path: '/tmp/picked' });

    const addBefore = innerButton(fixture, 'repos-add');
    expect(addBefore.disabled).toBe(true);

    innerButton(fixture, 'repos-browse').click();

    await vi.waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith('chooseDirectory', {}),
    );
    await vi.waitFor(() => expect(query<HTMLInputElement>(fixture, 'repos-add-input')!.value).toBe('/tmp/picked'));
    fixture.detectChanges();

    expect(innerButton(fixture, 'repos-add').disabled).toBe(false);
  });

  it('leaves the path unchanged when Browse is canceled', async () => {
    const { fixture, bridge } = await setup({ repos: [] });
    bridge.invoke.mockResolvedValue({ canceled: true, path: '' });

    innerButton(fixture, 'repos-browse').click();
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('chooseDirectory', {}));
    fixture.detectChanges();

    expect(query<HTMLInputElement>(fixture, 'repos-add-input')!.value).toBe('');
    expect(innerButton(fixture, 'repos-add').disabled).toBe(true);
  });

  it('degrades gracefully when Browse hits IPC_UNAVAILABLE', async () => {
    const { fixture, bridge } = await setup({ repos: [] });
    bridge.invoke.mockRejectedValue({ code: 'IPC_UNAVAILABLE', message: 'no bridge' });

    const browse = innerButton(fixture, 'repos-browse');
    browse.click();
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('chooseDirectory', {}));
    fixture.detectChanges();

    expect(query<HTMLInputElement>(fixture, 'repos-add-input')!.value).toBe('');
    expect(browse.disabled).toBe(false);
  });

  it('removes a repository through RepoState and stays on the page', async () => {
    const { fixture, repoState, router } = await setup({ repos: [REPO_A, REPO_B] });

    queryAll<HTMLButtonElement>(fixture, 'repos-remove')[0].click();

    await vi.waitFor(() => expect(repoState.removeRepository).toHaveBeenCalledWith(REPO_A.id));
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('disables the remove action for the repository being removed', async () => {
    const { fixture } = await setup({ repos: [REPO_A], removingId: REPO_A.id });

    expect(innerButton(fixture, 'repos-remove').disabled).toBe(true);
  });
});
