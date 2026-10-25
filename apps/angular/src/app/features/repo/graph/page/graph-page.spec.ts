import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { By } from '@angular/platform-browser';
import type { Commit, Diff } from '@contracts/domain';
import type { GetCommitsResponse } from '@contracts/gitcore';
import { BranchLensStore } from '@core/services/branch-lens.store';
import { IpcBridge } from '@core/services/ipc-bridge.service';
import { KeyboardShortcutService } from '@core/services/keyboard-shortcut.service';
import { RepoState } from '@core/services/repo-state.service';
import { LANE_COLUMN_WIDTH } from '@singularitree/ui-kit';
import { GraphStore, WIP_OID } from '../graph.store';
import type { CommitRow } from '../../repo-models';
import { GraphPage } from './graph-page';

const EMPTY_DIFF: Diff = {
  from: undefined,
  to: undefined,
  hunks: [],
  additions: 0,
  deletions: 0,
  isBinary: false,
  hasConflictMarkers: false,
  files: [],
  truncated: false,
};

// The virtual viewport itself is CDK's concern (and needs real layout, absent in
// jsdom). This spec drives the page's wiring — filter, WIP selection, prefetch
// threshold, lane width — through the component instance; DOM rendering of rows
// and panels is covered by their own component specs.

function makeCommit(index: number): Commit {
  return {
    oid: { hex: index.toString(16).padStart(40, '0'), kind: 'SHA1' },
    parents: [],
    author: { name: `Author ${index}`, email: `author${index}@example.com`, when: '2026-01-02T10:00:00Z' },
    committer: undefined,
    message: `commit ${index}`,
    treeOid: undefined,
    committedAt: '2026-01-02T10:05:00Z',
    refs: [],
  };
}

function makePage(count: number, total = count): GetCommitsResponse {
  return {
    commits: Array.from({ length: count }, (_, i) => makeCommit(i)),
    total,
    lanes: Array.from({ length: count }, (_, i) => ({
      index: i % 2,
      color: i % 8,
      continues: i % 2 === 0,
    })),
    inRefs: [],
  };
}

type ShortcutHandler = (event: KeyboardEvent) => void;

interface ShortcutStub {
  register: ReturnType<typeof vi.fn>;
}

function makeShortcuts(): ShortcutStub {
  return { register: vi.fn((_key: string, _handler: ShortcutHandler) => vi.fn()) };
}

async function setup(commits = 3, total = commits, router?: { navigate: ReturnType<typeof vi.fn> }) {
  const invoke = vi.fn((method: string) => {
    if (method === 'getCommits') return Promise.resolve(makePage(commits, total));
    if (method === 'getDiff') return Promise.resolve(EMPTY_DIFF);
    if (method === 'reset') return Promise.resolve({});
    if (method === 'getCommitStats') return Promise.resolve({ stats: [] });
    return Promise.resolve({});
  });
  const store = new GraphStore({ invoke } as unknown as IpcBridge);
  store.repoId.set('repo-1');
  await store.loadWindow(0);

  const shortcuts = makeShortcuts();
  const repoState = {
    checkoutBranch: vi.fn(async () => {}),
    clearRefOpError: vi.fn(),
    createBranch: vi.fn(async () => true),
    createTag: vi.fn(async () => true),
    openCherryPick: vi.fn(),
    revert: vi.fn(async () => true),
    // Read by the rendered template (the DOM-render test) — not by the
    // instance-only wiring tests.
    currentBranch: vi.fn(() => ''),
    refOpRunning: vi.fn(() => false),
    refOpError: vi.fn(() => null),
  };
  // Always provide a Router stub: the test env exposes a route-less real Router,
  // so WIP/toolbar navigation must never reach Angular's recognizer.
  const routerStub = router ?? { navigate: vi.fn(() => Promise.resolve(true)) };

  await TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: GraphStore, useValue: store },
      { provide: KeyboardShortcutService, useValue: shortcuts },
      { provide: RepoState, useValue: repoState },
      { provide: Router, useValue: routerStub },
    ],
  }).compileComponents();

  const page = TestBed.runInInjectionContext(() => new GraphPage());
  return { store, page, shortcuts, repoState, invoke, router: routerStub };
}

