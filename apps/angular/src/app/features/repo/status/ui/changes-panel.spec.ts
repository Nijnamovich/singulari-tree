import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileStatus } from '@contracts/domain';
import { ChangesPanel } from './changes-panel';

interface PanelInputs {
  stagedFiles?: FileStatus[];
  unstagedFiles?: FileStatus[];
  message?: string;
  busy?: boolean;
  selectedPath?: string | null;
  statusError?: string | null;
  commitError?: string | null;
}

function file(path: string, isStaged: boolean): FileStatus {
  return { path, staged: isStaged ? 'M' : ' ', unstaged: 'M', isStaged, isConflicted: false };
}

function render(inputs: PanelInputs = {}): ComponentFixture<ChangesPanel> {
  const fixture = TestBed.createComponent(ChangesPanel);
  const ref = fixture.componentRef;
  if (inputs.stagedFiles !== undefined) ref.setInput('stagedFiles', inputs.stagedFiles);
  if (inputs.unstagedFiles !== undefined) ref.setInput('unstagedFiles', inputs.unstagedFiles);
  if (inputs.message !== undefined) ref.setInput('message', inputs.message);
  if (inputs.busy !== undefined) ref.setInput('busy', inputs.busy);
  if (inputs.selectedPath !== undefined) ref.setInput('selectedPath', inputs.selectedPath);
  if (inputs.statusError !== undefined) ref.setInput('statusError', inputs.statusError);
  if (inputs.commitError !== undefined) ref.setInput('commitError', inputs.commitError);
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ComponentFixture<ChangesPanel>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

function all(fixture: ComponentFixture<ChangesPanel>, testId: string): HTMLElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  );
}

function button(fixture: ComponentFixture<ChangesPanel>, testId: string): HTMLButtonElement {
  return query(fixture, testId) as HTMLButtonElement;
}

