import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Repository } from '@contracts/domain';
import { IpcBridge, type AppError } from '@core/services/ipc-bridge.service';
import { RepoState } from '@core/services/repo-state.service';
import { RepoRelocatePanel, type RelocateReason } from './repo-relocate-panel';

const REPO: Repository = {
  id: 'repo-1',
  fsPath: '/tmp/repo',
  commonDir: '/tmp/repo/.git',
  name: 'repo',
  createdAt: '2026-01-01T00:00:00Z',
  lastOpenedAt: '2026-01-01T00:00:00Z',
};

const MOVED: Repository = { ...REPO, fsPath: '/tmp/moved' };

function makeRepoState(
  opts: {
    relocated?: Repository | null;
    remove?: boolean;
    relocateThrows?: AppError;
    removeThrows?: AppError;
  } = {},
) {
  const reposError = signal<AppError | null>(null);
  const relocateRepository = vi.fn(async (_id: string, _fsPath: string) => {
    if (opts.relocateThrows) {
      reposError.set(opts.relocateThrows);
      return null;
    }
    return opts.relocated ?? MOVED;
  });
  const removeRepository = vi.fn(async (_id: string) => {
    if (opts.removeThrows) {
      reposError.set(opts.removeThrows);
      return false;
    }
    return opts.remove ?? true;
  });
  return { reposError, relocateRepository, removeRepository };
}