function makeRow(index: number): CommitRow {
  return {
    commit: makeCommit(index),
    lane: { index: 0, color: 0, continues: false },
    refs: [],
    isHead: false,
  };
}

function menuEvent(clientX = 100, clientY = 120): MouseEvent {
  return new MouseEvent('contextmenu', { clientX, clientY, bubbles: true, cancelable: true });
}

describe('GraphPage', () => {
  it('uses the 28px item size for the virtual viewport', async () => {
    const { page } = await setup();
    expect(page.rowHeight).toBe(28);
  });

  it('tracks rows by a stable commit identity (same row twice, distinct commits apart)', async () => {
    const { page, store } = await setup(3);
    const [first, second] = store.filteredRows();

    const keyA = page.trackByRow(0, first);
    const keyB = page.trackByRow(1, first);

    // Same row → same key regardless of index; key equals the commit oid hex.
    expect(keyA).toBe(keyB);
    expect(keyA).toBe(first.commit.oid?.hex);
    // Different commits → distinct keys.
    expect(page.trackByRow(0, second)).not.toBe(keyA);
  });

  it('falls back to the WIP pseudo-oid when a row has no oid', async () => {
    const { page } = await setup(1);
    const rowWithoutOid = {
      commit: { ...makeCommit(0), oid: undefined },
      lane: { index: 0, color: 0, continues: false },
      refs: [],
      isHead: false,
    } satisfies CommitRow;

    expect(page.trackByRow(0, rowWithoutOid)).toBe(WIP_OID);
  });

  it('exposes the highest lane index for the SVG graph column width', async () => {
    const { page } = await setup();
    expect(page.maxLane()).toBe(1);
  });

  it('pipes the toolbar input into the store filter', async () => {
    const { store, page } = await setup();
    const input = { value: 'commit 2' } as HTMLInputElement;

    page.onFilter({ target: input } as unknown as Event);
    expect(store.filter()).toBe('commit 2');
    expect(store.filteredRows().map((row) => row.commit.message)).toEqual(['commit 2']);

    input.value = '';
    page.onFilter({ target: input } as unknown as Event);
    expect(store.filteredRows()).toHaveLength(3);
  });

  it('selects the WIP node without touching the commit window', async () => {
    const { store, page } = await setup();

    page.selectWip();

    expect(store.selectedOid()).toBe(WIP_OID);
    expect(store.isWipSelected()).toBe(true);
    expect(store.selectedRow()).toBeNull();
    // WIP is purely UI: the loaded commit rows are untouched.
    expect(store.rows()).toHaveLength(3);
  });

  it('routes the WIP row to the File status screen after selecting WIP', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page } = await setup(3, 3, { navigate });

    page.selectWip();

    expect(store.selectedOid()).toBe(WIP_OID);
    expect(navigate).toHaveBeenCalledWith(['/repo', 'file-status']);
  });

  it('routes the toolbar Changes button to File status without selecting a commit', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page } = await setup(3, 3, { navigate });
    const select = vi.spyOn(store, 'select');

    page.openChanges();

    expect(navigate).toHaveBeenCalledWith(['/repo', 'file-status']);
    expect(select).not.toHaveBeenCalled();
  });

  it('prefetches only when the rendered range approaches the loaded end', async () => {
    const { store, page } = await setup(300, 1000);
    const loadMore = vi.spyOn(store, 'loadMore');

    page.onScrolledIndexChange(0);
    expect(loadMore).not.toHaveBeenCalled();

    page.onScrolledIndexChange(291);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('registers arrow keyboard shortcuts on construction', async () => {
    const { shortcuts } = await setup();

    const keys = shortcuts.register.mock.calls.map((call) => call[0]);
    expect(keys).toEqual(['ArrowDown', 'ArrowUp']);
  });

  it('routes keyboard handlers into the store navigation', async () => {
    const { store, shortcuts } = await setup(3);

    const handlerFor = (key: string): ShortcutHandler => {
      const call = shortcuts.register.mock.calls.find(([k]) => k === key);
      if (!call) throw new Error(`no handler registered for ${key}`);
      return call[1] as ShortcutHandler;
    };
    const event = new KeyboardEvent('keydown');

    handlerFor('ArrowDown')(event);
    expect(store.selectedIndex()).toBe(0);

    handlerFor('ArrowDown')(event);
    expect(store.selectedIndex()).toBe(1);

    handlerFor('ArrowUp')(event);
    expect(store.selectedIndex()).toBe(0);
  });

  // -- context menu --------------------------------------------------------

  it('opens the menu for a commit row and clamps it into the viewport', async () => {
    const { page } = await setup(3);

    page.onRowContextMenu(menuEvent(100, 120), makeRow(0));
    expect(page.contextMenuTarget()?.oid).toBe(makeCommit(0).oid?.hex);
    expect(page.contextMenu()?.x).toBe(100);

    page.onRowContextMenu(menuEvent(100000, 100000), makeRow(1));
    expect(page.contextMenu()?.x).toBe(Math.max(0, window.innerWidth - 220));
    expect(page.contextMenu()?.y).toBe(Math.max(0, window.innerHeight - 260));
  });

  it('ignores a context menu on a row without an oid', async () => {
    const { page } = await setup(1);
    const row: CommitRow = { ...makeRow(0), commit: { ...makeCommit(0), oid: undefined } };

    page.onRowContextMenu(menuEvent(), row);

    expect(page.contextMenu()).toBeNull();
  });

  it('enables Compare for a real non-WIP menu target, independent of the selection', async () => {
    const { store, page } = await setup(3);
    // No menu target: nothing to open.
    expect(page.canCompare()).toBe(false);

    // A real commit row: enabled even with no selection at all.
    page.onRowContextMenu(menuEvent(), makeRow(1));
    expect(page.canCompare()).toBe(true);

    // Still enabled when the menu target is the selected commit: Compare is now
    // its own navigation action, not a two-commit diff (ADR-0030 item 4).
    store.select(makeCommit(1).oid?.hex ?? '');
    expect(page.canCompare()).toBe(true);

    // A different selection does not change the gate either.
    store.select(makeCommit(0).oid?.hex ?? '');
    expect(page.canCompare()).toBe(true);
  });

  it('closes the menu explicitly', async () => {
    const { page } = await setup();
    page.onRowContextMenu(menuEvent(), makeRow(0));

    page.closeContextMenu();

    expect(page.contextMenu()).toBeNull();
  });

  it('routes Checkout through RepoState with the resolved ref', async () => {
    const { page, repoState } = await setup();
    page.onRowContextMenu(menuEvent(), makeRow(0));

    page.onCheckout({ refName: 'feature/x', isRemote: false, label: 'feature/x' });

    expect(repoState.checkoutBranch).toHaveBeenCalledWith('feature/x', false);
    expect(page.contextMenu()).toBeNull();
  });

  it('routes Compare to File status by selecting the menu target, never diffing in History', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page, invoke } = await setup(3, 3, { navigate });
    store.select(makeCommit(2).oid?.hex ?? '');
    const select = vi.spyOn(store, 'select');
    const target = makeCommit(1).oid?.hex ?? '';
    page.onRowContextMenu(menuEvent(), makeRow(1));

    page.onCompare();

    expect(select).toHaveBeenCalledWith(target);
    expect(navigate).toHaveBeenCalledWith(['/repo', 'file-status']);
    // ADR-0030 item 4: Compare renders no diff in History.
    expect(invoke).not.toHaveBeenCalledWith('getDiff', expect.anything());
    expect(page.contextMenu()).toBeNull();
  });

  it('routes Compare even when the menu target is the current selection', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page, invoke } = await setup(3, 3, { navigate });
    const oid = makeCommit(1).oid?.hex ?? '';
    store.select(oid);
    const select = vi.spyOn(store, 'select');
    page.onRowContextMenu(menuEvent(), makeRow(1));

    page.onCompare();

    // The target is its own action now: selecting it and routing is valid.
    expect(select).toHaveBeenCalledWith(oid);
    expect(navigate).toHaveBeenCalledWith(['/repo', 'file-status']);
    expect(invoke).not.toHaveBeenCalledWith('getDiff', expect.anything());
  });

  it('ignores Compare with no menu target', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page, invoke } = await setup(3, 3, { navigate });
    const select = vi.spyOn(store, 'select');
    invoke.mockClear();

    page.onCompare();

    expect(select).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('getDiff', expect.anything());
  });

  it('disables Compare and never routes for the WIP pseudo-oid target', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page, invoke } = await setup(3, 3, { navigate });
    const select = vi.spyOn(store, 'select');
    // `contextMenuTarget` cannot be WIP in practice; drive the public path with
    // a synthetic WIP row to pin the gate and the no-op.
    const wipRow: CommitRow = {
      ...makeRow(0),
      commit: { ...makeCommit(0), oid: { hex: WIP_OID, kind: 'SHA1' } },
    };
    page.onRowContextMenu(menuEvent(), wipRow);
    invoke.mockClear();

    expect(page.contextMenuTarget()?.oid).toBe(WIP_OID);
    expect(page.canCompare()).toBe(false);

    page.onCompare();

    expect(select).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('getDiff', expect.anything());
  });

  it('copies the full SHA via the Clipboard API', async () => {
    const { page } = await setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const ok = await page.copyToClipboard('c'.repeat(40));

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('c'.repeat(40));
  });

  it('falls back to a hidden textarea when the Clipboard API rejects', async () => {
    const { page } = await setup();
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const execCommand = vi.fn(() => true);
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

    const ok = await page.copyToClipboard('d'.repeat(40));

    expect(ok).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false when neither clipboard path is available', async () => {
    const { page } = await setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    (document as unknown as { execCommand?: () => boolean }).execCommand = undefined;

    const ok = await page.copyToClipboard('e'.repeat(40));

    expect(ok).toBe(false);
  });

  it('runs soft and mixed resets immediately', async () => {
    const { page, invoke } = await setup();
    const oid = makeCommit(0).oid?.hex ?? '';
    page.onRowContextMenu(menuEvent(), makeRow(0));

    page.onReset('SOFT');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reset', { repoId: 'repo-1', to: oid, mode: 'SOFT' }),
    );

    page.onRowContextMenu(menuEvent(), makeRow(1));
    page.onReset('MIXED');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reset', {
        repoId: 'repo-1',
        to: makeCommit(1).oid?.hex,
        mode: 'MIXED',
      }),
    );
  });

  it('gates a hard reset behind the confirmation dialog', async () => {
    const { page, invoke } = await setup();
    const oid = makeCommit(0).oid?.hex ?? '';
    page.onRowContextMenu(menuEvent(), makeRow(0));
    invoke.mockClear();

    page.onReset('HARD');

    // No RPC until the user confirms.
    expect(invoke).not.toHaveBeenCalledWith('reset', expect.anything());
    expect(page.resetConfirm()).toEqual({ oid });

    page.onResetConfirmed();

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reset', { repoId: 'repo-1', to: oid, mode: 'HARD' }),
    );
    expect(page.resetConfirm()).toBeNull();
  });

  it('cancels a pending hard reset without calling the bridge', async () => {
    const { page, invoke } = await setup();
    page.onRowContextMenu(menuEvent(), makeRow(0));
    page.onReset('HARD');
    invoke.mockClear();

    page.onResetCancelled();

    expect(page.resetConfirm()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('reset', expect.anything());
  });

  it('ignores reset when no menu target is open', async () => {
    const { page, invoke } = await setup();
    invoke.mockClear();

    page.onReset('SOFT');

    expect(invoke).not.toHaveBeenCalledWith('reset', expect.anything());
  });

  // -- create branch / tag at a commit (ADR-028) ---------------------------

  it('opens the create-branch dialog prefilled with the menu commit oid', async () => {
    const { page } = await setup(3);
    const oid = makeCommit(1).oid?.hex ?? '';
    page.onRowContextMenu(menuEvent(), makeRow(1));

    page.onCreateBranchHere(oid);

    expect(page.branchDialog()).toEqual({ startPoint: oid });
    expect(page.contextMenu()).toBeNull();
  });

  it('routes the branch-create submit to RepoState and closes on success', async () => {
    const { page, repoState } = await setup();
    page.branchDialog.set({ startPoint: 'abc' });

    page.onBranchCreateSubmitted({ name: 'topic', startPoint: 'abc', checkout: true });

    await vi.waitFor(() =>
      expect(repoState.createBranch).toHaveBeenCalledWith('topic', 'abc', true),
    );
    await vi.waitFor(() => expect(page.branchDialog()).toBeNull());
  });

  it('keeps the branch dialog open and clears the error on cancel', async () => {
    const { page, repoState } = await setup();
    page.branchDialog.set({ startPoint: 'abc' });

    page.onBranchCreateCancelled();

    expect(page.branchDialog()).toBeNull();
    expect(repoState.clearRefOpError).toHaveBeenCalledTimes(1);
  });

  it('opens the create-tag dialog prefilled with the menu commit oid', async () => {
    const { page } = await setup(3);
    const oid = makeCommit(1).oid?.hex ?? '';
    page.onRowContextMenu(menuEvent(), makeRow(1));

    page.onTagCommit(oid);

    expect(page.tagDialog()).toEqual({ target: oid });
    expect(page.contextMenu()).toBeNull();
  });

  it('reverts the menu commit on the checked-out branch and closes the menu', async () => {
    const { page, repoState } = await setup(3);
    const oid = makeCommit(1).oid?.hex ?? '';
    page.onRowContextMenu(menuEvent(), makeRow(1));

    page.onRevert(oid);

    expect(repoState.revert).toHaveBeenCalledWith(oid);
    expect(page.contextMenu()).toBeNull();
  });

  it('routes the tag-create submit to RepoState and closes on success', async () => {
    const { page, repoState } = await setup();
    page.tagDialog.set({ target: 'abc' });

    page.onTagCreateSubmitted({
      name: 'v1.0.0',
      target: 'abc',
      annotated: true,
      message: 'notes',
      force: false,
    });

    await vi.waitFor(() =>
      expect(repoState.createTag).toHaveBeenCalledWith('v1.0.0', 'abc', true, 'notes', false),
    );
    await vi.waitFor(() => expect(page.tagDialog()).toBeNull());
  });

  it('closes the tag dialog and clears the error on cancel', async () => {
    const { page, repoState } = await setup();
    page.tagDialog.set({ target: 'abc' });

    page.onTagCreateCancelled();

    expect(page.tagDialog()).toBeNull();
    expect(repoState.clearRefOpError).toHaveBeenCalledTimes(1);
  });

  // -- File status hand-off (ADR-0029) --------------------------------------

  it('selects the commit and routes File status to the shared screen', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page } = await setup(3, 3, { navigate });
    const select = vi.spyOn(store, 'select');
    const oid = makeCommit(1).oid?.hex ?? '';

    page.onFileStatus(oid);

    expect(select).toHaveBeenCalledWith(oid);
    expect(navigate).toHaveBeenCalledWith(['/repo', 'file-status']);
  });

  it('treats the WIP pseudo-oid as a File status no-op', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page } = await setup(3, 3, { navigate });
    const select = vi.spyOn(store, 'select');

    page.onFileStatus(WIP_OID);

    expect(select).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores a File status request with no oid', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page } = await setup(3, 3, { navigate });
    const select = vi.spyOn(store, 'select');

    page.onFileStatus('');

    expect(select).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  // -- pane header, column header & footer (plan §4.5) ----------------------

  it('sizes the column-header graph column from the highest lane', async () => {
    const { page } = await setup();
    expect(page.graphWidth()).toBe((page.maxLane() + 1) * LANE_COLUMN_WIDTH);
    // Sanity: two lanes for the fixture page.
    expect(page.graphWidth()).toBe(2 * LANE_COLUMN_WIDTH);
  });

  it('clears the filter through the search clear affordance', async () => {
    const { store, page } = await setup();
    store.setFilter('commit 2');
    expect(store.filter()).toBe('commit 2');

    page.clearFilter();

    expect(store.filter()).toBe('');
    expect(store.filteredRows()).toHaveLength(3);
  });

  it('reports the filtered and total commit counts in the footer', async () => {
    const { store, page } = await setup(3, 10);
    expect(page.countLabel()).toBe('3 of 10 commits');

    store.setFilter('commit 1');
    expect(page.countLabel()).toBe('1 of 10 commits');
  });

  // -- scroll restore (plan §4.6) -------------------------------------------

  it('queues a scroll restore when leaving History for File status', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { store, page } = await setup(3, 3, { navigate });
    store.rememberScrollOffset(84);

    page.onFileStatus(makeCommit(1).oid?.hex ?? '');

    expect(store.pendingScrollOffset()).toBe(84);
    expect(navigate).toHaveBeenCalledWith(['/repo', 'file-status']);
  });

  it('restores the pending scroll offset once through the glue method', async () => {
    const { store, page } = await setup();
    store.rememberScrollOffset(140);
    store.requestScrollRestore();
    const consume = vi.spyOn(store, 'consumeScrollRestore');

    // No template in this spec, so there is no CDK viewport to scroll — but the
    // pending offset is still consumed exactly once so it cannot leak.
    expect(page.restoreScroll()).toBe(140);
    expect(consume).toHaveBeenCalledTimes(1);

    expect(page.restoreScroll()).toBeNull();
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('is a no-op scroll restore when nothing is pending', async () => {
    const { page, store } = await setup();
    const consume = vi.spyOn(store, 'consumeScrollRestore');

    expect(page.restoreScroll()).toBeNull();
    expect(consume).not.toHaveBeenCalled();
  });

  it('queues the remembered offset through the named destroy-hook method', async () => {
    const { store, page } = await setup(3);
    store.rememberScrollOffset(96);
    const request = vi.spyOn(store, 'requestScrollRestore');

    // The destroy hook (and both explicit exits) funnel through this method.
    page.queueScrollRestore();

    expect(request).toHaveBeenCalledTimes(1);
    expect(store.pendingScrollOffset()).toBe(96);
    // Handed back exactly once, then cleared.
    expect(store.consumeScrollRestore()).toBe(96);
    expect(store.consumeScrollRestore()).toBeNull();
  });

  // -- empty-state glyphs (the primitive renders `icon()` as literal text) ---

  it('renders glyphs, never bare words, in the loading and offline empty states', async () => {
    const { store } = await setup(3);
    const fixture = TestBed.createComponent(GraphPage);
    fixture.detectChanges();

    store.loading.set(true);
    store.offline.set(true);
    fixture.detectChanges();

    const iconText = (id: string): string =>
      (
        (fixture.nativeElement as HTMLElement).querySelector(
          `[data-testid="${id}"] [data-testid="empty-state-icon"]`,
        )?.textContent ?? ''
      ).trim();

    // `st-empty-state` prints `icon()` verbatim, so passing "history"/"offline"
    // would render those words; the shipped glyphs never do.
    expect(iconText('graph-loading')).toBe('⏳');
    expect(iconText('graph-offline')).toBe('🔌');
    expect(['history', 'offline']).not.toContain(iconText('graph-loading'));
    expect(['history', 'offline']).not.toContain(iconText('graph-offline'));
  });

  // -- branch lens (ADR-0042) ----------------------------------------------

  it('renders the lens bar only while a lens is active and clears the store from it', async () => {
    const { store } = await setup(3);
    const lens = TestBed.inject(BranchLensStore);
    const fixture = TestBed.createComponent(GraphPage);
    fixture.detectChanges();

    const query = (testId: string): HTMLElement | null =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
        `[data-testid="${testId}"]`,
      );

    expect(query('graph-lens-bar')).toBeNull();

    lens.set('feature/x', 'local');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(query('graph-lens-bar')).not.toBeNull();
    expect(query('graph-lens-ref')?.textContent?.trim()).toBe('feature/x');
    expect(query('graph-lens-note')?.textContent).toContain(
      'Commits outside this ref are dimmed.',
    );
    expect(query('graph-lens-bar')?.getAttribute('role')).toBe('status');
    expect(store.loading()).toBe(false);

    (query('graph-lens-clear') as HTMLElement).click();
    fixture.detectChanges();

    expect(lens.active()).toBe(false);
    expect(query('graph-lens-bar')).toBeNull();
  });

  it('reloads the graph from the top when the lens changes, but not on the first run', async () => {
    const { store } = await setup(3);
    const lens = TestBed.inject(BranchLensStore);
    const reloadForLens = vi.spyOn(store, 'reloadForLens');

    // First effect run (no lens): mounting must not re-request the window the
    // store already loaded, so only a real scope change reloads.
    TestBed.tick();
    expect(reloadForLens).not.toHaveBeenCalled();

    lens.set('feature/x', 'local');
    TestBed.tick();
    expect(reloadForLens).toHaveBeenCalledTimes(1);

    // Switching straight to another ref is a second, distinct scope change.
    lens.set('origin/other', 'remote');
    TestBed.tick();
    expect(reloadForLens).toHaveBeenCalledTimes(2);
  });

  it('passes lensActive and inLens membership to each rendered row', async () => {
    const { store } = await setup(2);
    const lens = TestBed.inject(BranchLensStore);
    const fixture = TestBed.createComponent(GraphPage);
    const el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    // Give the CDK viewport a real measure in jsdom so it renders rows.
    const viewport = fixture.debugElement.query(By.directive(CdkVirtualScrollViewport))
      .componentInstance as CdkVirtualScrollViewport;
    Object.defineProperty(viewport.elementRef.nativeElement, 'clientHeight', {
      configurable: true,
      value: 400,
    });
    viewport.checkViewportSize();
    fixture.detectChanges();

    lens.set('feature/x', 'local');
    fixture.detectChanges();
    await fixture.whenStable();

    // The stub page returns no `inRefs`, so seed the membership explicitly.
    const insideOid = makeCommit(0).oid?.hex as string;
    store.lensOids.set(new Set([insideOid]));
    fixture.detectChanges();

    const rows = Array.from(el.querySelectorAll<HTMLElement>('st-graph-row'));
    expect(rows.length).toBeGreaterThan(0);

    const inside = rows.find((row) => row.getAttribute('data-lens') === 'in');
    const outside = rows.find((row) => row.getAttribute('data-lens') === 'out');
    expect(inside).toBeDefined();
    expect(outside).toBeDefined();
    expect(inside?.classList.contains('st-graph-row--lens-active')).toBe(true);
    expect(inside?.classList.contains('st-graph-row--lens-inside')).toBe(true);
    expect(outside?.classList.contains('st-graph-row--lens-active')).toBe(true);
    expect(outside?.classList.contains('st-graph-row--lens-outside')).toBe(true);
  });

  it('opens the cherry-pick dialog for a row picked inside the lens and still selects it', async () => {
    const { store, page, repoState } = await setup(3);
    const lens = TestBed.inject(BranchLensStore);
    lens.set('feature/x', 'local');
    const oid = makeCommit(1).oid?.hex ?? '';

    page.onRowPicked(makeRow(1));

    expect(store.selectedOid()).toBe(oid);
    expect(repoState.openCherryPick).toHaveBeenCalledWith(oid);
  });

  it('only selects a row pick when no lens is active', async () => {
    const { store, page, repoState } = await setup(3);
    const oid = makeCommit(1).oid?.hex ?? '';

    page.onRowPicked(makeRow(1));

    expect(store.selectedOid()).toBe(oid);
    expect(repoState.openCherryPick).not.toHaveBeenCalled();
  });

  it('opens the shared cherry-pick state from the lens menu output', async () => {
    const { page, repoState } = await setup(3);
    page.onRowContextMenu(menuEvent(), makeRow(1));

    page.onLensCherryPick('f'.repeat(40));

    expect(page.contextMenu()).toBeNull();
    expect(repoState.openCherryPick).toHaveBeenCalledWith('f'.repeat(40));
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    (document as unknown as { execCommand?: () => boolean }).execCommand = undefined;
  });
});
