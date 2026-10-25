import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Stash } from '@contracts/domain';
import type { AppError } from '@core/services/ipc-bridge.service';
import { NavRail } from './nav-rail';

interface SetupOptions {
  collapsed?: boolean;
  repoName?: string;
  repoPath?: string;
  branches?: string[];
  currentBranch?: string;
  currentBranchBehind?: number;
  lensRef?: string;
  lensKind?: '' | 'local' | 'remote';
  remoteBranches?: string[];
  tags?: string[];
  remotes?: string[];
  stashes?: Stash[];
  stashesLoading?: boolean;
  stashesError?: AppError | null;
  stashOpRunning?: boolean;
  loading?: boolean;
  offline?: boolean;
  error?: AppError | null;
  activeWorkspace?: string;
  changeCount?: number;
}

function stash(index: number, message = `WIP ${index}`, branchName = 'main'): Stash {
  return { index, oid: undefined, message, branchName };
}

async function setup(opts: SetupOptions = {}): Promise<ComponentFixture<NavRail>> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(NavRail);
  const ref = fixture.componentRef;
  ref.setInput('collapsed', opts.collapsed ?? false);
  ref.setInput('repoName', opts.repoName ?? '');
  ref.setInput('repoPath', opts.repoPath ?? '');
  ref.setInput('branches', opts.branches ?? []);
  ref.setInput('currentBranch', opts.currentBranch ?? '');
  ref.setInput('currentBranchBehind', opts.currentBranchBehind ?? 0);
  ref.setInput('lensRef', opts.lensRef ?? '');
  ref.setInput('lensKind', opts.lensKind ?? '');
  ref.setInput('remoteBranches', opts.remoteBranches ?? []);
  ref.setInput('tags', opts.tags ?? []);
  ref.setInput('remotes', opts.remotes ?? []);
  ref.setInput('stashes', opts.stashes ?? []);
  ref.setInput('stashesLoading', opts.stashesLoading ?? false);
  ref.setInput('stashesError', opts.stashesError ?? null);
  ref.setInput('stashOpRunning', opts.stashOpRunning ?? false);
  ref.setInput('loading', opts.loading ?? false);
  ref.setInput('offline', opts.offline ?? false);
  ref.setInput('error', opts.error ?? null);
  ref.setInput('activeWorkspace', opts.activeWorkspace ?? 'history');
  ref.setInput('changeCount', opts.changeCount ?? 0);
  fixture.detectChanges();
  return fixture;
}

function all(fixture: ComponentFixture<NavRail>, testId: string): Element[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll(`[data-testid="${testId}"]`),
  );
}

function head(fixture: ComponentFixture<NavRail>, label: string): HTMLButtonElement {
  const el = fixture.nativeElement as HTMLElement;
  const found = Array.from(el.querySelectorAll<HTMLButtonElement>('.st-rail__head')).find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`rail head '${label}' not found`);
  return found;
}

function expandTags(fixture: ComponentFixture<NavRail>): void {
  head(fixture, 'Tags').click();
  fixture.detectChanges();
}

function expandStashes(fixture: ComponentFixture<NavRail>): void {
  head(fixture, 'Stashes').click();
  fixture.detectChanges();
}

