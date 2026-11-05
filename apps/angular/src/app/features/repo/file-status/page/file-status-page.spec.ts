import { provideZonelessChangeDetection, signal, type WritableSignal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch, Commit, Diff, FileDiff, FileStatus, Hunk, Repository } from '@contracts/domain';
import { DiffViewer } from '@singularitree/ui-kit';
import { CommitFocusService } from '@core/services/commit-focus.service';
import { DiffModeService } from '@core/services/diff-mode.service';
import { IpcBridge } from '@core/services/ipc-bridge.service';
import { RepoState } from '@core/services/repo-state.service';
import { CommitViewModeService } from '../../commit-view-mode.service';
import { GraphStore, WIP_OID } from '../../graph/graph.store';
import { CommitDetailsPanel } from '../../graph/ui/commit-details-panel';
import { StatusStore } from '../../status/status.store';
import { FileStatusStore } from '../file-status.store';
import { FileStatusPage } from './file-status-page';

const HEAD_HEX = 'a'.repeat(40);
const OTHER_HEX = 'b'.repeat(40);

function commit(hex: string, parents: string[] = [], message?: string): Commit {
  return {
    oid: { hex, kind: 'SHA1' },
    parents: parents.map((parent) => ({ hex: parent, kind: 'SHA1' })),
    author: { name: 'Ada', email: 'ada@example.com', when: '2026-01-02T10:00:00Z' },
    committer: undefined,
    message: message ?? `commit ${hex.slice(0, 4)}`,
    treeOid: undefined,
    committedAt: '2026-01-02T10:05:00Z',
    refs: [],
  };
}

/** Body of the default HEAD commit, so the analyzer's description mode is non-empty. */
const HEAD_BODY = 'body for the head commit';
/** Default HEAD message: subject + blank line + body (the analyzer splits it). */
const HEAD_MESSAGE = `commit ${HEAD_HEX.slice(0, 4)}\n\n${HEAD_BODY}`;

function hunk(text: string): Hunk {
  return {
    fromStart: 1,
    fromLines: 1,
    toStart: 1,
    toLines: 1,
    lines: [{ kind: 'added', text, noNewline: false }],
  };
}

function fileDiff(path: string, additions: number, deletions: number, firstLine: string): FileDiff {
  return {
    path,
    oldPath: '',
    status: 'M',
    hunks: [hunk(firstLine)],
    additions,
    deletions,
    isBinary: false,
    hasConflictMarkers: false,
  };
}

/** Whole-repository diff of two files: the payload the store owns end-to-end. */
function wholeDiff(): Diff {
  return {
    from: undefined,
    to: undefined,
    hunks: [hunk('a-line'), hunk('b-line')],
    additions: 10,
    deletions: 4,
    isBinary: false,
    hasConflictMarkers: false,
    truncated: false,
    files: [fileDiff('a.ts', 6, 2, 'a-line'), fileDiff('b.ts', 4, 2, 'b-line')],
  };
}

function file(path: string, isStaged: boolean): FileStatus {
  return {
    path,
    staged: isStaged ? 'M' : ' ',
    unstaged: isStaged ? ' ' : 'M',
    isStaged,
    isConflicted: false,
  };
}

function branch(name: string, tip: string, overrides: Partial<Branch> = {}): Branch {
  return {
    name,
    refName: overrides.isRemote ? `refs/remotes/${name}` : `refs/heads/${name}`,
    tip: { hex: tip, kind: 'SHA1' },
    upstream: '',
    isCurrent: false,
    isRemote: false,
    behind: 0,
    ...overrides,
  };
}

type Handler = (req: unknown) => unknown;
type Handlers = Partial<
  Record<
    | 'getStatus'
    | 'getDiff'
    | 'getBranches'
    | 'getCommits'
    | 'stage'
    | 'unstage'
    | 'stageHunk'
    | 'unstageHunk'
    | 'discardHunk'
    | 'commit',
    Handler
  >
>;

const BRANCHES: Branch[] = [
  branch('origin/main', 'origin-main-oid', { isRemote: true }),
  branch('main', 'main-oid'),
  branch('develop', 'develop-oid', { isCurrent: true }),
];

interface RepoStateStub {
  activeRepo: WritableSignal<Repository | null>;
  activeId: WritableSignal<string | null>;
  statusRefreshRequested: WritableSignal<number>;
}

interface Harness {
  fixture: ComponentFixture<FileStatusPage>;
  fs: FileStatusStore;
  status: StatusStore;
  graph: GraphStore;
  repoState: RepoStateStub;
  commitFocus: CommitFocusService;
  viewMode: CommitViewModeService;
  router: { navigate: ReturnType<typeof vi.fn> };
  getDiff: ReturnType<typeof vi.fn>;
  stageHunk: ReturnType<typeof vi.fn>;
  unstageHunk: ReturnType<typeof vi.fn>;
  discardHunk: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.spyOn>;
  emitFsChanged: () => void;
}

async function setup(
  options: {
    selection?: string | null;
    files?: FileStatus[];
    diff?: () => Diff;
    commits?: () => Commit[];
  } = {},
  storage?: Record<string, string>,
): Promise<Harness> {
  const getDiff = vi.fn(() => Promise.resolve(options.diff ? options.diff() : wholeDiff()));
  const stageHunk = vi.fn(() => Promise.resolve({}));
  const unstageHunk = vi.fn(() => Promise.resolve({}));
  const discardHunk = vi.fn(() => Promise.resolve({}));
  const handlers: Handlers = {
    getStatus: () => Promise.resolve({ files: options.files ?? [file('a.ts', false)] }),
    getDiff,
    getBranches: () => Promise.resolve({ branches: BRANCHES }),
    getCommits: () =>
      Promise.resolve({ commits: options.commits ? options.commits() : [], total: 0, lanes: [] }),
    stageHunk,
    unstageHunk,
    discardHunk,
  };
  let fsChangedListener: (() => void) | null = null;
  const invoke = vi.fn((method: string, req: unknown) => {
    const handler = handlers[method as keyof Handlers];
    if (!handler) throw new Error(`unexpected method ${method}`);
    return handler(req);
  });
  const bridge = {
    invoke,
    onFsChanged: (cb: () => void) => {
      fsChangedListener = cb;
      return () => {
        fsChangedListener = null;
      };
    },
  };

  const status = new StatusStore(bridge as unknown as IpcBridge);
  const fs = new FileStatusStore(bridge as unknown as IpcBridge, status);
  const graph = new GraphStore(bridge as unknown as IpcBridge);
  graph.repoId.set('repo-1');
  graph.commits.set(
    options.commits
      ? options.commits()
      : [commit(HEAD_HEX, [OTHER_HEX], HEAD_MESSAGE), commit(OTHER_HEX)],
  );
  if (options.selection !== null) graph.select(options.selection ?? HEAD_HEX);

  const repoState: RepoStateStub = {
    activeRepo: signal<Repository | null>(null),
    activeId: signal<string | null>(null),
    statusRefreshRequested: signal(0),
  };
  const router = { navigate: vi.fn(() => Promise.resolve(true)) };

  await TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: IpcBridge, useValue: bridge },
      { provide: RepoState, useValue: repoState },
      { provide: StatusStore, useValue: status },
      { provide: FileStatusStore, useValue: fs },
      { provide: GraphStore, useValue: graph },
      { provide: Router, useValue: router },
      // Route-scoped in the app (provided on the parent repo route), so the
      // standalone page spec must provide it explicitly.
      CommitViewModeService,
    ],
  }).compileComponents();
  const commitFocus = TestBed.inject(CommitFocusService);
  const viewMode = TestBed.inject(CommitViewModeService);

  // Root preferences are read in PreferencesService's constructor, so any
  // persisted value must be in place before the page (and its viewer) mount.
  if (storage) installStorage(storage);

  const fixture = TestBed.createComponent(FileStatusPage);
  fixture.detectChanges();
  const reload = vi.spyOn(graph, 'reload');
  return {
    fixture,
    fs,
    status,
    graph,
    repoState,
    commitFocus,
    viewMode,
    router,
    getDiff,
    stageHunk,
    unstageHunk,
    discardHunk,
    reload,
    emitFsChanged: () => fsChangedListener?.(),
  };
}

