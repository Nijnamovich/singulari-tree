import {
  Component,
  computed,
  input,
  output,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, Repository } from '@contracts/domain';
import { WorkspaceSplitComponent } from '@singularitree/ui-kit';
import { CommitFocusService } from '@core/services/commit-focus.service';
import { IpcBridge, type AppError } from '@core/services/ipc-bridge.service';
import { RepoState } from '@core/services/repo-state.service';
import { WorkspacesStore } from '@core/services/workspaces.store';
import { CommitViewModeService } from '../commit-view-mode.service';
import { GraphStore, WIP_OID } from '../graph/graph.store';
import { StatusStore } from '../status/status.store';
import type { CommitRow } from '../repo-models';
import { RepoPage } from './repo-page';

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

const ALL_REPOS = [REPO_A, REPO_B];

/**
 * Minimal `RepoState` stand-in: a real `activeRepo` computed over signal-backed
 * repos so the component's hydration effect reacts to selection changes.
 */
function makeRepoState(initial: Repository | null) {
  const repos = signal<Repository[]>(initial ? [initial] : []);
  const activeId = signal<string | null>(initial?.id ?? null);
  const statusRefreshRequested = signal(0);
  return {
    activeRepo: computed<Repository | null>(() => {
      const id = activeId();
      return id ? (repos().find((repo) => repo.id === id) ?? null) : null;
    }),
    // Token the route-scoped consumers observe after a ref mutation (ADR-028).
    statusRefreshRequested,
    setActive(repo: Repository): void {
      repos.update((prev) => [...prev.filter((r) => r.id !== repo.id), repo]);
      activeId.set(repo.id);
    },
    // Signal handles so the test can force the computed to re-evaluate.
    activeId,
    repos,
  };
}

/**
 * Minimal `GraphStore` stand-in mirroring the real contract: `repoId` is set
 * only once `openRepository` resolves, and repeated opens are observable.
 */
function makeGraphStore() {
  const repoId = signal<string | null>(null);
  const commits = signal<Commit[]>([]);
  const selectedOid = signal<string | null>(null);
  const selectedRow = computed<CommitRow | null>(() => {
    const oid = selectedOid();
    if (!oid || oid === WIP_OID) return null;
    const commit = commits().find((c) => c.oid?.hex === oid);
    return commit
      ? { commit, lane: { index: 0, color: 0, continues: false }, refs: [], isHead: false }
      : null;
  });
  const isWipSelected = computed(() => selectedOid() === WIP_OID);
  const openRepository = vi.fn(async (fsPath: string) => {
    const repo = ALL_REPOS.find((r) => r.fsPath === fsPath) ?? REPO_A;
    repoId.set(repo.id);
    return repo;
  });
  const focusCommit = vi.fn(async (_oid: string) => {});
  const reload = vi.fn();
  // Lock API mirror of the frozen store contract: `RepoPage`'s selectedCommit
  // reads `lockedCommit()`, so the hydration-effect unit needs it present even
  // though it never renders the template.
  const lockedOid = signal<string | null>(null);
  const lockedCommit = signal<Commit | null>(null);
  const lock = vi.fn((): void => {
    const oid = selectedOid();
    if (!oid || oid === WIP_OID) return;
    lockedOid.set(oid);
    lockedCommit.set(commits().find((c) => c.oid?.hex === oid) ?? null);
  });
  const unlock = vi.fn((): void => {
    lockedOid.set(null);
    lockedCommit.set(null);
  });
  const release = vi.fn((): void => {
    lockedOid.set(null);
    lockedCommit.set(null);
    selectedOid.set(null);
  });
  return {
    repoId,
    commits,
    selectedOid,
    selectedRow,
    isWipSelected,
    openRepository,
    focusCommit,
    reload,
    error: signal<AppError | null>(null),
    lockedOid,
    lockedCommit,
    lock,
    unlock,
    release,
  };
}

/**
 * Minimal route-scoped `StatusStore` stand-in: the members `RepoPage` touches —
 * the repo pointer, the ADR-032 read-only file-list read, and the monotonic
 * `graphReloadRequested` token the post-commit graph reload consumes.
 */
function makeStatusStore(initialGraphReload = 0) {
  const repoId = signal<string | null>(null);
  const graphReloadRequested = signal(initialGraphReload);
  const readCommitChangedFiles = vi.fn(async (_commit: Commit) => [] as readonly string[]);
  return {
    repoId,
    graphReloadRequested,
    setRepoId: vi.fn((id: string | null) => repoId.set(id)),
    readCommitChangedFiles,
  };
}