describe('NavRail', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the active-repo header when supplied', async () => {
    const fixture = await setup({
      repoName: 'alpha',
      repoPath: '/tmp/alpha',
      currentBranch: 'main',
    });
    const header = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="st-rail-repo-header"]',
    );

    expect(header).not.toBeNull();
    expect(header!.textContent).toContain('alpha');
    expect(header!.textContent).toContain('main');
    expect(header!.textContent).toContain('/tmp/alpha');
  });

  it('hides the repo header without a repository', async () => {
    const fixture = await setup();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="st-rail-repo-header"]'),
    ).toBeNull();
  });

  it('renders the group headers', async () => {
    const fixture = await setup();

    expect(head(fixture, 'Workspace')).not.toBeNull();
    expect(head(fixture, 'Local branches')).not.toBeNull();
    expect(head(fixture, 'Remote references')).not.toBeNull();
    expect(head(fixture, 'Tags')).not.toBeNull();
    expect(head(fixture, 'Stashes')).not.toBeNull();
    expect(all(fixture, 'st-sidebar-git-flow')).toHaveLength(1);
  });

  it('exposes aria-expanded on every section head, reflecting its state', async () => {
    const fixture = await setup();

    // Workspace / Local branches / Remote references start expanded; Tags and
    // Stashes start collapsed.
    expect(head(fixture, 'Workspace').getAttribute('aria-expanded')).toBe('true');
    expect(head(fixture, 'Local branches').getAttribute('aria-expanded')).toBe('true');
    expect(head(fixture, 'Remote references').getAttribute('aria-expanded')).toBe('true');
    expect(head(fixture, 'Tags').getAttribute('aria-expanded')).toBe('false');
    expect(head(fixture, 'Stashes').getAttribute('aria-expanded')).toBe('false');

    head(fixture, 'Tags').click();
    fixture.detectChanges();
    expect(head(fixture, 'Tags').getAttribute('aria-expanded')).toBe('true');

    head(fixture, 'Local branches').click();
    fixture.detectChanges();
    expect(head(fixture, 'Local branches').getAttribute('aria-expanded')).toBe('false');
  });

  it('exposes each WORKSPACE entry with a stable kind-scoped test id', async () => {
    const fixture = await setup();
    const el = fixture.nativeElement as HTMLElement;

    expect(all(fixture, 'st-sidebar-workspace-status')).toHaveLength(1);
    expect(all(fixture, 'st-sidebar-workspace-history')).toHaveLength(1);
    expect(all(fixture, 'st-sidebar-workspace-repos')).toHaveLength(1);
    // Exactly three workspace rows: status, history and repositories.
    expect(el.querySelectorAll('[data-testid^="st-sidebar-workspace-"]')).toHaveLength(3);
    expect(all(fixture, 'st-sidebar-workspace-status')[0].textContent).toContain('Commit analyzer');
    expect(all(fixture, 'st-sidebar-workspace-history')[0].textContent).toContain('History');
  });

  it('marks the active workspace item', async () => {
    const fixture = await setup({ activeWorkspace: 'repos' });

    const item = all(fixture, 'st-sidebar-workspace-repos')[0] as HTMLElement;
    expect(item.classList.contains('st-rail__item--active')).toBe(true);
    expect(
      (all(fixture, 'st-sidebar-workspace-history')[0] as HTMLElement).classList.contains(
        'st-rail__item--active',
      ),
    ).toBe(false);
  });

  it('emits the workspace kind when a WORKSPACE entry is clicked', async () => {
    const fixture = await setup();
    const emitted: string[] = [];
    fixture.componentInstance.workspaceSelected.subscribe((kind) => emitted.push(kind));

    (all(fixture, 'st-sidebar-workspace-history')[0] as HTMLElement).click();
    (all(fixture, 'st-sidebar-workspace-status')[0] as HTMLElement).click();

    expect(emitted).toEqual(['history', 'status']);
  });

  it('exposes the Repositories WORKSPACE entry exactly once', async () => {
    const fixture = await setup();

    const entries = all(fixture, 'st-sidebar-workspace-repos');
    expect(entries).toHaveLength(1);
    expect(entries[0].textContent).toContain('Repositories');
  });

  it('emits the repos workspace kind when Repositories is clicked', async () => {
    const fixture = await setup();
    const emitted: string[] = [];
    fixture.componentInstance.workspaceSelected.subscribe((kind) => emitted.push(kind));

    (all(fixture, 'st-sidebar-workspace-repos')[0] as HTMLElement).click();

    expect(emitted).toEqual(['repos']);
  });

  it('shows the change-count pill on Commit analyzer only when there is a count', async () => {
    const hidden = await setup({ changeCount: 0 });
    expect(
      all(hidden, 'st-sidebar-workspace-status')[0].querySelector('[data-testid="nav-item-count"]'),
    ).toBeNull();

    const shown = await setup({ changeCount: 3 });
    expect(
      all(shown, 'st-sidebar-workspace-status')[0].querySelector('[data-testid="nav-item-count"]')
        ?.textContent,
    ).toContain('3');
  });

  it('renders populated branch/tag/remote lists', async () => {
    const fixture = await setup({ branches: ['main', 'feature/x'], tags: ['v1.0.0'], remotes: ['origin'] });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="st-sidebar-branches"]')?.textContent).toContain('main');
    expect(el.querySelector('[data-testid="st-sidebar-branches"]')?.textContent).toContain(
      'feature/x',
    );
    expect(el.querySelector('[data-testid="st-sidebar-remotes"]')?.textContent).toContain('origin');

    expandTags(fixture);
    expect(el.querySelector('[data-testid="st-sidebar-tags"]')?.textContent).toContain('v1.0.0');
  });

  it('colours the ref lists semantically via dedicated classes', async () => {
    const fixture = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
      remotes: ['origin'],
      remoteBranches: ['origin/main'],
      tags: ['v1.0.0'],
    });
    const el = fixture.nativeElement as HTMLElement;

    // Every local branch label reads violet; only the current one lifts to text.
    const branchLabels = el.querySelectorAll<HTMLElement>('.st-rail__row-label--branch');
    expect(branchLabels).toHaveLength(2);
    const currentLabel = el.querySelector<HTMLElement>('.st-rail__row-label--current');
    expect(currentLabel?.textContent?.trim()).toBe('main');

    // Remote reference rows carry their own class; so do tag rows.
    expect(el.querySelector('.st-rail__row--remote')).not.toBeNull();
    expandTags(fixture);
    expect(el.querySelector('.st-rail__row--tag')).not.toBeNull();
  });

  it('narrows the branch list with the filter input', async () => {
    const fixture = await setup({ branches: ['main', 'feature/x', 'release/1.0'] });

    const rowsBefore = all(fixture, 'st-sidebar-branch');
    expect(rowsBefore).toHaveLength(3);

    const filterInput = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLInputElement>('[data-testid="st-rail-branch-filter"] input')!;
    filterInput.value = 'feat';
    filterInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const rows = all(fixture, 'st-sidebar-branch');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('feature/x');
  });

  it('badges the current branch row with the pull-pending count when behind', async () => {
    const fixture = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
      currentBranchBehind: 3,
    });
    const el = fixture.nativeElement as HTMLElement;

    const badges = el.querySelectorAll('[data-testid="st-sidebar-branch-badge"]');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent?.trim()).toBe('3');
    // The selection bar marks the current branch row.
    const currentRow = all(fixture, 'st-sidebar-branch')[0] as HTMLElement;
    expect(currentRow.classList.contains('st-selection-bar')).toBe(true);
  });

  it('renders the empty state when there are no refs', async () => {
    const fixture = await setup();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="st-sidebar-branches-empty"]')?.textContent).toContain(
      'No branches',
    );
    expect(el.querySelector('[data-testid="st-sidebar-remotes-empty"]')?.textContent).toContain(
      'No remotes',
    );

    expandTags(fixture);
    expect(el.querySelector('[data-testid="st-sidebar-tags-empty"]')?.textContent).toContain(
      'No tags',
    );
  });

  it('renders a loading state for every expanded section', async () => {
    const fixture = await setup({ loading: true });

    expect(all(fixture, 'st-sidebar-refs-loading')).toHaveLength(2);

    expandTags(fixture);
    expect(all(fixture, 'st-sidebar-refs-loading')).toHaveLength(3);
  });

  it('renders an offline state for every expanded section', async () => {
    const fixture = await setup({ offline: true });

    expect(all(fixture, 'st-sidebar-refs-offline')).toHaveLength(2);

    expandTags(fixture);
    expect(all(fixture, 'st-sidebar-refs-offline')).toHaveLength(3);
  });

  it('surfaces an error message for every expanded section', async () => {
    const fixture = await setup({ error: { code: 'EPERM', message: 'boom' } });

    expect(all(fixture, 'st-sidebar-refs-error')).toHaveLength(2);
    expect(all(fixture, 'st-sidebar-refs-error')[0].textContent).toContain('boom');

    expandTags(fixture);
    expect(all(fixture, 'st-sidebar-refs-error')).toHaveLength(3);
  });

  it('emits branchSelected when a local branch row is double-clicked', async () => {
    const fixture = await setup({ branches: ['main', 'feature/x'] });
    const emitted: string[] = [];
    fixture.componentInstance.branchSelected.subscribe((name) => emitted.push(name));

    const rows = all(fixture, 'st-sidebar-branch') as HTMLElement[];
    expect(rows).toHaveLength(2);
    rows[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(emitted).toEqual(['feature/x']);
  });

  it('toggles the lens, not checkout, with Enter and Space on a local branch row', async () => {
    const fixture = await setup({ branches: ['main'] });
    const lensed: { ref: string; kind: string }[] = [];
    const checkedOut: string[] = [];
    fixture.componentInstance.lensToggled.subscribe((value) => lensed.push(value));
    fixture.componentInstance.branchSelected.subscribe((name) => checkedOut.push(name));

    const row = all(fixture, 'st-sidebar-branch')[0] as HTMLElement;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

    // ADR-0042: keyboard activation toggles the view-only lens; checkout stays
    // on double-click (and the row menu).
    expect(lensed).toEqual([
      { ref: 'main', kind: 'local' },
      { ref: 'main', kind: 'local' },
    ]);
    expect(checkedOut).toEqual([]);
  });

  it('emits lensToggled on a single click on a local branch row', async () => {
    const fixture = await setup({ branches: ['main', 'feature/x'] });
    const emitted: { ref: string; kind: string }[] = [];
    fixture.componentInstance.lensToggled.subscribe((value) => emitted.push(value));

    (all(fixture, 'st-sidebar-branch')[1] as HTMLElement).click();

    expect(emitted).toEqual([{ ref: 'feature/x', kind: 'local' }]);
  });

  it('reflects the controlled lens with aria-pressed and the lens row class', async () => {
    const fixture = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
      lensRef: 'feature/x',
      lensKind: 'local',
    });
    const rows = all(fixture, 'st-sidebar-branch') as HTMLElement[];

    expect(rows[1].getAttribute('aria-pressed')).toBe('true');
    expect(rows[1].classList.contains('st-rail__row--lens')).toBe(true);
    expect(rows[0].getAttribute('aria-pressed')).toBe('false');
    expect(rows[0].classList.contains('st-rail__row--lens')).toBe(false);
  });

  it('keeps the current-branch selection bar exclusive and never lends it the lens class', async () => {
    const fixture = await setup({
      branches: ['main', 'feature/x'],
      currentBranch: 'main',
      lensRef: 'feature/x',
      lensKind: 'local',
    });
    const rows = all(fixture, 'st-sidebar-branch') as HTMLElement[];

    expect(rows[0].classList.contains('st-selection-bar')).toBe(true);
    expect(rows[0].classList.contains('st-rail__row--lens')).toBe(false);
    expect(rows[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles the lens from a remote row on single click and keyboard', async () => {
    const fixture = await setup({
      remotes: ['origin'],
      remoteBranches: ['origin/main'],
      lensKind: 'remote',
      lensRef: 'origin/main',
    });
    const emitted: { ref: string; kind: string }[] = [];
    const checkedOut: string[] = [];
    fixture.componentInstance.lensToggled.subscribe((value) => emitted.push(value));
    fixture.componentInstance.remoteBranchSelected.subscribe((name) => checkedOut.push(name));

    const row = all(fixture, 'st-sidebar-remote-branches')[0] as HTMLElement;
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.classList.contains('st-rail__row--lens')).toBe(true);

    row.click();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(emitted).toEqual([
      { ref: 'origin/main', kind: 'remote' },
      { ref: 'origin/main', kind: 'remote' },
    ]);
    expect(checkedOut).toEqual([]);
  });

  it('renders remote branches under their remote, stripping the prefix', async () => {
    const fixture = await setup({
      remotes: ['origin', 'upstream'],
      remoteBranches: ['origin/main', 'origin/david/topic', 'upstream/develop'],
    });
    const el = fixture.nativeElement as HTMLElement;

    const remotesText = el.querySelector('[data-testid="st-sidebar-remotes"]')?.textContent ?? '';
    expect(remotesText).toContain('origin');
    expect(remotesText).toContain('upstream');

    const items = Array.from(
      el.querySelectorAll('[data-testid="st-sidebar-remote-branches"]'),
    ).map((li) => li.textContent?.trim());
    expect(items).toEqual(['main', 'david/topic', 'develop']);
  });

  it('emits remoteBranchSelected with the reconstructed remote/branch name', async () => {
    const fixture = await setup({
      remotes: ['origin', 'upstream'],
      remoteBranches: ['origin/main', 'origin/david/topic', 'upstream/develop'],
    });
    const emitted: string[] = [];
    fixture.componentInstance.remoteBranchSelected.subscribe((name) => emitted.push(name));

    const rows = all(fixture, 'st-sidebar-remote-branches') as HTMLElement[];
    rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    rows[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(emitted).toEqual(['origin/main', 'upstream/develop']);
  });

  it('emits newBranchRequested and newTagRequested from the header "+" buttons', async () => {
    const fixture = await setup({ branches: ['main'], tags: ['v1'] });
    let newBranch = 0;
    let newTag = 0;
    fixture.componentInstance.newBranchRequested.subscribe(() => (newBranch += 1));
    fixture.componentInstance.newTagRequested.subscribe(() => (newTag += 1));

    (all(fixture, 'st-sidebar-add-branch')[0] as HTMLElement).click();
    (all(fixture, 'st-sidebar-add-tag')[0] as HTMLElement).click();

    expect(newBranch).toBe(1);
    expect(newTag).toBe(1);
  });

  it('opens a branch row menu and emits the chosen action', async () => {
    const fixture = await setup({ branches: ['main', 'feature/x'] });
    const el = fixture.nativeElement as HTMLElement;
    const checkout: string[] = [];
    const rename: string[] = [];
    const merge: string[] = [];
    const del: string[] = [];
    fixture.componentInstance.branchSelected.subscribe((v) => checkout.push(v));
    fixture.componentInstance.branchRenameRequested.subscribe((v) => rename.push(v));
    fixture.componentInstance.branchMergeRequested.subscribe((v) => merge.push(v));
    fixture.componentInstance.branchDeleteRequested.subscribe((v) => del.push(v));

    const rows = all(fixture, 'st-sidebar-branch') as HTMLElement[];
    rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="st-sidebar-row-menu"]')).not.toBeNull();

    (el.querySelector('[data-testid="st-sidebar-menu-checkout"]') as HTMLElement).click();
    expect(checkout).toEqual(['feature/x']);

    rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (el.querySelector('[data-testid="st-sidebar-menu-rename"]') as HTMLElement).click();
    expect(rename).toEqual(['feature/x']);

    rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (el.querySelector('[data-testid="st-sidebar-menu-merge"]') as HTMLElement).click();
    expect(merge).toEqual(['feature/x']);

    rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    (el.querySelector('[data-testid="st-sidebar-menu-delete"]') as HTMLElement).click();
    expect(del).toEqual(['feature/x']);
  });

  it('disables delete for the current branch with an explanatory title', async () => {
    const fixture = await setup({ branches: ['main', 'feature/x'], currentBranch: 'main' });
    const el = fixture.nativeElement as HTMLElement;
    const del: string[] = [];
    fixture.componentInstance.branchDeleteRequested.subscribe((v) => del.push(v));

    const rows = all(fixture, 'st-sidebar-branch') as HTMLElement[];
    rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    const button = el.querySelector('[data-testid="st-sidebar-menu-delete"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('Cannot delete the current branch');

    button.click();
    fixture.detectChanges();
    expect(del).toEqual([]);
  });

  it('opens a tag row menu that only offers deletion', async () => {
    const fixture = await setup({ tags: ['v1.0.0'] });
    const el = fixture.nativeElement as HTMLElement;
    const del: string[] = [];
    fixture.componentInstance.tagDeleteRequested.subscribe((v) => del.push(v));
    expandTags(fixture);

    const tag = all(fixture, 'st-sidebar-tag')[0] as HTMLElement;
    tag.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="st-sidebar-menu-checkout"]')).toBeNull();
    expect(el.querySelector('[data-testid="st-sidebar-menu-rename"]')).toBeNull();
    expect(el.querySelector('[data-testid="st-sidebar-menu-delete"]')).not.toBeNull();

    (el.querySelector('[data-testid="st-sidebar-menu-delete"]') as HTMLElement).click();
    expect(del).toEqual(['v1.0.0']);
  });

  it('closes the row menu on a backdrop click', async () => {
    const fixture = await setup({ branches: ['main'] });
    const el = fixture.nativeElement as HTMLElement;
    const row = all(fixture, 'st-sidebar-branch')[0] as HTMLElement;

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="st-sidebar-row-menu"]')).not.toBeNull();

    (el.querySelector('[data-testid="st-sidebar-menu-backdrop"]') as HTMLElement).click();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="st-sidebar-row-menu"]')).toBeNull();
  });

  // -- stashes -------------------------------------------------------------

  it('renders populated stash rows with label, branch and actions', async () => {
    const fixture = await setup({
      stashes: [stash(0, 'WIP on main', 'main'), stash(1, '', 'feature/x')],
    });
    expandStashes(fixture);
    const el = fixture.nativeElement as HTMLElement;

    const rows = all(fixture, 'st-sidebar-stash');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('WIP on main');
    expect(rows[1].textContent).toContain('stash@{1}');
    expect(el.querySelectorAll('[data-testid="st-sidebar-stash-apply"]')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="st-sidebar-stash-pop"]')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="st-sidebar-stash-drop"]')).toHaveLength(2);
  });

  it('renders the stash empty/loading/offline/error states', async () => {
    const empty = await setup();
    expandStashes(empty);
    expect(
      empty.nativeElement.querySelector('[data-testid="st-sidebar-stashes-empty"]')?.textContent,
    ).toContain('No stashes');

    const loading = await setup({ stashesLoading: true });
    expandStashes(loading);
    expect(
      loading.nativeElement.querySelector('[data-testid="st-sidebar-stashes-loading"]'),
    ).not.toBeNull();

    const offline = await setup({ offline: true });
    expandStashes(offline);
    expect(
      offline.nativeElement.querySelector('[data-testid="st-sidebar-stashes-offline"]'),
    ).not.toBeNull();

    const errored = await setup({ stashesError: { code: 'GIT_FAILED', message: 'boom' } });
    expandStashes(errored);
    expect(
      errored.nativeElement.querySelector('[data-testid="st-sidebar-stashes-error"]')?.textContent,
    ).toContain('boom');
  });

  it('emits the stash entry for apply, pop and drop', async () => {
    const fixture = await setup({ stashes: [stash(0, 'one'), stash(1, 'two')] });
    const applied: Stash[] = [];
    const popped: Stash[] = [];
    const dropped: Stash[] = [];
    fixture.componentInstance.stashApplyRequested.subscribe((v) => applied.push(v));
    fixture.componentInstance.stashPopRequested.subscribe((v) => popped.push(v));
    fixture.componentInstance.stashDropRequested.subscribe((v) => dropped.push(v));
    expandStashes(fixture);

    (all(fixture, 'st-sidebar-stash-apply')[1] as HTMLElement).click();
    (all(fixture, 'st-sidebar-stash-pop')[0] as HTMLElement).click();
    (all(fixture, 'st-sidebar-stash-drop')[1] as HTMLElement).click();

    expect(applied.map((s) => s.index)).toEqual([1]);
    expect(popped.map((s) => s.index)).toEqual([0]);
    expect(dropped.map((s) => s.index)).toEqual([1]);
  });

  it('disables the stash actions while a stash op is running', async () => {
    const fixture = await setup({ stashes: [stash(0)], stashOpRunning: true });
    expandStashes(fixture);

    for (const testId of [
      'st-sidebar-stash-apply',
      'st-sidebar-stash-pop',
      'st-sidebar-stash-drop',
    ]) {
      expect((all(fixture, testId)[0] as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('emits gitFlowRequested from the Git Flow header', async () => {
    const fixture = await setup();
    let requested = 0;
    fixture.componentInstance.gitFlowRequested.subscribe(() => (requested += 1));

    (all(fixture, 'st-sidebar-git-flow')[0] as HTMLElement).click();

    expect(requested).toBe(1);
  });

  it('emits collapseToggle and renders a collapsed rail with just the expand control', async () => {
    const expanded = await setup({ collapsed: false });
    let expandedToggles = 0;
    expanded.componentInstance.collapseToggle.subscribe(() => (expandedToggles += 1));
    (
      expanded.nativeElement as HTMLElement
    ).querySelector<HTMLButtonElement>('.st-rail__collapse')!.click();
    expect(expandedToggles).toBe(1);

    const collapsed = await setup({ collapsed: true });
    const el = collapsed.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLElement>('.st-rail__list')).toBeNull();
    let collapsedToggles = 0;
    collapsed.componentInstance.collapseToggle.subscribe(() => (collapsedToggles += 1));
    el.querySelector<HTMLButtonElement>('.st-rail__collapse')!.click();
    expect(collapsedToggles).toBe(1);
  });
});