function makeBridge(choose: { canceled: boolean; path: string } | 'throw' = { canceled: false, path: '/tmp/chosen' }) {
  const invoke = vi.fn(async (method: string) => {
    if (method === 'chooseDirectory') {
      if (choose === 'throw') throw { code: 'DIALOG_FAILED', message: 'boom' } as AppError;
      return choose;
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { invoke } as unknown as IpcBridge & { invoke: Mock };
}

async function setup(
  opts: {
    reason?: RelocateReason;
    busy?: boolean;
    repoState?: ReturnType<typeof makeRepoState>;
    bridge?: ReturnType<typeof makeBridge>;
  } = {},
) {
  const repoState = opts.repoState ?? makeRepoState();
  const bridge = opts.bridge ?? makeBridge();
  await TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: RepoState, useValue: repoState },
      { provide: IpcBridge, useValue: bridge },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(RepoRelocatePanel);
  fixture.componentRef.setInput('repo', REPO);
  fixture.componentRef.setInput('reason', opts.reason ?? 'missing');
  if (opts.busy !== undefined) fixture.componentRef.setInput('busy', opts.busy);
  fixture.detectChanges();
  return { fixture, repoState, bridge };
}

function query(fixture: ComponentFixture<RepoRelocatePanel>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function innerButton(fixture: ComponentFixture<RepoRelocatePanel>, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

describe('RepoRelocatePanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the repository name and recorded path', async () => {
    const { fixture } = await setup();
    expect(query(fixture, 'relocate-name')?.textContent?.trim()).toBe('repo');
    expect(query(fixture, 'relocate-path')?.textContent?.trim()).toBe('/tmp/repo');
  });

  it('names the missing state distinctly', async () => {
    const { fixture } = await setup({ reason: 'missing' });
    expect(query(fixture, 'relocate-reason')?.textContent).toContain('could not be found');
  });

  it('names the not-a-repo state distinctly', async () => {
    const { fixture } = await setup({ reason: 'not-a-repo' });
    expect(query(fixture, 'relocate-reason')?.textContent).toContain('is not a Git repository');
  });

  it('reveals a prefilled input when Edit path is clicked', async () => {
    const { fixture } = await setup();
    expect(query(fixture, 'relocate-path-input')).toBeNull();

    query(fixture, 'relocate-edit')!.click();
    fixture.detectChanges();

    const input = query(fixture, 'relocate-path-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('/tmp/repo');
  });

  it('cancels the edit without calling the store', async () => {
    const { fixture, repoState } = await setup();
    query(fixture, 'relocate-edit')!.click();
    fixture.detectChanges();

    query(fixture, 'relocate-cancel')!.click();
    fixture.detectChanges();

    expect(query(fixture, 'relocate-path-input')).toBeNull();
    expect(repoState.relocateRepository).not.toHaveBeenCalled();
  });

  it('saves the edited path, emits relocated and calls the shared store once', async () => {
    const { fixture, repoState } = await setup();
    const emitted: Repository[] = [];
    fixture.componentInstance.relocated.subscribe((repo) => emitted.push(repo));

    query(fixture, 'relocate-edit')!.click();
    fixture.detectChanges();
    const input = query(fixture, 'relocate-path-input') as HTMLInputElement;
    input.value = '  /tmp/moved  ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    query(fixture, 'relocate-save')!.click();
    await vi.waitFor(() => expect(emitted).toEqual([MOVED]));

    expect(repoState.relocateRepository).toHaveBeenCalledWith('repo-1', '/tmp/moved');
  });

  it('keeps Save disabled for a blank draft', async () => {
    const { fixture } = await setup();
    query(fixture, 'relocate-edit')!.click();
    fixture.detectChanges();

    const input = query(fixture, 'relocate-path-input') as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(innerButton(fixture, 'relocate-save').disabled).toBe(true);
  });

  it('adopts the folder chosen by Browse', async () => {
    const { fixture, repoState, bridge } = await setup();
    const emitted: Repository[] = [];
    fixture.componentInstance.relocated.subscribe((repo) => emitted.push(repo));

    query(fixture, 'relocate-browse')!.click();
    await vi.waitFor(() => expect(emitted).toEqual([MOVED]));

    expect(bridge.invoke).toHaveBeenCalledWith('chooseDirectory', {});
    expect(repoState.relocateRepository).toHaveBeenCalledWith('repo-1', '/tmp/chosen');
  });

  it('ignores a cancelled folder chooser', async () => {
    const { fixture, repoState } = await setup({
      bridge: makeBridge({ canceled: true, path: '' }),
    });

    query(fixture, 'relocate-browse')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(repoState.relocateRepository).not.toHaveBeenCalled();
    expect(query(fixture, 'relocate-error')).toBeNull();
  });

  it('removes the repository only after the confirmation is accepted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fixture, repoState } = await setup();
    const removed = vi.fn();
    fixture.componentInstance.removed.subscribe(removed);

    query(fixture, 'relocate-remove')!.click();
    await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(1));

    expect(repoState.removeRepository).toHaveBeenCalledWith('repo-1');
  });

  it('does not remove the repository when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { fixture, repoState } = await setup();
    const removed = vi.fn();
    fixture.componentInstance.removed.subscribe(removed);

    query(fixture, 'relocate-remove')!.click();
    await Promise.resolve();

    expect(removed).not.toHaveBeenCalled();
    expect(repoState.removeRepository).not.toHaveBeenCalled();
  });

  it('surfaces the store error line when a relocate fails', async () => {
    const repoState = makeRepoState({
      relocateThrows: { code: 'REPO_PATH_IN_USE', message: 'already tracked', details: {} },
    });
    const { fixture } = await setup({ repoState });

    query(fixture, 'relocate-edit')!.click();
    fixture.detectChanges();
    query(fixture, 'relocate-save')!.click();

    await vi.waitFor(() =>
      expect(query(fixture, 'relocate-error')?.textContent).toContain('already tracked'),
    );
  });

  it('surfaces a native chooser failure on the error line', async () => {
    const { fixture } = await setup({ bridge: makeBridge('throw') });
    const relocated = vi.fn();
    fixture.componentInstance.relocated.subscribe(relocated);

    query(fixture, 'relocate-browse')!.click();
    await vi.waitFor(() =>
      expect(query(fixture, 'relocate-error')?.textContent).toContain('boom'),
    );

    expect(relocated).not.toHaveBeenCalled();
  });

  it('keeps the registration and shows the error when removal fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const repoState = makeRepoState({
      removeThrows: { code: 'REMOVE_FAILED', message: 'could not remove', details: {} },
    });
    const { fixture } = await setup({ repoState });
    const removed = vi.fn();
    fixture.componentInstance.removed.subscribe(removed);

    query(fixture, 'relocate-remove')!.click();
    await vi.waitFor(() =>
      expect(query(fixture, 'relocate-error')?.textContent).toContain('could not remove'),
    );

    expect(removed).not.toHaveBeenCalled();
    // The registration survives: the panel still renders the repository.
    expect(query(fixture, 'relocate-name')?.textContent?.trim()).toBe('repo');
  });

  it('disables every control while busy', async () => {
    const { fixture } = await setup({ busy: true });

    expect(innerButton(fixture, 'relocate-edit').disabled).toBe(true);
    expect(innerButton(fixture, 'relocate-browse').disabled).toBe(true);
    expect(innerButton(fixture, 'relocate-remove').disabled).toBe(true);
  });
});