/**
 * Minimal `IpcBridge` stand-in: `onFsChanged` records the callback so the test
 * can emit an external change and observes the returned unsubscribe handle.
 */
function makeBridge() {
  let fsChanged: (() => void) | null = null;
  return {
    onFsChanged: vi.fn((cb: () => void) => {
      fsChanged = cb;
      return vi.fn();
    }),
    emitFsChanged: (): void => fsChanged?.(),
  };
}

async function setup(initial: Repository | null = REPO_A, initialGraphReload = 0) {
  const repoState = makeRepoState(initial);
  const graphStore = makeGraphStore();
  const bridge = makeBridge();
  const status = makeStatusStore(initialGraphReload);

  await TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: RepoState, useValue: repoState },
      { provide: GraphStore, useValue: graphStore },
      { provide: StatusStore, useValue: status },
      { provide: IpcBridge, useValue: bridge },
      CommitViewModeService,
    ],
  }).compileComponents();

  // Construct directly (no template render): the hydration effect is the unit
  // under test, not the child graph/picker wiring.
  TestBed.runInInjectionContext(() => new RepoPage());
  TestBed.tick();
  await Promise.resolve();
  return { repoState, graphStore, bridge, status };
}

/** In-memory Storage stand-in: jsdom's own localStorage is absent on globalThis. */
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

/** Install a memory `localStorage` on `globalThis` and return its restore handle. */
function installStorage(entries: Record<string, string> = {}): () => void {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(entries)) storage.setItem(key, value);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  };
}

