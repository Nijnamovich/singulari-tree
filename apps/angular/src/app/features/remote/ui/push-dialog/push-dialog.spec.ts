import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type PushIntent,
  type PushRowView,
  type RemoteBranchOption,
  type RemoteOption,
} from '../../remote-models';
import { PushDialog } from './push-dialog';

const REMOTES: RemoteOption[] = [
  { name: 'origin', url: 'git@example.com:org/repo.git' },
  { name: 'upstream', url: 'https://example.com/up/repo.git' },
];

const ROWS: PushRowView[] = [
  { localBranch: 'main', isCurrent: true, upstream: 'refs/remotes/origin/main', defaultRemoteBranch: 'main' },
  { localBranch: 'feature', isCurrent: false, upstream: '', defaultRemoteBranch: 'feature' },
];

const REMOTE_BRANCHES: Record<string, RemoteBranchOption[]> = {
  origin: [{ name: 'develop', refName: 'refs/remotes/origin/develop', derivedFromUpstream: true }],
};

interface SetupOptions {
  open?: boolean;
  repoName?: string;
  remotes?: RemoteOption[];
  rows?: PushRowView[];
  remoteBranchesByRemote?: Record<string, RemoteBranchOption[]>;
  loading?: boolean;
  running?: boolean;
  offline?: boolean;
}

async function setup(opts: SetupOptions = {}): Promise<ComponentFixture<PushDialog>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(PushDialog);
  const ref = fixture.componentRef;
  ref.setInput('open', opts.open ?? true);
  ref.setInput('repoName', opts.repoName ?? '');
  ref.setInput('remotes', opts.remotes ?? REMOTES);
  ref.setInput('rows', opts.rows ?? ROWS);
  ref.setInput('remoteBranchesByRemote', opts.remoteBranchesByRemote ?? REMOTE_BRANCHES);
  ref.setInput('loading', opts.loading ?? false);
  ref.setInput('running', opts.running ?? false);
  ref.setInput('progress', null);
  ref.setInput('error', null);
  ref.setInput('offline', opts.offline ?? false);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

function query<T extends Element>(fixture: ComponentFixture<PushDialog>, testId: string): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

function queryAll<T extends Element>(
  fixture: ComponentFixture<PushDialog>,
  testId: string,
): T[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<T>(`[data-testid="${testId}"]`),
  );
}

function setChecked(el: HTMLInputElement, checked: boolean, fixture: ComponentFixture<PushDialog>): void {
  el.checked = checked;
  el.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

describe('PushDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing while closed and shows the repo name in the title when open', async () => {
    const fixture = await setup({ open: false, repoName: 'my-repo' });
    expect(query(fixture, 'push-dialog')).toBeNull();

    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(query(fixture, 'push-dialog')).not.toBeNull();
    const title = query(fixture, 'modal-title')?.textContent ?? '';
    expect(title).toContain('Push');
    expect(title).toContain('my-repo');
  });

  it('renders one row per input row and shows the local branch', async () => {
    const fixture = await setup();

    expect(queryAll(fixture, 'push-row')).toHaveLength(2);
    expect(queryAll(fixture, 'push-row-local').map((el) => el.textContent?.trim())).toEqual([
      'main',
      'feature',
    ]);
  });

  it('checks and clears every row from the select-all control', async () => {
    const fixture = await setup();
    const selectAll = query<HTMLInputElement>(fixture, 'push-select-all')!;

    setChecked(selectAll, true, fixture);
    expect(queryAll<HTMLInputElement>(fixture, 'push-row-checkbox').every((el) => el.checked)).toBe(
      true,
    );

    setChecked(selectAll, false, fixture);
    expect(
      queryAll<HTMLInputElement>(fixture, 'push-row-checkbox').every((el) => !el.checked),
    ).toBe(true);
  });

  it('submits only the checked rows with their selected remote target', async () => {
    const fixture = await setup();
    const emitted: PushIntent[] = [];
    fixture.componentInstance.submitted.subscribe((intent) => emitted.push(intent));

    const checkboxes = queryAll<HTMLInputElement>(fixture, 'push-row-checkbox');
    setChecked(checkboxes[0], true, fixture);

    query<HTMLButtonElement>(fixture, 'push-submit')!.click();

    expect(emitted).toEqual([
      {
        remote: 'origin',
        branches: [{ localBranch: 'main', remoteBranch: 'main', track: false }],
        tags: false,
        force: false,
      },
    ]);
  });

  it('renders the remote-branch, track, tags and force controls enabled', async () => {
    const fixture = await setup();

    const remote = query<HTMLSelectElement>(fixture, 'push-row-remote-select')!;
    expect(remote.disabled).toBe(false);
    expect(remote.hasAttribute('aria-disabled')).toBe(false);
    expect(remote.value).toBe('main');
    expect(query(fixture, 'push-row-remote-deferred')).toBeNull();

    const track = query<HTMLInputElement>(fixture, 'push-row-track')!;
    expect(track.disabled).toBe(false);
    expect(track.hasAttribute('aria-disabled')).toBe(false);
    expect(track.checked).toBe(false);
    expect(query(fixture, 'push-row-track-deferred')).toBeNull();

    for (const id of ['push-option-tags', 'push-option-force']) {
      const checkbox = query<HTMLInputElement>(fixture, id)!;
      expect(checkbox.disabled).toBe(false);
      expect(checkbox.hasAttribute('aria-disabled')).toBe(false);
      expect(query(fixture, `${id}-deferred`)).toBeNull();
    }
  });

  it('forwards remote branch, track, tags and force through the intent', async () => {
    const fixture = await setup();
    const emitted: PushIntent[] = [];
    fixture.componentInstance.submitted.subscribe((intent) => emitted.push(intent));

    const checkbox = queryAll<HTMLInputElement>(fixture, 'push-row-checkbox')[0];
    setChecked(checkbox, true, fixture);

    const remote = query<HTMLSelectElement>(fixture, 'push-row-remote-select')!;
    remote.value = 'develop';
    remote.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const track = query<HTMLInputElement>(fixture, 'push-row-track')!;
    setChecked(track, true, fixture);

    setChecked(query<HTMLInputElement>(fixture, 'push-option-tags')!, true, fixture);
    setChecked(query<HTMLInputElement>(fixture, 'push-option-force')!, true, fixture);

    query<HTMLButtonElement>(fixture, 'push-submit')!.click();

    expect(emitted).toEqual([
      {
        remote: 'origin',
        branches: [{ localBranch: 'main', remoteBranch: 'develop', track: true }],
        tags: true,
        force: true,
      },
    ]);
  });

  it('emits closed when cancel is clicked', async () => {
    const fixture = await setup();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);

    query<HTMLButtonElement>(fixture, 'push-cancel')!.click();

    expect(closed).toBe(1);
  });
});