describe('ChangesPanel', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders staged and unstaged rows with their paths', () => {
    const fixture = render({
      stagedFiles: [file('staged.ts', true)],
      unstagedFiles: [file('dirty.ts', false)],
    });

    const rows = all(fixture, 'status-file').map((row) => row.textContent?.trim());
    expect(rows).toHaveLength(2);
    expect(rows.some((text) => text?.includes('staged.ts'))).toBe(true);
    expect(rows.some((text) => text?.includes('dirty.ts'))).toBe(true);
    expect(all(fixture, 'status-unstage')).toHaveLength(1);
    expect(all(fixture, 'status-stage')).toHaveLength(1);
  });

  it('emits the path from a Stage click (and not from Unstage rows)', () => {
    const fixture = render({ unstagedFiles: [file('a.ts', false)] });
    const emitted: string[][] = [];
    fixture.componentInstance.stage.subscribe((paths) => emitted.push(paths));

    button(fixture, 'status-stage').click();

    expect(emitted).toEqual([['a.ts']]);
  });

  it('emits the path from an Unstage click', () => {
    const fixture = render({ stagedFiles: [file('b.ts', true)] });
    const emitted: string[][] = [];
    fixture.componentInstance.unstage.subscribe((paths) => emitted.push(paths));

    button(fixture, 'status-unstage').click();

    expect(emitted).toEqual([['b.ts']]);
  });

  it('emits a row selection without staging when the row itself is clicked', () => {
    const fixture = render({ unstagedFiles: [file('a.ts', false)] });
    const selected: string[] = [];
    const staged: string[][] = [];
    fixture.componentInstance.fileSelect.subscribe((path) => selected.push(path));
    fixture.componentInstance.stage.subscribe((paths) => staged.push(paths));

    all(fixture, 'status-file')[0].click();

    expect(selected).toEqual(['a.ts']);
    expect(staged).toEqual([]);
  });

  it('emits message changes from the commit box', () => {
    const fixture = render({ message: '' });
    const changes: string[] = [];
    fixture.componentInstance.messageChange.subscribe((value) => changes.push(value));

    const textarea = (query(fixture, 'commit-message-input')?.querySelector(
      'textarea',
    )) as HTMLTextAreaElement;
    textarea.value = 'feat: graph';
    textarea.dispatchEvent(new Event('input'));

    expect(changes).toEqual(['feat: graph']);
  });

  it('keeps Commit disabled until there is a staged file and a non-blank message', () => {
    const noStaged = render({ stagedFiles: [], message: 'feat' });
    expect(
      ((query(noStaged, 'commit-button')?.querySelector('button')) as HTMLButtonElement).disabled,
    ).toBe(true);

    const blankMessage = render({ stagedFiles: [file('a.ts', true)], message: '   ' });
    expect(
      ((query(blankMessage, 'commit-button')?.querySelector('button')) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const ready = render({ stagedFiles: [file('a.ts', true)], message: 'feat' });
    expect(
      ((query(ready, 'commit-button')?.querySelector('button')) as HTMLButtonElement).disabled,
    ).toBe(false);

    const busy = render({ stagedFiles: [file('a.ts', true)], message: 'feat', busy: true });
    expect(
      ((query(busy, 'commit-button')?.querySelector('button')) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('emits commit when the button is enabled', () => {
    const fixture = render({ stagedFiles: [file('a.ts', true)], message: 'feat' });
    const commit = vi.fn();
    fixture.componentInstance.commit.subscribe(commit);

    button(fixture, 'commit-button').click();

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('shows the status and commit errors in their own slots', () => {
    const fixture = render({ statusError: 'status failed', commitError: 'commit failed' });

    expect(query(fixture, 'status-error')?.textContent?.trim()).toBe('status failed');
    expect(query(fixture, 'commit-error')?.textContent?.trim()).toBe('commit failed');
  });

  it('shows the empty state when there are no changes', () => {
    const fixture = render({ stagedFiles: [], unstagedFiles: [] });
    expect(query(fixture, 'status-empty')).not.toBeNull();

    const withFiles = render({ unstagedFiles: [file('a.ts', false)] });
    expect(query(withFiles, 'status-empty')).toBeNull();
  });

  it('renders a file-level Discard only on unstaged rows', () => {
    const fixture = render({
      stagedFiles: [file('staged.ts', true)],
      unstagedFiles: [file('dirty.ts', false)],
    });

    expect(all(fixture, 'status-discard')).toHaveLength(1);
    expect(all(fixture, 'status-stage')).toHaveLength(1);
    expect(all(fixture, 'status-unstage')).toHaveLength(1);
  });

  it("groups each row's action buttons into one right-pinned actions group", () => {
    const fixture = render({
      stagedFiles: [file('staged.ts', true)],
      unstagedFiles: [file('dirty.ts', false)],
    });

    const rows = all(fixture, 'status-file');
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      const groups = Array.from(row.querySelectorAll<HTMLElement>('.st-changes__actions'));
      expect(groups).toHaveLength(1);
      // The group owns the row's trailing edge, so the buttons cannot drift
      // toward the centre the way a `space-between` trio would push them.
      expect(groups[0]).toBe(row.lastElementChild);
    }

    const stagedGroup = rows[0].querySelector('.st-changes__actions') as HTMLElement;
    expect(stagedGroup.querySelectorAll('st-button')).toHaveLength(1);

    // Stage (+) and discard (trash) share the same group, so they sit adjacent.
    const unstagedActions = Array.from(
      (rows[1].querySelector('.st-changes__actions') as HTMLElement).querySelectorAll('st-button'),
    );
    expect(unstagedActions).toHaveLength(2);
    expect(unstagedActions[0].getAttribute('data-testid')).toBe('status-stage');
    expect(unstagedActions[1].getAttribute('data-testid')).toBe('status-discard');
  });

  it('keeps the actions pinned right when the path is long enough to wrap', () => {
    const longPath =
      'src/app/features/repo/very/deeply/nested/directory/with/a/very/long/file-name.ts';
    const fixture = render({ unstagedFiles: [file(longPath, false)] });

    const row = all(fixture, 'status-file')[0];
    const path = row.querySelector('.st-changes__path') as HTMLElement;
    const actions = row.querySelector('.st-changes__actions') as HTMLElement;

    // The path stays intact and is the row's ONLY flexible child; the actions
    // group never grows, so a wrapping path cannot displace it.
    expect(path.textContent).toBe(longPath);
    expect(row.children).toHaveLength(2);
    expect(row.children[0]).toBe(path);
    expect(row.children[1]).toBe(actions);
    expect(row.lastElementChild).toBe(actions);
    expect(getComputedStyle(path).flexGrow).toBe('1');
    expect(getComputedStyle(actions).flexGrow).toBe('0');
  });

  it('confirms and emits a file-level discard', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = render({ unstagedFiles: [file('dirty.ts', false)] });
    const discarded: string[] = [];
    fixture.componentInstance.discardFile.subscribe((path) => discarded.push(path));

    button(fixture, 'status-discard').click();

    expect(discarded).toEqual(['dirty.ts']);
  });

  it('does not discard when the confirmation is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fixture = render({ unstagedFiles: [file('dirty.ts', false)] });
    const discarded: string[] = [];
    fixture.componentInstance.discardFile.subscribe((path) => discarded.push(path));

    button(fixture, 'status-discard').click();

    expect(discarded).toEqual([]);
  });

  it('does not discard while busy', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = render({ unstagedFiles: [file('dirty.ts', false)], busy: true });
    const discarded: string[] = [];
    fixture.componentInstance.discardFile.subscribe((path) => discarded.push(path));

    button(fixture, 'status-discard').click();

    expect(discarded).toEqual([]);
  });

  it('anchors the commit box as the fixed last child of the panel column', () => {
    const fixture = render({ unstagedFiles: [file('dirty.ts', false)] });
    const host = fixture.nativeElement as HTMLElement;
    const panel = host.querySelector('.st-changes') as HTMLElement;
    const sections = host.querySelector('.st-changes__sections') as HTMLElement;
    const commit = host.querySelector('.st-changes__commit') as HTMLElement;

    expect(panel).not.toBeNull();
    expect(sections).not.toBeNull();
    expect(commit).not.toBeNull();

    // The footer closes the panel column...
    expect(panel.lastElementChild).toBe(commit);
    // ...and owns none of the flexible slack: the sections take and can give it.
    expect(getComputedStyle(sections).flexGrow).toBe('1');
    expect(getComputedStyle(sections).flexShrink).toBe('1');
    expect(getComputedStyle(commit).flexGrow).toBe('0');
    expect(getComputedStyle(commit).flexShrink).toBe('0');
  });

  it('makes the file sections the scrollable region', () => {
    const fixture = render({ unstagedFiles: [file('a.ts', false)] });
    const sections = fixture.nativeElement.querySelector('.st-changes__sections') as HTMLElement;

    expect(getComputedStyle(sections).overflowY).toBe('auto');
  });

  it('keeps every contract data-testid in a full render', () => {
    const fixture = render({
      stagedFiles: [file('staged.ts', true)],
      unstagedFiles: [file('dirty.ts', false)],
      message: 'feat',
      selectedPath: 'dirty.ts',
      statusError: 'status failed',
      commitError: 'commit failed',
    });

    for (const id of [
      'status-error',
      'status-file',
      'status-stage',
      'status-unstage',
      'status-discard',
      'commit-message-input',
      'commit-button',
      'commit-error',
    ]) {
      expect(query(fixture, id), id).not.toBeNull();
    }
  });

  it('keeps the empty-state testid while no files are present', () => {
    const fixture = render({ stagedFiles: [], unstagedFiles: [] });

    expect(query(fixture, 'status-empty')).not.toBeNull();
  });
});