describe('RepoPage hydration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('does not open a repository when none is active', async () => {
    const { graphStore } = await setup(null);

    expect(graphStore.openRepository).not.toHaveBeenCalled();
  });

  it('opens the active repository in the graph on hydration', async () => {
    const { graphStore } = await setup(REPO_A);

    expect(graphStore.openRepository).toHaveBeenCalledTimes(1);
    expect(graphStore.openRepository).toHaveBeenCalledWith(REPO_A.fsPath);
    expect(graphStore.repoId()).toBe(REPO_A.id);
  });

  it('does not reopen the graph when it already points at the active repo', async () => {
    const { repoState, graphStore } = await setup(REPO_A);
    expect(graphStore.openRepository).toHaveBeenCalledTimes(1);

    // Force the activeRepo computed to re-evaluate with the same repository.
    repoState.activeId.set(null);
    TestBed.tick();
    repoState.activeId.set(REPO_A.id);
    TestBed.tick();
    await Promise.resolve();

    expect(graphStore.openRepository).toHaveBeenCalledTimes(1);
  });

  it('opens the newly activated repository when the selection changes', async () => {
    const { repoState, graphStore } = await setup(REPO_A);
    expect(graphStore.openRepository).toHaveBeenCalledTimes(1);

    repoState.setActive(REPO_B);
    TestBed.tick();
    await Promise.resolve();

    expect(graphStore.openRepository).toHaveBeenCalledTimes(2);
    expect(graphStore.openRepository).toHaveBeenLastCalledWith(REPO_B.fsPath);
    expect(graphStore.repoId()).toBe(REPO_B.id);
  });

  // -- deep-link commit focus hand-off -------------------------------------

  it('focuses a queued commit when its repository is already open', async () => {
    const { graphStore } = await setup(REPO_A);
    const focus = TestBed.inject(CommitFocusService);
    graphStore.focusCommit.mockClear();

    focus.request(REPO_A.id, 'abc123');
    TestBed.tick();
    await Promise.resolve();

    expect(graphStore.focusCommit).toHaveBeenCalledWith('abc123');
    expect(focus.pending()).toBeNull();
  });

  it('consumes a queued commit when its repository is opened by selection', async () => {
    const { repoState, graphStore } = await setup(REPO_A);
    const focus = TestBed.inject(CommitFocusService);
    graphStore.focusCommit.mockClear();

    focus.request(REPO_B.id, 'def456');
    repoState.setActive(REPO_B);
    TestBed.tick();

    await vi.waitFor(() => expect(graphStore.focusCommit).toHaveBeenCalledWith('def456'));
    expect(focus.pending()).toBeNull();
  });

  it("does not consume a superseded repo's pending focus after another repo wins the open", async () => {
    const { repoState, graphStore } = await setup(null);
    const focus = TestBed.inject(CommitFocusService);

    // Defer REPO_A's open so it is still in flight when REPO_B wins the switch.
    // REPO_B keeps the real (stub) behavior and points the graph at itself.
    const deferredA: Array<(repo: Repository) => void> = [];
    graphStore.openRepository.mockImplementation((fsPath: string) => {
      if (fsPath === REPO_A.fsPath) {
        return new Promise<Repository>((resolve) => deferredA.push(resolve));
      }
      const repo = ALL_REPOS.find((r) => r.fsPath === fsPath) ?? REPO_B;
      graphStore.repoId.set(repo.id);
      return Promise.resolve(repo);
    });
    graphStore.focusCommit.mockClear();

    repoState.setActive(REPO_A);
    TestBed.tick();
    expect(graphStore.openRepository).toHaveBeenCalledWith(REPO_A.fsPath);
    // Nothing is latched while A's open stays unresolved.
    expect(graphStore.repoId()).toBeNull();

    focus.request(REPO_A.id, 'stale-oid');
    TestBed.tick();

    repoState.setActive(REPO_B);
    TestBed.tick();
    await vi.waitFor(() => expect(graphStore.repoId()).toBe(REPO_B.id));

    // A's superseded open resolves last: it installed nothing, so its pending
    // deep-link focus must stay queued instead of being selected under B.
    for (const resolve of deferredA) resolve(REPO_A);
    await Promise.resolve();
    await Promise.resolve();

    expect(graphStore.focusCommit).not.toHaveBeenCalledWith('stale-oid');
    expect(focus.pending()).toEqual({ repoId: REPO_A.id, oid: 'stale-oid' });
  });

  // -- re-homed graph refresh triggers (ADR-0030) --------------------------

  it('reloads the graph window when the working tree changes externally', async () => {
    const { bridge, graphStore } = await setup(REPO_A);
    graphStore.reload.mockClear();

    bridge.emitFsChanged();

    expect(graphStore.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads the graph window when a status refresh is requested', async () => {
    const { repoState, graphStore } = await setup(REPO_A);
    graphStore.reload.mockClear();

    repoState.statusRefreshRequested.set(1);
    TestBed.tick();

    expect(graphStore.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads the graph window when a commit requests it', async () => {
    const { status, graphStore } = await setup(REPO_A);
    graphStore.reload.mockClear();

    status.graphReloadRequested.set(1);
    TestBed.tick();

    expect(graphStore.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads the graph on mount when a commit landed before navigation', async () => {
    // The smoke flow commits on the File-status screen and navigates to History
    // before the bump resolves there; the token is already > 0 when RepoPage is
    // constructed, so the mount observation is what must trigger the reload.
    const { graphStore } = await setup(REPO_A, 1);

    expect(graphStore.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload again when the status token is re-set to the same value', async () => {
    const { repoState, graphStore } = await setup(REPO_A);
    repoState.statusRefreshRequested.set(1);
    TestBed.tick();
    expect(graphStore.reload).toHaveBeenCalledTimes(1);

    graphStore.reload.mockClear();
    repoState.statusRefreshRequested.set(1);
    TestBed.tick();

    expect(graphStore.reload).not.toHaveBeenCalled();
  });
});

// -- workspace split wiring (P3) --------------------------------------------
// Rendered through the real template with the three heavy children stubbed:
// the real `st-workspace-split` is kept so content projection is exercised, and
// the child stubs reproduce the frozen contracts (testids, inputs, outputs).

const COMMIT_OID = 'a'.repeat(40);
const COMMIT_A: Commit = {
  oid: { hex: COMMIT_OID, kind: 'SHA1' },
  parents: [],
  author: { name: 'Ada', email: 'ada@example.com', when: '2026-01-01T00:00:00Z' },
  committer: { name: 'Ada', email: 'ada@example.com', when: '2026-01-01T00:00:00Z' },
  message: 'Initial commit',
  treeOid: { hex: 'b'.repeat(40), kind: 'SHA1' },
  committedAt: '2026-01-01T00:00:00Z',
  refs: [],
};

const COMMIT_B_OID = 'c'.repeat(40);
const COMMIT_B: Commit = {
  ...COMMIT_A,
  oid: { hex: COMMIT_B_OID, kind: 'SHA1' },
  parents: [{ hex: COMMIT_OID, kind: 'SHA1' }],
  message: 'Second commit',
};

@Component({
  selector: 'st-graph-page',
  standalone: true,
  template: `<div data-testid="graph-stub"></div>`,
})
class GraphPageStub {}

@Component({
  selector: 'st-repo-picker',
  standalone: true,
  template: `<div data-testid="repo-picker-stub"></div>`,
})
class RepoPickerStub {}

@Component({
  selector: 'st-repo-relocate-panel',
  standalone: true,
  template: `
    <div data-testid="relocate-panel-stub">
      <span data-testid="relocate-reason-stub">{{ reason() }}</span>
    </div>
  `,
})
class RepoRelocatePanelStub {
  readonly repo = input<Repository | null>(null);
  readonly reason = input<'missing' | 'not-a-repo'>('missing');
  readonly busy = input(false);
  readonly relocated = output<Repository>();
  readonly removed = output<void>();
}

@Component({
  selector: 'st-commit-details-panel',
  standalone: true,
  template: `
    @if (isWip()) {
      <div data-testid="commit-details-wip"></div>
    } @else if (commit()) {
      <div data-testid="commit-details"></div>
    } @else {
      <div data-testid="commit-details-empty"></div>
    }
    <button type="button" data-testid="review-changes" (click)="reviewChanges.emit()">
      Review changes
    </button>
    <button type="button" data-testid="lock-toggle" (click)="lockToggle.emit()">Lock</button>
    <button type="button" data-testid="release" (click)="release.emit()">Release</button>
  `,
})
class CommitDetailsPanelStub {
  readonly commit = input<Commit | null>(null);
  readonly isWip = input(false);
  readonly showCta = input(false);
  readonly showSubject = input(true);
  readonly showFiles = input(false);
  readonly navMode = input<'none' | 'release' | 'history'>('none');
  readonly locked = input(false);
  readonly showInGraph = input(false);
  readonly changedFiles = input<readonly string[]>([]);
  readonly mode = input<'description' | 'files'>('description');
  readonly showViewSwitch = input(false);
  readonly reviewChanges = output<void>();
  readonly lockToggle = output<void>();
  readonly release = output<void>();
  readonly openHistory = output<void>();
  readonly revealInGraph = output<void>();
  readonly modeChange = output<'description' | 'files'>();
}

/**
 * Selection-aware `GraphStore` stand-in for the render tests: exposes the
 * signals `RepoPage` derives its split inputs from and keeps `selectedRow`
 * consistent with `selectedOid` (null for the WIP pseudo-oid). The lock API
 * mirrors the frozen store contract: `lock()` captures the current real-commit
 * selection, `unlock()` clears the lock but keeps the selection, and
 * `release()` clears both.
 */
function makeRenderGraphStore(
  opts: { openError?: AppError; failOn?: (fsPath: string) => boolean } = {},
) {
  const repoId = signal<string | null>(null);
  const commits = signal<Commit[]>([COMMIT_A, COMMIT_B]);
  const selectedOid = signal<string | null>(null);
  const error = signal<AppError | null>(null);
  const lockedOid = signal<string | null>(null);
  const lockedCommit = signal<Commit | null>(null);
  const openRepository = vi.fn(async (fsPath: string) => {
    // A failed open leaves `repoId` null and records the error — the state that
    // drives the recovery panel instead of the picker. The fixed store clears
    // the pointer even when a previously open repo existed, so a failed switch
    // never keeps rendering the old repo's window.
    if (opts.openError || opts.failOn?.(fsPath)) {
      error.set(opts.openError ?? { code: 'OPEN_FAILED', message: 'open failed', details: {} });
      repoId.set(null);
      return null;
    }
    const repo = ALL_REPOS.find((r) => r.fsPath === fsPath) ?? REPO_A;
    error.set(null);
    repoId.set(repo.id);
    return repo;
  });
  const focusCommit = vi.fn(async (_oid: string) => {});
  const reload = vi.fn();
  const requestScrollRestore = vi.fn();
  const select = (oid: string | null): void => selectedOid.set(oid);
  const selectedRow = computed<CommitRow | null>(() => {
    const oid = selectedOid();
    if (!oid || oid === WIP_OID) return null;
    const commit = commits().find((c) => c.oid?.hex === oid);
    return commit
      ? {
          commit,
          lane: { index: 0, color: 0, continues: false },
          refs: [],
          isHead: false,
        }
      : null;
  });
  const isWipSelected = computed(() => selectedOid() === WIP_OID);
  // Lock captures the current real-commit selection's oid and commit; the
  // captured commit survives the row falling out of the loaded window.
  const lock = vi.fn((): void => {
    const oid = selectedOid();
    if (!oid || oid === WIP_OID) return;
    lockedOid.set(oid);
    lockedCommit.set(commits().find((c) => c.oid?.hex === oid) ?? null);
  });
  // Unlock clears the lock but keeps the selection.
  const unlock = vi.fn((): void => {
    lockedOid.set(null);
    lockedCommit.set(null);
  });
  // Release clears the lock AND the selection.
  const release = vi.fn((): void => {
    lockedOid.set(null);
    lockedCommit.set(null);
    selectedOid.set(null);
  });
  return {
    repoId,
    commits,
    selectedOid,
    selectedRow,
    isWipSelected,
    error,
    openRepository,
    focusCommit,
    reload,
    requestScrollRestore,
    select,
    lockedOid,
    lockedCommit,
    lock,
    unlock,
    release,
  };
}

async function render(
  initial: Repository | null = REPO_A,
  opts: { openError?: AppError; failOn?: (fsPath: string) => boolean } = {},
) {
  const repoState = makeRepoState(initial);
  const graphStore = makeRenderGraphStore(opts);
  const bridge = makeBridge();
  const status = makeStatusStore();
  const router = { navigate: vi.fn(async () => true), url: '/repo' };

  await TestBed.configureTestingModule({
    imports: [RepoPage],
    providers: [
      provideZonelessChangeDetection(),
      { provide: RepoState, useValue: repoState },
      { provide: GraphStore, useValue: graphStore },
      { provide: StatusStore, useValue: status },
      { provide: IpcBridge, useValue: bridge },
      { provide: Router, useValue: router },
      // Route-scoped in the app; the routed host injects it, so the test must
      // provide it explicitly.
      CommitViewModeService,
    ],
  })
    .overrideComponent(RepoPage, {
      set: {
        imports: [
          WorkspaceSplitComponent,
          CommitDetailsPanelStub,
          GraphPageStub,
          RepoPickerStub,
          RepoRelocatePanelStub,
        ],
      },
    })
    .compileComponents();

  const fixture = TestBed.createComponent(RepoPage);
  return {
    fixture,
    repoState,
    graphStore,
    status,
    router,
    workspaces: TestBed.inject(WorkspacesStore),
  };
}

describe('RepoPage workspace split', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function host(fixture: ComponentFixture<RepoPage>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /** Render and settle the hydration effect so `repoId()` is populated. */
  async function renderWithGraph() {
    const ctx = await render(REPO_A);
    await vi.waitFor(() => {
      ctx.fixture.detectChanges();
      expect(ctx.graphStore.repoId()).not.toBeNull();
    });
    return ctx;
  }

  /** The stubbed recovery panel instance (to drive its outputs). */
  function panelStub(fixture: ComponentFixture<RepoPage>): RepoRelocatePanelStub {
    return fixture.debugElement.query(By.directive(RepoRelocatePanelStub))
      .componentInstance as RepoRelocatePanelStub;
  }

  /** The stubbed commit-details panel instance (to read its inputs). */
  function detailsStub(fixture: ComponentFixture<RepoPage>): CommitDetailsPanelStub {
    return fixture.debugElement.query(By.directive(CommitDetailsPanelStub))
      .componentInstance as CommitDetailsPanelStub;
  }

  /** Render with a failed open so the recovery state settles. */
  async function renderRelocate(openError: AppError) {
    const ctx = await render(REPO_A, { openError });
    await vi.waitFor(() => {
      ctx.fixture.detectChanges();
      expect(ctx.graphStore.error()).not.toBeNull();
    });
    ctx.fixture.detectChanges();
    return ctx;
  }

  it('mounts the workspace split and shows the picker first-run state with no repository', async () => {
    const { fixture } = await render(null);
    fixture.detectChanges();

    const el = host(fixture);
    expect(el.querySelector('[data-testid="workspace-primary"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="repo-picker-stub"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="graph-stub"]')).toBeNull();
    // Nothing selected: the split must not pin an empty detail pane.
    expect(el.querySelector('[data-testid="workspace-detail"]')).toBeNull();
  });

  it('mounts the graph in the primary pane once a repository is open', async () => {
    const { fixture } = await renderWithGraph();
    fixture.detectChanges();

    const el = host(fixture);
    expect(el.querySelector('[data-testid="workspace-primary"] [data-testid="graph-stub"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="repo-picker-stub"]')).toBeNull();
  });

  it('pins the commit details panel for a selected commit', async () => {
    const { fixture, graphStore } = await renderWithGraph();
    graphStore.selectedOid.set(COMMIT_OID);
    fixture.detectChanges();

    const detail = host(fixture).querySelector('[data-testid="workspace-detail"]');
    expect(detail).not.toBeNull();
    expect(detail!.querySelector('[data-testid="commit-details"]')).not.toBeNull();
  });

  it('pins the WIP panel when the working-tree pseudo-oid is selected', async () => {
    const { fixture, graphStore } = await renderWithGraph();
    graphStore.selectedOid.set(WIP_OID);
    fixture.detectChanges();

    const detail = host(fixture).querySelector('[data-testid="workspace-detail"]');
    expect(detail).not.toBeNull();
    expect(detail!.querySelector('[data-testid="commit-details-wip"]')).not.toBeNull();
  });

  it('labels the detail pane by selection kind (Commit / Working tree)', async () => {
    const { fixture, graphStore } = await renderWithGraph();

    graphStore.selectedOid.set(COMMIT_OID);
    fixture.detectChanges();
    expect(
      host(fixture).querySelector('[data-testid="workspace-detail-header"]')?.textContent?.trim(),
    ).toBe('Commit');

    graphStore.selectedOid.set(WIP_OID);
    fixture.detectChanges();
    expect(
      host(fixture).querySelector('[data-testid="workspace-detail-header"]')?.textContent?.trim(),
    ).toBe('Working tree');
  });

  it('routes to the file-status screen when the detail CTA emits reviewChanges', async () => {
    const { fixture, graphStore, router } = await renderWithGraph();
    graphStore.selectedOid.set(COMMIT_OID);
    fixture.detectChanges();

    const cta = host(fixture).querySelector<HTMLButtonElement>('[data-testid="review-changes"]');
    expect(cta).not.toBeNull();
    cta!.click();
    fixture.detectChanges();

    expect(router.navigate).toHaveBeenCalledWith(['/repo', 'file-status']);
    // P3 fix: the headline CTA queues the graph's scroll restore before leaving.
    expect(graphStore.requestScrollRestore).toHaveBeenCalled();
  });

  // -- relocation recovery (P4.1) ------------------------------------------

  it('shows the recovery panel instead of the picker when the recorded folder is missing', async () => {
    const { fixture } = await renderRelocate({
      code: 'REPO_PATH_MISSING',
      message: 'gone',
      details: {},
    });

    const el = host(fixture);
    expect(el.querySelector('[data-testid="relocate-panel-stub"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="repo-picker-stub"]')).toBeNull();
    expect(el.querySelector('[data-testid="graph-stub"]')).toBeNull();
  });

  it("reports 'not-a-repo' when the recorded folder is not a Git repository", async () => {
    const { fixture } = await renderRelocate({
      code: 'NOT_A_GIT_REPO',
      message: 'not a repo',
      details: {},
    });

    expect(
      host(fixture).querySelector('[data-testid="relocate-reason-stub"]')?.textContent?.trim(),
    ).toBe('not-a-repo');
  });

  it('reopens the graph and refreshes the tab after the panel relocates', async () => {
    const { fixture, graphStore, workspaces } = await renderRelocate({
      code: 'REPO_PATH_MISSING',
      message: 'gone',
      details: {},
    });
    graphStore.openRepository.mockClear();

    const moved: Repository = { ...REPO_A, fsPath: '/tmp/a-moved' };
    panelStub(fixture).relocated.emit(moved);
    fixture.detectChanges();

    expect(graphStore.openRepository).toHaveBeenCalledWith('/tmp/a-moved');
    // Same id: the tab is refreshed in place, never duplicated.
    expect(workspaces.tabs().map((tab) => tab.repoId)).toEqual(['repo-a']);
    expect(workspaces.tabs()[0].fsPath).toBe('/tmp/a-moved');
  });

  it('opens the graph exactly once after a successful relocate', async () => {
    const { fixture, graphStore } = await renderRelocate({
      code: 'REPO_PATH_MISSING',
      message: 'gone',
      details: {},
    });

    // The relocate open succeeds this time: clear the recorded error and point
    // the graph at the repository, as the real `openRepository` would.
    graphStore.openRepository.mockImplementation(async (fsPath: string) => {
      graphStore.error.set(null);
      graphStore.repoId.set(REPO_A.id);
      return { ...REPO_A, fsPath };
    });
    graphStore.openRepository.mockClear();

    const moved: Repository = { ...REPO_A, fsPath: '/tmp/a-moved' };
    panelStub(fixture).relocated.emit(moved);
    fixture.detectChanges();
    await fixture.whenStable();

    // The explicit open is the only one: the effect is gated while it runs.
    expect(graphStore.openRepository).toHaveBeenCalledTimes(1);
    expect(graphStore.openRepository).toHaveBeenCalledWith('/tmp/a-moved');
  });

  // -- item 7a: detail-pane release + graph lock ---------------------------

  it('releases the selection and the lock when the panel releases', async () => {
    const { fixture, graphStore } = await renderWithGraph();
    graphStore.selectedOid.set(COMMIT_OID);
    graphStore.lock();
    fixture.detectChanges();

    host(fixture).querySelector<HTMLButtonElement>('[data-testid="release"]')!.click();
    fixture.detectChanges();

    expect(graphStore.release).toHaveBeenCalled();
    expect(graphStore.selectedOid()).toBeNull();
    expect(graphStore.lockedOid()).toBeNull();
    expect(host(fixture).querySelector('[data-testid="workspace-detail"]')).toBeNull();
  });

  it('locks the store when the padlock toggles on', async () => {
    const { fixture, graphStore } = await renderWithGraph();
    graphStore.selectedOid.set(COMMIT_OID);
    fixture.detectChanges();
    expect(detailsStub(fixture).locked()).toBe(false);

    host(fixture).querySelector<HTMLButtonElement>('[data-testid="lock-toggle"]')!.click();
    fixture.detectChanges();

    expect(graphStore.lock).toHaveBeenCalledTimes(1);
    expect(graphStore.unlock).not.toHaveBeenCalled();
    expect(graphStore.lockedOid()).toBe(COMMIT_OID);
    expect(detailsStub(fixture).locked()).toBe(true);
  });

  it('unlocks the store when the padlock toggles off, keeping the selection', async () => {
    const { fixture, graphStore } = await renderWithGraph();
    graphStore.selectedOid.set(COMMIT_OID);
    graphStore.lock();
    fixture.detectChanges();
    expect(detailsStub(fixture).locked()).toBe(true);

    host(fixture).querySelector<HTMLButtonElement>('[data-testid="lock-toggle"]')!.click();
    fixture.detectChanges();

    expect(graphStore.unlock).toHaveBeenCalledTimes(1);
    expect(graphStore.lockedOid()).toBeNull();
    // Unlock keeps the selection: the pane stays pinned on the same commit.
    expect(graphStore.selectedOid()).toBe(COMMIT_OID);
    expect(detailsStub(fixture).locked()).toBe(false);
  });

  it('drives the panel switch from the shared view-mode service', async () => {
    const { fixture, graphStore } = await renderWithGraph();
    const viewMode = TestBed.inject(CommitViewModeService);
    graphStore.select(COMMIT_OID);
    fixture.detectChanges();

    const panel = detailsStub(fixture);
    // The History aside opts into the header switch.
    expect(panel.showViewSwitch()).toBe(true);
    // The panel's mode is HOST-owned: it starts at the service default…
    expect(panel.mode()).toBe('description');

    // …follows an external change (e.g. a pick made on the analyzer)…
    viewMode.setMode('files');
    fixture.detectChanges();
    expect(panel.mode()).toBe('files');

    // …and an emitted pick changes nothing locally: the host feeds it back.
    viewMode.setMode('description');
    fixture.detectChanges();
    panel.modeChange.emit('files');
    fixture.detectChanges();
    expect(viewMode.mode()).toBe('files');
    expect(panel.mode()).toBe('files');
  });

  it('keeps rendering the locked commit after the window reloads without it', async () => {
    const { fixture, graphStore } = await renderWithGraph();
    graphStore.selectedOid.set(COMMIT_OID);
    graphStore.lock();
    fixture.detectChanges();
    expect(detailsStub(fixture).commit()).toEqual(COMMIT_A);

    // A reload drops the locked commit out of the loaded window while the
    // selection is kept: the `lockedCommit` fallback must keep the pane pinned.
    graphStore.commits.set([COMMIT_B]);
    fixture.detectChanges();

    expect(graphStore.selectedRow()).toBeNull();
    expect(fixture.componentInstance.selectedCommit()).toEqual(COMMIT_A);

    const detail = host(fixture).querySelector('[data-testid="workspace-detail"]');
    expect(detail).not.toBeNull();
    expect(detail!.querySelector('[data-testid="commit-details"]')).not.toBeNull();
    expect(detailsStub(fixture).commit()).toEqual(COMMIT_A);
  });

  // -- ADR-032: changed-file list read -------------------------------------

  it('points the route-scoped StatusStore at the open repository', async () => {
    const { status } = await renderWithGraph();

    expect(status.setRepoId).toHaveBeenCalledWith(REPO_A.id);
  });

  it('reads the selected commit changed files and passes them to the panel', async () => {
    const { fixture, graphStore, status } = await renderWithGraph();
    status.readCommitChangedFiles.mockResolvedValue(['src/a.ts', 'src/b.ts']);

    graphStore.select(COMMIT_OID);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(detailsStub(fixture).changedFiles()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    expect(status.readCommitChangedFiles).toHaveBeenCalledWith(COMMIT_A);
    expect(fixture.componentInstance.changedFiles()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('drops a late changed-file response for a commit that is no longer selected', async () => {
    const { fixture, graphStore, status } = await renderWithGraph();

    let resolveFirst: ((paths: readonly string[]) => void) | undefined;
    status.readCommitChangedFiles.mockImplementationOnce(
      () =>
        new Promise<readonly string[]>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    status.readCommitChangedFiles.mockResolvedValue(['late']);

    graphStore.select(COMMIT_OID);
    fixture.detectChanges();
    await vi.waitFor(() => expect(status.readCommitChangedFiles).toHaveBeenCalledTimes(1));

    graphStore.select(COMMIT_B_OID);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.changedFiles()).toEqual(['late']);
    });

    // The deselected commit's slower response must not overwrite the list.
    resolveFirst?.(['stale']);
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.componentInstance.changedFiles()).toEqual(['late']);
  });

  it('clears the changed-file list on a cleared selection and on the WIP row', async () => {
    const { fixture, graphStore, status } = await renderWithGraph();
    status.readCommitChangedFiles.mockResolvedValue(['src/a.ts']);

    graphStore.select(COMMIT_OID);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.changedFiles()).toEqual(['src/a.ts']);
    });

    graphStore.select(WIP_OID);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.changedFiles()).toEqual([]);
    });

    graphStore.select(COMMIT_OID);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.changedFiles()).toEqual(['src/a.ts']);
    });

    graphStore.select(null);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.changedFiles()).toEqual([]);
    });
  });

  // -- tab-switch refresh (repo A -> failing B -> back to A) ----------------

  it('renders the picker, never a stale repo, after a failed open of the newly active repo', async () => {
    const { fixture, repoState, graphStore } = await render(REPO_A, {
      failOn: (fsPath) => fsPath === REPO_B.fsPath,
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(graphStore.repoId()).toBe(REPO_A.id);
    });

    // Switching to a repo whose folder cannot be opened must not keep showing
    // the previously open repo's window.
    repoState.setActive(REPO_B);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(graphStore.error()).not.toBeNull();
    });
    fixture.detectChanges();

    const el = host(fixture);
    expect(graphStore.repoId()).toBeNull();
    expect(el.querySelector('[data-testid="repo-picker-stub"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="graph-stub"]')).toBeNull();
  });

  // -- persisted pane width reaches the mounted split (plan 4.9) -------------

  describe('with a persisted st:paneWidth', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
      // The preference is read in PreferencesService's constructor, so the
      // memory storage must exist before the page is created.
      restoreStorage = installStorage({ 'st:paneWidth': '420' });
    });

    afterEach(() => {
      restoreStorage();
    });

    it('applies the persisted pane width to the rendered detail pane', async () => {
      const { fixture, graphStore } = await renderWithGraph();
      graphStore.selectedOid.set(COMMIT_OID);
      fixture.detectChanges();

      const detail = host(fixture).querySelector<HTMLElement>(
        '[data-testid="workspace-detail"]',
      );
      expect(detail).not.toBeNull();
      expect(detail!.style.width).toBe('420px');
    });

    it('persists st:paneWidth when the split divider is dragged', async () => {
      const { fixture, graphStore } = await renderWithGraph();
      graphStore.selectedOid.set(COMMIT_OID);
      fixture.detectChanges();

      // The split is opt-in resizable, so the divider is really mounted.
      const divider = host(fixture).querySelector<HTMLElement>(
        '[data-testid="workspace-divider"]',
      );
      expect(divider).not.toBeNull();

      divider!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      fixture.detectChanges();

      // The page only rounds the emitted pixels and forwards them to the service.
      expect(localStorage.getItem('st:paneWidth')).toBe('320');
    });
  });

  it('re-opens a repo whose previous open failed when it is selected again', async () => {
    const { fixture, repoState, graphStore } = await render(REPO_A, {
      failOn: (fsPath) => fsPath === REPO_A.fsPath,
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(graphStore.error()).not.toBeNull();
    });
    // The failed open left no repo latched (the fixed store clears the pointer).
    expect(graphStore.repoId()).toBeNull();
    const opensBefore = graphStore.openRepository.mock.calls.length;

    // Re-selecting the same repo (a fresh object, as the drawer list hands back)
    // retries the open: the guard must not treat the cleared id as "already
    // open" — which is exactly what the old latched-id bug did.
    repoState.setActive({ ...REPO_A });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(graphStore.openRepository.mock.calls.length).toBe(opensBefore + 1);
    });
    expect(graphStore.openRepository).toHaveBeenLastCalledWith(REPO_A.fsPath);
  });
});