/** Diff viewer instance rendered in the right pane. */
function viewer(fixture: ComponentFixture<FileStatusPage>): DiffViewer {
  const element = fixture.debugElement.query(By.css('st-diff-viewer'));
  return element?.componentInstance as DiffViewer;
}

function query<T extends HTMLElement = HTMLElement>(
  fixture: ComponentFixture<FileStatusPage>,
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(
    `[data-testid="${testId}"]`,
  );
}

function all(fixture: ComponentFixture<FileStatusPage>, testId: string): HTMLElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      `[data-testid="${testId}"]`,
    ),
  );
}

/**
 * The embedded `st-commit-details-panel` instance. It is the AUTHORITATIVE
 * source for the rendered commit view: the page no longer mirrors the panel's
 * effective mode, so the specs assert the panel's own `effectiveMode` — the
 * value that actually decides what the user sees.
 */
function panelOf(fixture: ComponentFixture<FileStatusPage>): CommitDetailsPanel {
  const panel = fixture.debugElement.query(By.css('st-commit-details-panel'));
  if (!panel) throw new Error('commit details panel not found');
  return panel.componentInstance as CommitDetailsPanel;
}

/** Run change detection and let the scheduled effects and bridge calls settle. */
async function settle(fixture: ComponentFixture<FileStatusPage>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** Wait until the screen has loaded the diff of the current variant. */
async function waitForDiff(fixture: ComponentFixture<FileStatusPage>, fs: FileStatusStore): Promise<void> {
  await vi.waitFor(() => expect(fs.wholeDiff()).not.toBeNull());
  fixture.detectChanges();
}

/** Request object of the most recent call of a mocked bridge handler. */
function lastPayload(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = mock.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

/**
 * The diff pane must render to the RIGHT of the variant-body left column, never
 * swapped: the workspace split projects the `detail` slot (file list) into the
 * detail/left pane and the default slot (diff) into the primary/right pane.
 * Fails if the two panes are reordered.
 */
function assertDiffOnRight(fixture: ComponentFixture<FileStatusPage>): void {
  const host = fixture.nativeElement as HTMLElement;
  const detail = host.querySelector('[data-testid="workspace-detail"]');
  const primary = host.querySelector('[data-testid="workspace-primary"]');
  const right = query(fixture, 'file-status-diff');
  const left = host.querySelector('.st-file-status__left');
  expect(detail).not.toBeNull();
  expect(primary).not.toBeNull();
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  // detail (file list) precedes primary (diff); the split puts detail left/primary right.
  expect(detail!.compareDocumentPosition(primary!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The file list is inside the detail; the diff is inside the primary, never swapped.
  expect(detail!.contains(left!)).toBe(true);
  expect(primary!.contains(right!)).toBe(true);
  expect(detail!.contains(right!)).toBe(false);
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

describe('FileStatusPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('lands on the commit variant when a real commit is selected', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });

    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    expect(fs.activeCommit()?.oid?.hex).toBe(HEAD_HEX);
    expect(query(fixture, 'commit-details')).not.toBeNull();
    // The commit header is on the LEFT; the diff is on the RIGHT, never swapped.
    expect(query(fixture, 'file-status-diff')).not.toBeNull();
    assertDiffOnRight(fixture);
  });

  it('renders the subject and body in the panel description region (one home)', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    const details = fixture.debugElement.query(By.css('st-commit-details-panel'))
      ?.componentInstance as CommitDetailsPanel;
    expect(details.showSubject()).toBe(true);
    expect(details.showFiles()).toBe(true);
    expect(details.filesSelectable()).toBe(true);
    expect(details.showViewSwitch()).toBe(true);
    expect(details.navMode()).toBe('history');

    // The subject and the body render in the panel's own content region.
    const subject = query(fixture, 'commit-details-subject');
    expect(subject?.textContent?.trim()).toBe('commit aaaa');
    const body = query(fixture, 'commit-details-description');
    expect(body?.textContent?.trim()).toBe(HEAD_BODY);
    const content = query(fixture, 'commit-details-content')!;
    expect(content.contains(subject!)).toBe(true);
    expect(content.contains(body!)).toBe(true);

    // The right pane no longer duplicates the description (one home only).
    expect(query(fixture, 'file-status-title')).toBeNull();
    expect(query(fixture, 'file-status-title-body')).toBeNull();
  });

  it('leaves the description empty with no active commit', async () => {
    const { fixture, fs } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    fixture.detectChanges();

    expect(panelOf(fixture).subject()).toBe('');
    expect(query(fixture, 'file-status-title')).toBeNull();
    expect(query(fixture, 'commit-details-subject')).toBeNull();
  });

  it('defaults the analyzer to description: full subject + body in the panel, no file list', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    // The PANEL owns the effective mode; the page does not mirror it.
    expect(panelOf(fixture).effectiveMode()).toBe('description');

    // The panel owns the description sector: subject + body in its content.
    const subject = query(fixture, 'commit-details-subject')!;
    expect(subject.textContent?.trim()).toBe('commit aaaa');
    const body = query(fixture, 'commit-details-description')!;
    expect(body.textContent?.trim()).toBe(HEAD_BODY);
    expect(query(fixture, 'commit-details-content')!.contains(body)).toBe(true);

    // The file sector is hidden in description mode.
    expect(fixture.nativeElement.querySelector('st-file-diff-list')).toBeNull();
    expect(query(fixture, 'file-status-summary')).toBeNull();
    expect(query(fixture, 'commit-details-file-path')).toBeNull();
  });

  it('switches the analyzer to files mode from the panel switch: the panel list appears', async () => {
    const { fixture, fs, viewMode } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    // The switch lives in the PANEL header, never in the right pane.
    const panelEl = fixture.nativeElement.querySelector('st-commit-details-panel') as HTMLElement;
    const viewSwitch = query(fixture, 'commit-details-view-switch')!;
    expect(panelEl.contains(viewSwitch)).toBe(true);
    expect(query(fixture, 'file-status-view-switch')).toBeNull();

    viewSwitch.querySelector<HTMLButtonElement>('[data-testid="toggle-segment-files"]')!.click();
    fixture.detectChanges();

    // The pick went through the host: the shared service carries the mode.
    expect(viewMode.mode()).toBe('files');
    expect(panelOf(fixture).effectiveMode()).toBe('files');
    // The panel keeps the subject as identity but drops the body.
    expect(query(fixture, 'commit-details-subject')?.textContent?.trim()).toBe('commit aaaa');
    expect(query(fixture, 'commit-details-description')).toBeNull();
    expect(query(fixture, 'file-status-title-body')).toBeNull();

    // The PANEL's own files sector renders: heading + one row per changed path,
    // all inside the panel's single scrolling content region.
    const content = query(fixture, 'commit-details-content')!;
    const heading = query(fixture, 'commit-details-files-heading')!;
    expect(heading.textContent?.trim()).toBe('2 changed files');
    expect(content.contains(heading)).toBe(true);
    const rows = all(fixture, 'commit-details-file-path');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent?.trim())).toEqual(['a.ts', 'b.ts']);
    expect(rows.every((row) => content.contains(row))).toBe(true);
    // The page's old summary and diff list are gone from the commit variant.
    expect(query(fixture, 'file-status-summary')).toBeNull();
    expect(fixture.nativeElement.querySelector('st-file-diff-list')).toBeNull();

    // Switching back restores the description sector.
    query(fixture, 'commit-details-view-switch')!
      .querySelector<HTMLButtonElement>('[data-testid="toggle-segment-description"]')!
      .click();
    fixture.detectChanges();
    expect(viewMode.mode()).toBe('description');
    expect(query(fixture, 'commit-details-description')).not.toBeNull();
    expect(query(fixture, 'commit-details-files-heading')).toBeNull();
  });

  it('renders exactly one sector at a time with the switch inside the panel header', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    const viewSwitch = query(fixture, 'commit-details-view-switch')!;
    expect(
      (fixture.nativeElement.querySelector('st-commit-details-panel') as HTMLElement).contains(
        viewSwitch,
      ),
    ).toBe(true);
    expect(viewSwitch.querySelector('[data-testid="toggle-segment-description"]')).not.toBeNull();
    expect(viewSwitch.querySelector('[data-testid="toggle-segment-files"]')).not.toBeNull();
    // The old right-pane switch is gone.
    expect(query(fixture, 'file-status-view-switch')).toBeNull();

    const bodyVisible = () => query(fixture, 'commit-details-description') !== null;
    const listVisible = () => query(fixture, 'commit-details-files-heading') !== null;
    // Description mode: body XOR files sector.
    expect(bodyVisible() && listVisible()).toBe(false);
    expect(bodyVisible() || listVisible()).toBe(true);

    viewSwitch.querySelector<HTMLButtonElement>('[data-testid="toggle-segment-files"]')!.click();
    fixture.detectChanges();
    // Files mode: still exactly one of the two, and it is the files sector.
    expect(bodyVisible() && listVisible()).toBe(false);
    expect(bodyVisible() || listVisible()).toBe(true);
    expect(listVisible()).toBe(true);
  });

  it('keeps description mode for a subject-only commit (the subject is the content)', async () => {
    const subjectOnly = commit(HEAD_HEX, [OTHER_HEX], 'subject only, no body');
    const { fixture, fs } = await setup({
      selection: HEAD_HEX,
      commits: () => [subjectOnly, commit(OTHER_HEX)],
    });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    const panel = panelOf(fixture);
    // A subject-only message still HAS a message: the body is empty, but the
    // subject IS the description content, so the default `description` mode
    // stays and the segment is never a dead control.
    expect(panel.description()).toBe('');
    expect(panel.effectiveMode()).toBe('description');

    // The panel renders the subject; there is no body element.
    expect(query(fixture, 'commit-details-subject')?.textContent?.trim()).toBe(
      'subject only, no body',
    );
    expect(query(fixture, 'commit-details-description')).toBeNull();

    const viewSwitch = query(fixture, 'commit-details-view-switch')!;
    const description = viewSwitch.querySelector<HTMLButtonElement>(
      '[data-testid="toggle-segment-description"]',
    )!;
    expect(description.disabled).toBe(false);
    expect(description.getAttribute('aria-pressed')).toBe('true');

    // Exactly one sector: the panel's files sector is absent.
    expect(query(fixture, 'commit-details-files-heading')).toBeNull();

    // Files mode is one click away, and description comes straight back.
    viewSwitch.querySelector<HTMLButtonElement>('[data-testid="toggle-segment-files"]')!.click();
    fixture.detectChanges();
    expect(panel.effectiveMode()).toBe('files');
    expect(query(fixture, 'commit-details-files-heading')).not.toBeNull();
    query(fixture, 'commit-details-view-switch')!
      .querySelector<HTMLButtonElement>('[data-testid="toggle-segment-description"]')!
      .click();
    fixture.detectChanges();
    expect(panel.effectiveMode()).toBe('description');
    expect(query(fixture, 'commit-details-files-heading')).toBeNull();
  });

  it('shows the body when the commit subject is empty (never neither sector)', async () => {
    // A message that starts with a blank line splits to an empty subject and a
    // real body. Keying the description on the subject alone would hide BOTH
    // sectors at once (no switch escape would be meaningful, no file list either).
    const emptySubject = commit(HEAD_HEX, [OTHER_HEX], '\n\nbody only, no subject');
    const { fixture, fs } = await setup({
      selection: HEAD_HEX,
      commits: () => [emptySubject, commit(OTHER_HEX)],
    });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    const panel = panelOf(fixture);
    // A body-only message still HAS a message: the subject is empty, but the
    // body must stay reachable, so the description mode is not forced away.
    expect(panel.subject()).toBe('');
    expect(panel.description()).toBe('body only, no subject');
    expect(panel.effectiveMode()).toBe('description');

    // The panel omits the empty subject heading and renders only the body, so
    // the description sector is not empty.
    expect(query(fixture, 'commit-details-subject')).toBeNull();
    const body = query(fixture, 'commit-details-description');
    expect(body?.textContent?.trim()).toBe('body only, no subject');

    // Exactly one sector: the panel's files sector is absent.
    expect(query(fixture, 'commit-details-files-heading')).toBeNull();

    // One click reaches the files sector and its list.
    query(fixture, 'commit-details-view-switch')!
      .querySelector<HTMLButtonElement>('[data-testid="toggle-segment-files"]')!
      .click();
    fixture.detectChanges();
    expect(panel.effectiveMode()).toBe('files');
    expect(query(fixture, 'commit-details-description')).toBeNull();
    expect(query(fixture, 'commit-details-files-heading')).not.toBeNull();
  });

  it('forces files mode for a message-less commit (disabled description segment)', async () => {
    const messageLess = commit(HEAD_HEX, [OTHER_HEX], '');
    const { fixture, fs } = await setup({
      selection: HEAD_HEX,
      commits: () => [messageLess, commit(OTHER_HEX)],
    });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    // Nothing to describe: `files` is forced so the list is the visible sector.
    const panel = panelOf(fixture);
    expect(panel.subject()).toBe('');
    expect(panel.description()).toBe('');
    expect(query(fixture, 'file-status-title')).toBeNull();
    expect(panel.effectiveMode()).toBe('files');

    // The panel still renders the switch, but its description segment is
    // disabled: a body-less description view adds nothing.
    const viewSwitch = query(fixture, 'commit-details-view-switch');
    expect(viewSwitch).not.toBeNull();
    expect(
      viewSwitch!.querySelector<HTMLButtonElement>('[data-testid="toggle-segment-description"]')
        ?.disabled,
    ).toBe(true);
    expect(query(fixture, 'commit-details-description')).toBeNull();
    expect(query(fixture, 'commit-details-files-heading')).not.toBeNull();
    expect(all(fixture, 'commit-details-file-path')).toHaveLength(2);
  });

  it('shares the mode with the embedded panel through the route-scoped service', async () => {
    const { fixture, fs, viewMode } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    const details = fixture.debugElement.query(By.css('st-commit-details-panel'))
      ?.componentInstance as CommitDetailsPanel;
    // Both hosts read the same service: no separate component-local state.
    expect(details.mode()).toBe('description');
    expect(details.showViewSwitch()).toBe(true);

    viewMode.setMode('files');
    fixture.detectChanges();

    expect(details.mode()).toBe('files');
    expect(details.effectiveMode()).toBe('files');
    // The panel owns the files block in the analyzer too (no page list).
    expect(details.showFiles()).toBe(true);
    expect(query(fixture, 'commit-details-files-heading')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('st-file-diff-list')).toBeNull();

    viewMode.setMode('description');
    fixture.detectChanges();
    expect(details.mode()).toBe('description');
    expect(query(fixture, 'commit-details-files-heading')).toBeNull();
  });

  it('wires the commit-variant panel to the redesigned contract', async () => {
    const { fixture, fs, graph } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    const panel = fixture.debugElement.query(By.css('st-commit-details-panel'))
      ?.componentInstance as CommitDetailsPanel;
    expect(panel.commit()?.oid?.hex).toBe(HEAD_HEX);
    expect(panel.isWip()).toBe(false);
    // The panel owns the WHOLE commit view: description AND files sector.
    expect(panel.showSubject()).toBe(true);
    expect(panel.showFiles()).toBe(true);
    // The rows are selectable so the right pane can project the picked file.
    expect(panel.filesSelectable()).toBe(true);
    expect(panel.selectedPath()).toBeNull();
    // The header switch is wired to the shared mode.
    expect(panel.showViewSwitch()).toBe(true);
    expect(panel.mode()).toBe('description');
    // The switch's file count comes from the active commit's diff.
    expect(panel.changedFiles()).toEqual(['a.ts', 'b.ts']);
    // The commit variant's contextual action follows the commit into History:
    // the release/Close control is not rendered there.
    expect(panel.navMode()).toBe('history');
    expect(query(fixture, 'commit-details-release')).toBeNull();
    expect(query(fixture, 'commit-details-history')).not.toBeNull();
    expect(panel.showInGraph()).toBe(true);
    // The padlock reflects the shared graph lock.
    expect(panel.locked()).toBe(false);
    graph.lock();
    fixture.detectChanges();
    expect(panel.locked()).toBe(true);
  });

  it('toggles and releases the graph lock from the commit panel', async () => {
    const { fixture, fs, graph } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    const page = fixture.componentInstance;
    page.toggleLock();
    expect(graph.lockedOid()).toBe(HEAD_HEX);
    page.toggleLock();
    expect(graph.lockedOid()).toBeNull();

    // Release drops the lock AND the selection; the follow effect re-opens local.
    page.toggleLock();
    page.releaseCommit();
    expect(graph.lockedOid()).toBeNull();
    expect(graph.selectedOid()).toBeNull();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
  });

  it('lands on the local variant for the WIP pseudo-oid', async () => {
    const { fixture, fs } = await setup({ selection: WIP_OID });

    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    expect(fs.activeCommit()).toBeNull();
    expect(query(fixture, 'commit-details')).toBeNull();
  });

  it('lands on the local variant when nothing is selected', async () => {
    const { fixture, fs } = await setup({ selection: null });

    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    expect(fs.activeCommit()).toBeNull();
    expect(query(fixture, 'commit-details')).toBeNull();
  });

  it('follows a selection change while the page is open', async () => {
    const { fixture, fs, graph } = await setup({ selection: HEAD_HEX });
    await vi.waitFor(() => expect(fs.activeCommit()?.oid?.hex).toBe(HEAD_HEX));

    graph.select(OTHER_HEX);
    fixture.detectChanges();
    await fixture.whenStable();

    await vi.waitFor(() => expect(fs.activeCommit()?.oid?.hex).toBe(OTHER_HEX));
    expect(fs.variant()).toBe('commit');
  });

  it('keeps an explicit local variant when a reload replaces commits() for the same oid', async () => {
    // The bug: staging fires fs:changed -> graph.reload() -> commits() becomes a
    // NEW array that still names the selected commit. The original effect treated
    // that as a fresh selection and re-opened the commit, flipping the variant
    // bar from `local` to `commit`. Staging must never change the variant.
    const { fixture, fs, emitFsChanged } = await setup({
      selection: HEAD_HEX,
      commits: () => [commit(HEAD_HEX, [OTHER_HEX]), commit(OTHER_HEX)],
    });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    // The user moves to the working tree and starts staging.
    all(fixture, 'toggle-segment-local')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));

    emitFsChanged();
    // Settle the reload so `commits()` is genuinely replaced before the effect
    // re-runs with the new array reference.
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fs.variant()).toBe('local');
  });

  it('still follows a genuinely new graph selection into the commit variant', async () => {
    const { fixture, fs, graph } = await setup({
      selection: HEAD_HEX,
      commits: () => [commit(HEAD_HEX, [OTHER_HEX]), commit(OTHER_HEX)],
    });
    await vi.waitFor(() => expect(fs.activeCommit()?.oid?.hex).toBe(HEAD_HEX));

    // A resolved selection change is the one case the dedupe must NOT swallow.
    graph.select(OTHER_HEX);
    fixture.detectChanges();
    await fixture.whenStable();

    await vi.waitFor(() => expect(fs.activeCommit()?.oid?.hex).toBe(OTHER_HEX));
    expect(fs.variant()).toBe('commit');
  });

  it('defers a graph selection until its commit loads, then follows it exactly once', async () => {
    const PENDING_HEX = 'c'.repeat(40);
    // The graph names a commit the loaded window does not contain yet (the
    // open-commit deep-link focus): the screen cannot resolve it and must
    // not wedge on the working tree.
    const { fixture, fs, graph } = await setup({
      selection: PENDING_HEX,
      commits: () => [commit(HEAD_HEX, [OTHER_HEX]), commit(OTHER_HEX)],
    });
    const openCommit = vi.spyOn(fs, 'openCommit');
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    expect(openCommit).not.toHaveBeenCalled();

    // The window that names the selected commit arrives: the deferred follow runs.
    graph.commits.set([commit(PENDING_HEX), commit(HEAD_HEX, [OTHER_HEX]), commit(OTHER_HEX)]);
    fixture.detectChanges();
    await fixture.whenStable();

    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    expect(fs.activeCommit()?.oid?.hex).toBe(PENDING_HEX);
    expect(openCommit).toHaveBeenCalledTimes(1);
  });

  it('returns to local when the selection resolves to WIP and stays there across a reload', async () => {
    const { fixture, fs, graph, emitFsChanged } = await setup({
      selection: HEAD_HEX,
      commits: () => [commit(HEAD_HEX, [OTHER_HEX]), commit(OTHER_HEX)],
    });
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    graph.select(WIP_OID);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));

    // A background reload with WIP still selected must not re-open the previous
    // commit (nothing/WIP resolves to `null`, distinct from the old oid).
    emitFsChanged();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fs.variant()).toBe('local');
  });

  it('keeps the commit variant alive when the locked row falls out of the window', async () => {
    const { fixture, fs, graph } = await setup({
      selection: HEAD_HEX,
      commits: () => [commit(HEAD_HEX, [OTHER_HEX]), commit(OTHER_HEX)],
    });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    const openCommit = vi.spyOn(fs, 'openCommit');
    // Pin the commit; its `Commit` object is captured in the lock.
    graph.lock();
    expect(graph.lockedCommit()?.oid?.hex).toBe(HEAD_HEX);

    // A reload replaces the window WITHOUT the pinned commit. The follow effect
    // must resolve through the lock (not `commits().find`) and leave the commit
    // variant standing instead of flipping back to the working tree.
    graph.commits.set([commit(OTHER_HEX)]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fs.variant()).toBe('commit');
    expect(fs.activeCommit()?.oid?.hex).toBe(HEAD_HEX);
    expect(openCommit).not.toHaveBeenCalled();
  });

  it('makes the panel the commit column’s sole scroller, with the file rows inside its content', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    // The file rows live in the panel's files sector; the default is
    // description, so switch first (from the panel's own header).
    query(fixture, 'commit-details-view-switch')!
      .querySelector<HTMLButtonElement>('[data-testid="toggle-segment-files"]')!
      .click();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const body = host.querySelector('.st-file-status__body--commit');
    const details = host.querySelector('st-commit-details-panel');
    const content = query(fixture, 'commit-details-content');
    const footer = query(fixture, 'commit-details-footer');
    const heading = query(fixture, 'commit-details-files-heading');
    expect(body).not.toBeNull();
    expect(details).not.toBeNull();
    expect(content).not.toBeNull();
    expect(footer).not.toBeNull();

    // The panel is the column's ONLY child: no summary, no page file list.
    expect(details!.parentElement).toBe(body);
    expect(body!.children).toHaveLength(1);
    expect(query(fixture, 'file-status-summary')).toBeNull();
    expect(host.querySelector('st-file-diff-list')).toBeNull();

    // The panel stretches and owns the scroll; the body must not scroll too.
    expect(getComputedStyle(details as Element).flexGrow).toBe('1');
    expect(getComputedStyle(details as Element).maxHeight).not.toBe('50%');
    expect(getComputedStyle(body as Element).overflow).toBe('hidden');

    // The LEFT COLUMN grows too: otherwise the column is content-sized, the
    // panel's `flex: 1` has no free space to grow into, and the metadata
    // footer would sit right under the message instead of at the bottom of
    // the pane (History's distribution).
    const left = host.querySelector('.st-file-status__left');
    expect(left).not.toBeNull();
    expect(getComputedStyle(left as Element).flexGrow).toBe('1');

    // The changed-file rows live INSIDE the panel's content region, under the
    // heading, while the metadata footer stays its sibling (History's order).
    const rows = all(fixture, 'commit-details-file-path');
    expect(rows).toHaveLength(2);
    expect(heading).not.toBeNull();
    expect(content!.contains(heading!)).toBe(true);
    rows.forEach((row) => {
      expect(content!.contains(row)).toBe(true);
    });
    expect(content!.contains(footer!)).toBe(false);
    expect(details!.contains(footer!)).toBe(true);
    expect(
      content!.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('switches variant from the variant bar', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);

    all(fixture, 'toggle-segment-pr')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('pr'));
    await vi.waitFor(() => expect(fs.baseRef()).toBe('main'));
    fixture.detectChanges();
    expect(fs.targetRef()).toBe('develop');

    all(fixture, 'toggle-segment-local')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
  });

  it('badges the Local segment with the pending (unstaged) file count only', async () => {
    const { fixture, fs } = await setup({
      selection: WIP_OID,
      files: [file('a.ts', false), file('b.ts', false), file('c.ts', true)],
    });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));

    // Two pending files, one staged: staged files never count toward the badge.
    expect(fs.unstagedFiles().map((pending) => pending.path)).toEqual(['a.ts', 'b.ts']);
    expect(fs.stagedFiles().map((staged) => staged.path)).toEqual(['c.ts']);

    const badge = query(fixture, 'toggle-segment-local')?.querySelector(
      '[data-testid="toggle-segment-count"]',
    );
    expect(badge?.textContent?.trim()).toBe('2');
  });

  it('feeds the viewer the PROJECTED single-file diff, never the whole diff', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    fs.selectFile('a.ts');
    fixture.detectChanges();

    const diff = viewer(fixture).diff();
    expect(diff?.files).toHaveLength(1);
    expect(diff?.files?.[0].path).toBe('a.ts');
    expect(diff?.additions).toBe(6);
    expect(diff?.deletions).toBe(2);
    // Only the selected file's hunks reach the deprecated flat field.
    expect(diff?.hunks).toHaveLength(1);
    expect(diff?.hunks?.[0].lines[0].text).toBe('a-line');
  });

  it('re-projects the right pane when a panel file row is clicked', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    // The file rows live in the panel's files sector; the default is description.
    query(fixture, 'commit-details-view-switch')!
      .querySelector<HTMLButtonElement>('[data-testid="toggle-segment-files"]')!
      .click();
    fixture.detectChanges();

    const rows = all(fixture, 'commit-details-file-path');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual(['a.ts', 'b.ts']);
    rows[1].click();
    fixture.detectChanges();

    expect(fs.selectedPath()).toBe('b.ts');
    const diff = viewer(fixture).diff();
    expect(diff?.files?.[0].path).toBe('b.ts');
    expect(diff?.hunks?.[0].lines[0].text).toBe('b-line');
    expect(rows[1].getAttribute('data-selected')).toBe('true');
  });

  it('mounts the diff-mode toggle in the diff (primary) pane once a file is selected', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);

    fs.selectFile('a.ts');
    await settle(fixture);

    const primary = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="workspace-primary"]',
    );
    const toggle = query(fixture, 'diff-mode-toggle');
    expect(primary).not.toBeNull();
    expect(toggle).not.toBeNull();
    expect(primary!.contains(toggle!)).toBe(true);
    assertDiffOnRight(fixture);
  });

  it('flips the diff-mode preference from the pane toggle', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    const diffMode = TestBed.inject(DiffModeService);
    await waitForDiff(fixture, fs);

    fs.selectFile('a.ts');
    await settle(fixture);

    // Unified is the default: the viewer starts without side-by-side.
    expect(diffMode.mode()).toBe('unified');
    expect(viewer(fixture).renderSideBySide()).toBe(false);

    all(fixture, 'toggle-segment-side-by-side')[0].click();
    await settle(fixture);

    expect(diffMode.mode()).toBe('side-by-side');
    // The viewer reads the shared preference through the diff-mode service.
    expect(viewer(fixture).renderSideBySide()).toBe(true);

    all(fixture, 'toggle-segment-unified')[0].click();
    await settle(fixture);

    expect(diffMode.mode()).toBe('unified');
    expect(viewer(fixture).renderSideBySide()).toBe(false);
  });

  it('populates the PR base/target controls from the loaded branches', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);

    all(fixture, 'toggle-segment-pr')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('pr'));
    await vi.waitFor(() => expect(fs.branches().length).toBe(3));
    fixture.detectChanges();

    expect(fs.branches().map((branch) => branch.name)).toEqual(['origin/main', 'main', 'develop']);
    // The target is the st-select primitive: query its inner `<select>`.
    const target = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(
      '.st-select',
    );
    expect(target).not.toBeNull();
    const options = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLOptionElement>(
      '.st-select option',
    );
    expect(Array.from(options).map((option) => option.value)).toEqual([
      'origin/main',
      'main',
      'develop',
    ]);
    // The base is editable: it carries the resolved default and accepts a ref.
    const base = query<HTMLInputElement>(fixture, 'pr-base-input');
    expect(base?.value).toBe('main');
    base!.value = 'develop';
    base!.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(fs.baseRef()).toBe('develop'));
  });

  it('reloads the graph when a commit requests it', async () => {
    const { fixture, fs, status, reload } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);

    status.graphReloadRequested.set(1);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(reload).toHaveBeenCalled();
  });

  it('drops the page summary from the commit variant but keeps it in the PR variant', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    // Files mode in the commit variant: the panel's own heading carries the
    // count; the page summary is gone (History's distribution).
    query(fixture, 'commit-details-view-switch')!
      .querySelector<HTMLButtonElement>('[data-testid="toggle-segment-files"]')!
      .click();
    fixture.detectChanges();

    expect(query(fixture, 'file-status-summary')).toBeNull();
    expect(query(fixture, 'commit-details-files-heading')?.textContent?.trim()).toBe(
      '2 changed files',
    );

    // The PR variant keeps the page summary and file list untouched.
    all(fixture, 'toggle-segment-pr')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('pr'));
    await vi.waitFor(() => expect(fs.commitDiff()).not.toBeNull());
    fixture.detectChanges();

    expect(query(fixture, 'file-status-summary')?.textContent?.trim()).toBe(
      '+10 \u22124 across 2 files',
    );
    expect(fixture.nativeElement.querySelector('st-file-diff-list')).not.toBeNull();
  });

  it('refreshes the working tree on fs:changed but never the commit diff', async () => {
    const { fixture, fs, getDiff, emitFsChanged } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    const before = getDiff.mock.calls.length;

    // The commit variant keeps its historical diff untouched.
    emitFsChanged();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(getDiff.mock.calls.length).toBe(before);

    // The local variant is the one the working-tree refresh invalidates.
    all(fixture, 'toggle-segment-local')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    const localCalls = getDiff.mock.calls.length;

    emitFsChanged();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(getDiff.mock.calls.length).toBeGreaterThan(localCalls);
    expect(fs.variant()).toBe('local');
  });

  it('renders the working-tree panel unchanged in the local variant', async () => {
    const { fixture, fs } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);

    // The changes panel is reused verbatim: its own testids, its own markup.
    expect(query(fixture, 'status-file')).not.toBeNull();
    expect(query(fixture, 'commit-message-input')).not.toBeNull();
    expect(fs.unstagedFiles().map((file) => file.path)).toEqual(['a.ts']);
  });

  it('keeps the file selection across a working-tree refresh', async () => {
    const { fixture, fs, emitFsChanged } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);
    all(fixture, 'status-file')[0].click();
    expect(fs.selectedPath()).toBe('a.ts');

    emitFsChanged();
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    fixture.detectChanges();

    expect(query(fixture, 'status-file')?.classList.contains('st-changes__row--selected')).toBe(
      true,
    );
  });

  it('clears the variant on destroy', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);

    fixture.destroy();

    expect(fs.variant()).toBe('local');
    expect(fs.activeCommit()).toBeNull();
  });

  it('keeps the diff pane on the RIGHT in every variant (never swapped left)', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);

    // Commit variant: the commit header is the left column, the diff follows.
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    assertDiffOnRight(fixture);

    // PR variant.
    all(fixture, 'toggle-segment-pr')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('pr'));
    await vi.waitFor(() => expect(fs.baseRef()).toBe('main'));
    fixture.detectChanges();
    assertDiffOnRight(fixture);

    // Local variant.
    all(fixture, 'toggle-segment-local')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    await vi.waitFor(() => expect(fs.wholeDiff()).not.toBeNull());
    fixture.detectChanges();
    assertDiffOnRight(fixture);

    // Switching back to the commit variant keeps the diff on the right too.
    all(fixture, 'toggle-segment-commit')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();
    assertDiffOnRight(fixture);
  });

  it('selects the resolved commit when the commit segment is chosen with no graph selection', async () => {
    const { fixture, fs, graph } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    // Release drops the lock AND the selection but retains `activeCommit`; the
    // user then picks the commit segment directly.
    fixture.componentInstance.releaseCommit();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    expect(graph.selectedOid()).toBeNull();

    all(fixture, 'toggle-segment-commit')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    // Choosing the segment selects the commit it opens, so the padlock has a
    // real oid to pin instead of silently no-opping.
    expect(graph.selectedOid()).toBe(HEAD_HEX);
    graph.lock();
    expect(graph.lockedOid()).toBe(HEAD_HEX);
  });

  it('opens the locked commit, not a stale active commit, when the commit segment is chosen', async () => {
    const { fixture, fs, graph } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    // Pin HEAD, then let a different commit become the stale active one.
    graph.lock();
    await fs.openCommit(commit(OTHER_HEX));
    expect(fs.activeCommit()?.oid?.hex).toBe(OTHER_HEX);

    fixture.componentInstance.onVariantChange('commit');
    await vi.waitFor(() => expect(fs.activeCommit()?.oid?.hex).toBe(HEAD_HEX));

    // The locked commit is opened and, because a lock already exists, it is
    // already the selection — no (refused) re-select.
    expect(graph.lockedOid()).toBe(HEAD_HEX);
    expect(graph.selectedOid()).toBe(HEAD_HEX);
  });

  it('falls back to the working tree when the commit variant has no active commit', async () => {
    const { fixture, fs } = await setup({ selection: null });
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));

    // No active commit and no graph selection: onVariantChange('commit') resolves
    // to nothing and must fall back to the working tree, not open an empty screen.
    all(fixture, 'toggle-segment-commit')[0].click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fs.variant()).toBe('local');
    expect(fs.activeCommit()).toBeNull();
    assertDiffOnRight(fixture);
  });

  it('projects the selected worktree file, never the whole diff, in the local variant', async () => {
    const { fixture, fs } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);

    fs.selectFile('b.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('b.ts'));
    await settle(fixture);

    const diff = viewer(fixture).diff();
    expect(diff?.files).toHaveLength(1);
    expect(diff?.files?.[0].path).toBe('b.ts');
    // The selected file's own counts, not the whole worktree diff's (10/4).
    expect(diff?.additions).toBe(4);
    expect(diff?.deletions).toBe(2);
  });

  it('renders the PR changed-file list and projects the clicked file into the viewer', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);

    all(fixture, 'toggle-segment-pr')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('pr'));
    await vi.waitFor(() => expect(fs.commitDiff()).not.toBeNull());
    fixture.detectChanges();

    // The changed-file rows render, carrying every path from the PR diff files.
    const rows = all(fixture, 'file-diff-row');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual(['a.ts', 'b.ts']);
    // The PR change summary comes from commitChangeSummary.
    expect(query(fixture, 'file-status-summary')?.textContent?.trim()).toBe(
      '+10 \u22124 across 2 files',
    );

    // Clicking a file projects THAT file into the viewer — not the whole PR diff.
    rows[0].click();
    fixture.detectChanges();
    const diff = viewer(fixture).diff();
    expect(diff?.files).toHaveLength(1);
    expect(diff?.files?.[0].path).toBe('a.ts');
    expect(diff?.additions).toBe(6);
    expect(diff?.deletions).toBe(2);
  });

  it('forwards inline hunk actions by indices only, never a patch (ADR-0020)', async () => {
    const { fixture, fs, stageHunk, discardHunk } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);
    all(fixture, 'status-file')[0].click();
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    await settle(fixture);
    const page = fixture.componentInstance;

    // Select line 0, discard (the payload carries the selection), then reselect
    // and stage: each action clears its hunk's selection afterwards.
    page.onHunkLineToggle({ hunkIndex: 0, lineIndex: 0 });
    page.onHunkAction({ hunkIndex: 0, actionKey: 'discard' });
    page.onHunkLineToggle({ hunkIndex: 0, lineIndex: 0 });
    page.onHunkAction({ hunkIndex: 0, actionKey: 'stage' });

    await vi.waitFor(() => {
      expect(stageHunk).toHaveBeenCalledTimes(1);
      expect(discardHunk).toHaveBeenCalledTimes(1);
    });

    // The exact ADR-0020 payload — every field, lineIndices included.
    expect(lastPayload(discardHunk)).toEqual({
      repoId: 'repo-1',
      path: 'a.ts',
      hunkIndex: 0,
      lineIndices: [0],
    });
    expect(lastPayload(stageHunk)).toEqual({
      repoId: 'repo-1',
      path: 'a.ts',
      hunkIndex: 0,
      lineIndices: [0],
    });

    for (const mock of [stageHunk, discardHunk]) {
      // Exactly the four allowed keys — no dropped/extra keys.
      expect(Object.keys(lastPayload(mock)).sort()).toEqual([
        'hunkIndex',
        'lineIndices',
        'path',
        'repoId',
      ]);
      // The renderer NEVER builds a patch: no unified-diff markers on the wire.
      const payload = JSON.stringify(lastPayload(mock));
      expect(payload).not.toContain('+++');
      expect(payload).not.toContain('@@');
      expect(payload).not.toContain('diff --git');
    }
  });

  it('renders the page-supplied inline hunk actions and forwards a click', async () => {
    const { fixture, fs, stageHunk } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);

    all(fixture, 'status-file')[0].click();
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    await settle(fixture);

    const page = fixture.componentInstance;
    expect(page.hunkActionSlots()).toHaveLength(1);
    expect(page.hunkActionSlots()?.[0].hunkIndex).toBe(0);

    // The viewer owns the inline-action grid: one button per hunk action.
    expect(query(fixture, 'diff-fallback')).not.toBeNull();
    const buttons = all(fixture, 'diff-hunk-action');
    expect(buttons.map((button) => button.getAttribute('data-action'))).toEqual([
      'stage',
      'discard',
    ]);

    buttons[0].click();
    await vi.waitFor(() => expect(stageHunk).toHaveBeenCalledTimes(1));
    expect(lastPayload(stageHunk)).toEqual({
      repoId: 'repo-1',
      path: 'a.ts',
      hunkIndex: 0,
      lineIndices: [],
    });
  });

  it('toggles a changed line and addresses the hunk by the selected line indices', async () => {
    const { fixture, fs, stageHunk } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);

    all(fixture, 'status-file')[0].click();
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    await settle(fixture);

    // The only changed line of a.ts carries lineIndex 0.
    const checkbox = all(fixture, 'diff-hunk-line')[0] as HTMLInputElement;
    expect(checkbox).not.toBeUndefined();
    expect(checkbox.getAttribute('data-line')).toBe('0');

    checkbox.click();
    await settle(fixture);

    const page = fixture.componentInstance;
    expect(page.hunkActionSlots()?.[0].selectedLines).toEqual([0]);

    all(fixture, 'diff-hunk-action')[0].click();
    await vi.waitFor(() => expect(stageHunk).toHaveBeenCalledTimes(1));
    expect(lastPayload(stageHunk)).toEqual({
      repoId: 'repo-1',
      path: 'a.ts',
      hunkIndex: 0,
      lineIndices: [0],
    });

    // The action clears the hunk's selection so the next one starts fresh.
    await settle(fixture);
    expect(page.hunkActionSlots()?.[0].selectedLines).toEqual([]);
  });

  it('clears the per-hunk line selection when the selected file changes', async () => {
    const { fixture, fs } = await setup({
      selection: WIP_OID,
      files: [file('a.ts', false), file('b.ts', false)],
    });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));

    const page = fixture.componentInstance;
    fs.selectFile('a.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    await settle(fixture);

    page.onHunkLineToggle({ hunkIndex: 0, lineIndex: 0 });
    expect(page.hunkActionSlots()?.[0].selectedLines).toEqual([0]);

    // Switching files must not carry a.ts's checked lines onto b.ts: a Discard
    // would otherwise destroy lines the user never selected on THIS file.
    fs.selectFile('b.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('b.ts'));
    await settle(fixture);

    expect(page.hunkActionSlots()?.[0].selectedLines).toEqual([]);
  });

  it('clears the ENTIRE hunk selection map after a hunk action (the diff re-indexes)', async () => {
    const twoHunks: Diff = {
      ...wholeDiff(),
      files: [{ ...fileDiff('a.ts', 6, 2, 'a-line'), hunks: [hunk('a-line'), hunk('a-line-2')] }],
    };
    const { fixture, fs } = await setup({ selection: WIP_OID, diff: () => twoHunks });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));

    const page = fixture.componentInstance;
    fs.selectFile('a.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    await settle(fixture);

    // Both hunks carry a selected line.
    page.onHunkLineToggle({ hunkIndex: 0, lineIndex: 0 });
    page.onHunkLineToggle({ hunkIndex: 1, lineIndex: 0 });
    expect(page.hunkActionSlots()?.[0].selectedLines).toEqual([0]);
    expect(page.hunkActionSlots()?.[1].selectedLines).toEqual([0]);

    // The action re-indexes EVERY hunk, so the untouched hunk's stale index is
    // cleared too — not only the acted-on one.
    page.onHunkAction({ hunkIndex: 0, actionKey: 'stage' });
    expect(page.hunkActionSlots()?.[0].selectedLines).toEqual([]);
    expect(page.hunkActionSlots()?.[1].selectedLines).toEqual([]);
  });

  it('hides the diff-mode toggle while inline hunk actions are supplied', async () => {
    const { fixture, fs } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);

    all(fixture, 'status-file')[0].click();
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    await settle(fixture);

    // The inline grid ignores side-by-side, so the inert layout toggle is gone.
    expect(query(fixture, 'diff-mode-toggle')).toBeNull();
    expect(all(fixture, 'diff-hunk-action').length).toBeGreaterThan(0);
  });

  it('heads the local column with the locked commit, above the changes panel', async () => {
    const { fixture, fs, graph } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    // Pin the commit, then move to the working tree: the pinned section stays.
    graph.lock();
    all(fixture, 'toggle-segment-local')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    fixture.detectChanges();

    expect(graph.lockedCommit()?.oid?.hex).toBe(HEAD_HEX);
    const panel = fixture.debugElement
      .queryAll(By.css('st-commit-details-panel'))[0]
      .componentInstance as CommitDetailsPanel;
    expect(panel.commit()?.oid?.hex).toBe(HEAD_HEX);
    expect(panel.navMode()).toBe('release');
    expect(panel.locked()).toBe(true);
    expect(panel.showInGraph()).toBe(true);

    // The section sits ABOVE the changes panel in the local column.
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('st-commit-details-panel');
    const changes = host.querySelector('st-changes-panel');
    expect(section).not.toBeNull();
    expect(changes).not.toBeNull();
    expect(
      section!.compareDocumentPosition(changes!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(host.querySelector('.st-file-status__body--local')).not.toBeNull();
  });

  it('offers the History shortcut in the unlocked local commit section', async () => {
    const { fixture, fs } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    fixture.detectChanges();

    const panel = fixture.debugElement
      .queryAll(By.css('st-commit-details-panel'))[0]
      .componentInstance as CommitDetailsPanel;
    expect(panel.commit()).toBeNull();
    expect(panel.navMode()).toBe('history');
    expect(panel.locked()).toBe(false);

    // The empty branch renders with the History shortcut (one click to pick).
    expect(query(fixture, 'commit-details-empty')).not.toBeNull();
    expect(query(fixture, 'commit-details-history')).not.toBeNull();
    // The bottom-pinning class is commit-only; the local column is not pinned.
    expect((fixture.nativeElement as HTMLElement).querySelector('.st-file-status__body--commit')).toBeNull();
  });

  it('navigates to History and hands the commit focus over to reveal it in the graph', async () => {
    const { fixture, fs, router, commitFocus } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    const page = fixture.componentInstance;
    page.goHistory();
    expect(router.navigate).toHaveBeenCalledWith(['/repo']);
    // The analyzer's History control follows the commit in view.
    expect(commitFocus.pending()).toEqual({ repoId: 'repo-1', oid: HEAD_HEX });

    page.showInGraph();
    // The focus hand-off lets RepoPage page to a commit outside the window.
    expect(commitFocus.pending()).toEqual({ repoId: 'repo-1', oid: HEAD_HEX });
    expect(router.navigate).toHaveBeenLastCalledWith(['/repo']);
  });

  it('follows the commit when the analyzer History control is clicked', async () => {
    const { fixture, fs, router, commitFocus } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    fixture.detectChanges();

    // The commit variant renders the History control, never the release/Close one.
    expect(query(fixture, 'commit-details-release')).toBeNull();
    const history = query(fixture, 'commit-details-history');
    expect(history).not.toBeNull();

    history!.querySelector('button')!.click();
    fixture.detectChanges();

    expect(commitFocus.pending()).toEqual({ repoId: 'repo-1', oid: HEAD_HEX });
    expect(router.navigate).toHaveBeenLastCalledWith(['/repo']);
  });

  it('navigates without a focus request when there is no commit to follow', async () => {
    const { fixture, fs, router, commitFocus } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    fixture.detectChanges();

    // The local variant's empty branch renders the same History shortcut.
    expect(query(fixture, 'commit-details-history')).not.toBeNull();

    fixture.componentInstance.goHistory();

    expect(commitFocus.pending()).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('does not follow a stale commit after the analyzer switched back to the working tree', async () => {
    const { fixture, fs, router, commitFocus } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));

    // View a commit, then go back to the working tree: the store keeps the
    // last viewed commit in `activeCommit()`, but nothing is in view anymore.
    all(fixture, 'toggle-segment-local')[0].click();
    await vi.waitFor(() => expect(fs.variant()).toBe('local'));
    fixture.detectChanges();

    fixture.componentInstance.goHistory();

    // Following a commit the user is no longer looking at would select it in
    // the graph behind their back.
    expect(commitFocus.pending()).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith(['/repo']);
  });

  it('reloads the graph window when the working tree changes externally', async () => {
    const { fixture, fs, reload, emitFsChanged } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);
    reload.mockClear();

    emitFsChanged();
    // The fs:changed handler calls graph.reload() synchronously, so HEAD/the
    // graph window do not go stale on screen.
    expect(reload).toHaveBeenCalledTimes(1);

    fixture.detectChanges();
    await fixture.whenStable();
    expect(fs.variant()).toBe('local');
  });

  it('refreshes the working tree on a status refresh, keeping the selected file', async () => {
    const { fixture, fs, reload, repoState } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);
    all(fixture, 'status-file')[0].click();
    expect(fs.selectedPath()).toBe('a.ts');
    reload.mockClear();

    repoState.statusRefreshRequested.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    expect(fs.variant()).toBe('local');
    // The local variant re-opens asynchronously and restores the selection.
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
  });

  it('reloads the graph on a status refresh but never clobbers an open commit diff', async () => {
    const { fixture, fs, reload, repoState, getDiff } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    await vi.waitFor(() => expect(fs.variant()).toBe('commit'));
    const before = getDiff.mock.calls.length;
    reload.mockClear();

    repoState.statusRefreshRequested.set(1);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(reload).toHaveBeenCalledTimes(1);
    // The commit comparison is immutable: it is not reopened into the working tree.
    expect(fs.variant()).toBe('commit');
    expect(fs.activeCommit()?.oid?.hex).toBe(HEAD_HEX);
    expect(getDiff.mock.calls.length).toBe(before);
  });

  it('does nothing when the status token is re-set to the same value', async () => {
    const { fixture, fs, reload, repoState } = await setup({ selection: WIP_OID });
    await waitForDiff(fixture, fs);

    repoState.statusRefreshRequested.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(reload).toHaveBeenCalledTimes(1);

    reload.mockClear();
    repoState.statusRefreshRequested.set(1);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(reload).not.toHaveBeenCalled();
  });

  it('projects a conflicted file with hasConflictMarkers to the viewer', async () => {
    const conflicted: FileDiff = { ...fileDiff('conflict.ts', 1, 1, 'render'), hasConflictMarkers: true };
    const { fixture, fs } = await setup({
      selection: WIP_OID,
      files: [file('conflict.ts', false)],
      diff: () => ({ ...wholeDiff(), hasConflictMarkers: true, files: [conflicted], additions: 1, deletions: 1 }),
    });
    await waitForDiff(fixture, fs);

    fs.selectFile('conflict.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('conflict.ts'));
    await settle(fixture);

    // The conflict marker reaches the viewer through the single-file projection.
    expect(viewer(fixture).diff()?.hasConflictMarkers).toBe(true);
    expect(query(fixture, 'diff-conflict')).not.toBeNull();
  });

  it('does not break when a selected untracked file has no diff section', async () => {
    const untracked: FileStatus = {
      path: 'untracked.ts',
      staged: ' ',
      unstaged: '?',
      isStaged: false,
      isConflicted: false,
    };
    const { fixture, fs } = await setup({ selection: WIP_OID, files: [untracked] });
    await waitForDiff(fixture, fs);

    fs.selectFile('untracked.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('untracked.ts'));
    await settle(fixture);

    // No FileDiff section for the untracked path: the addressing substrate is
    // null and the viewer input stays null — both degrade without throwing.
    expect(fs.selectedUnstagedFile()).toBeNull();
    expect(viewer(fixture).diff()).toBeNull();
    // The right pane explains the empty diff instead of rendering blank.
    expect(fs.wholeDiff()?.files.some((f) => f.path === 'untracked.ts')).toBe(false);
    const notice = query(fixture, 'file-status-untracked');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Untracked file');
  });

  it('hides the untracked notice once the file has a diff section', async () => {
    const untracked: FileStatus = {
      path: 'a.ts',
      staged: ' ',
      unstaged: '?',
      isStaged: false,
      isConflicted: false,
    };
    // `a.ts` is present in the status AND in the worktree diff: no notice.
    const { fixture, fs } = await setup({ selection: WIP_OID, files: [untracked] });
    await waitForDiff(fixture, fs);

    fs.selectFile('a.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    await settle(fixture);

    expect(query(fixture, 'file-status-untracked')).toBeNull();
  });

  it('does not mislabel a tracked file omitted by a truncated diff as untracked', async () => {
    const tracked: FileStatus = {
      path: 'truncated.ts',
      staged: ' ',
      unstaged: 'M',
      isStaged: false,
      isConflicted: false,
    };
    // The core capped the diff (ADR-0020), so this tracked file's section is
    // genuinely missing — it must NOT be reported as untracked.
    const { fixture, fs } = await setup({
      selection: WIP_OID,
      files: [tracked],
      diff: () => ({
        ...wholeDiff(),
        truncated: true,
        files: [fileDiff('a.ts', 6, 2, 'a-line')],
      }),
    });
    await waitForDiff(fixture, fs);

    fs.selectFile('truncated.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('truncated.ts'));
    await settle(fixture);

    expect(fs.truncated()).toBe(true);
    expect(fs.wholeDiff()?.files.some((f) => f.path === 'truncated.ts')).toBe(false);
    expect(query(fixture, 'file-status-untracked')).toBeNull();
  });

  it('surfaces the truncated notice in the viewer when the diff is capped', async () => {
    const { fixture, fs } = await setup({
      selection: HEAD_HEX,
      diff: () => ({ ...wholeDiff(), truncated: true }),
    });
    await waitForDiff(fixture, fs);
    fixture.detectChanges();

    expect(viewer(fixture).truncated()).toBe(true);
    expect(query(fixture, 'diff-truncated')).not.toBeNull();
  });
});

// -- persisted preferences reach the mounted surfaces (plan 4.9) -------------

describe('FileStatusPage persisted preferences', () => {
  let restoreStorage: () => void;

  beforeEach(() => {
    // Root preferences are read in PreferencesService's constructor, so the
    // memory storage must exist before the page (and its viewer) mount.
    restoreStorage = installStorage({});
  });

  afterEach(() => {
    restoreStorage();
    TestBed.resetTestingModule();
  });

  it('applies a persisted st:paneWidth to the rendered detail pane', async () => {
    localStorage.setItem('st:paneWidth', '420');
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    fixture.detectChanges();

    const detail = query(fixture, 'workspace-detail');
    expect(detail).not.toBeNull();
    expect(detail!.style.width).toBe('420px');
  });

  it('persists st:paneWidth when the split divider is dragged', async () => {
    localStorage.setItem('st:paneWidth', '420');
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    fixture.detectChanges();

    // The split is opt-in resizable, so the divider is really mounted.
    const divider = query(fixture, 'workspace-divider');
    expect(divider).not.toBeNull();

    divider!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    fixture.detectChanges();

    // The page only rounds the emitted pixels and forwards them to the service.
    expect(localStorage.getItem('st:paneWidth')).toBe('320');
  });

  it('defaults the mounted viewer to 12px with wrap off', async () => {
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    fixture.detectChanges();

    expect(viewer(fixture).fontSize()).toBe(12);
    expect(viewer(fixture).wordWrap()).toBe(false);
  });

  it('passes the persisted diff typography to the mounted viewer', async () => {
    localStorage.setItem('st:diffFontSize', '13');
    localStorage.setItem('st:diffWordWrap', 'on');
    const { fixture, fs } = await setup({ selection: HEAD_HEX });
    await waitForDiff(fixture, fs);
    fixture.detectChanges();

    expect(viewer(fixture).fontSize()).toBe(13);
    expect(viewer(fixture).wordWrap()).toBe(true);
    // The same preferences drive the fallback grid's inline typography.
    fs.selectFile('a.ts');
    await vi.waitFor(() => expect(fs.selectedPath()).toBe('a.ts'));
    await settle(fixture);
    const fallback = query(fixture, 'diff-fallback');
    expect(fallback).not.toBeNull();
    expect(fallback!.getAttribute('data-wrap')).toBe('on');
    expect(fallback!.style.fontSize).toBe('13px');
    expect(fallback!.style.lineHeight).toBe('26px');
  });
});
