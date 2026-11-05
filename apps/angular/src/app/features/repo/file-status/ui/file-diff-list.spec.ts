import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff } from '@contracts/domain';
import { FileDiffList } from './file-diff-list';

function line(kind: string, text: string): DiffLine {
  return { kind, text, noNewline: false };
}

function fileDiff(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    oldPath: '',
    status: 'M',
    hunks: [
      {
        fromStart: 1,
        fromLines: 1,
        toStart: 1,
        toLines: 1,
        lines: [line('added', 'x')],
      },
    ],
    additions: 3,
    deletions: 1,
    isBinary: false,
    hasConflictMarkers: false,
    ...overrides,
  };
}

interface ListInputs {
  files?: FileDiff[];
  selectedPath?: string | null;
}

function render(inputs: ListInputs = {}): ComponentFixture<FileDiffList> {
  const fixture = TestBed.createComponent(FileDiffList);
  const ref = fixture.componentRef;
  ref.setInput('files', inputs.files ?? []);
  ref.setInput('selectedPath', inputs.selectedPath ?? null);
  fixture.detectChanges();
  return fixture;
}

function all(fixture: ComponentFixture<FileDiffList>, testId: string): HTMLElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      `[data-testid="${testId}"]`,
    ),
  );
}

function query<T extends HTMLElement = HTMLElement>(
  fixture: ComponentFixture<FileDiffList>,
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(
    `[data-testid="${testId}"]`,
  );
}

describe('FileDiffList', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders a row per file with its status badge and +/- counts', () => {
    const fixture = render({ files: [fileDiff('a.ts'), fileDiff('b.ts', { status: 'A', additions: 7, deletions: 0 })] });

    const rows = all(fixture, 'file-diff-row');
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(first.querySelector('[data-testid="file-diff-status"]')?.textContent?.trim()).toBe('M');
    expect(first.querySelector('[data-testid="file-diff-additions"]')?.textContent?.trim()).toBe(
      '+3',
    );
    expect(first.querySelector('[data-testid="file-diff-deletions"]')?.textContent?.trim()).toBe(
      '\u22121',
    );
    expect(first.querySelector('.st-file-diff-list__path')?.textContent?.trim()).toBe('a.ts');

    const second = rows[1];
    expect(second.querySelector('[data-testid="file-diff-status"]')?.textContent?.trim()).toBe('A');
    expect(second.querySelector('[data-testid="file-diff-additions"]')?.textContent?.trim()).toBe(
      '+7',
    );
  });

  it('marks the selected row and leaves the others unmarked', () => {
    const fixture = render({ files: [fileDiff('a.ts'), fileDiff('b.ts')], selectedPath: 'b.ts' });

    const rows = all(fixture, 'file-diff-row');
    expect(rows[0].classList.contains('st-file-diff-list__row--selected')).toBe(false);
    expect(rows[1].classList.contains('st-file-diff-list__row--selected')).toBe(true);
    expect(rows[0].getAttribute('data-selected')).toBe('false');
    expect(rows[1].getAttribute('data-selected')).toBe('true');
    // The selectable-row directive supplies the shared 3px inset selection bar.
    expect(rows[0].classList.contains('st-selection-bar')).toBe(false);
    expect(rows[1].classList.contains('st-selection-bar')).toBe(true);
  });

  it('emits the path of the clicked row', () => {
    const fixture = render({ files: [fileDiff('a.ts'), fileDiff('b.ts')] });
    const selected: string[] = [];
    fixture.componentInstance.fileSelect.subscribe((path) => selected.push(path));

    all(fixture, 'file-diff-row')[1].click();

    expect(selected).toEqual(['b.ts']);
  });

  it('addresses a renamed file by its new path', () => {
    const fixture = render({
      files: [fileDiff('src/new-name.ts', { status: 'R', oldPath: 'src/old-name.ts' })],
    });

    const row = all(fixture, 'file-diff-row')[0];
    expect(row.getAttribute('data-path')).toBe('src/new-name.ts');
    expect(row.textContent).toContain('src/new-name.ts');
    expect(row.textContent).not.toContain('src/old-name.ts');

    const emitted: string[] = [];
    fixture.componentInstance.fileSelect.subscribe((path) => emitted.push(path));
    row.click();
    expect(emitted).toEqual(['src/new-name.ts']);
  });

  it('shows a binary marker instead of the diff counts', () => {
    const fixture = render({ files: [fileDiff('img/logo.png', { isBinary: true, hunks: [] })] });

    expect(query(fixture, 'file-diff-binary')?.textContent?.trim()).toBe('binary');
    expect(all(fixture, 'file-diff-additions')).toHaveLength(0);
    expect(all(fixture, 'file-diff-deletions')).toHaveLength(0);
  });

  it('renders the empty state when there is nothing changed', () => {
    const fixture = render({ files: [] });

    expect(query(fixture, 'file-list-empty')?.textContent?.trim()).toBe('No changed files.');
    expect(all(fixture, 'file-diff-row')).toHaveLength(0);
    // No files means no statuses to offer: the filter row is not rendered.
    expect(query(fixture, 'file-status-filters')).toBeNull();
    // ...and the name filter is not rendered either: no dead control above the
    // empty state.
    expect(query(fixture, 'file-list-filter')).toBeNull();
  });

  function chip(fixture: ComponentFixture<FileDiffList>, status: string): HTMLElement {
    return all(fixture, 'file-status-filter').find(
      (element) => element.getAttribute('data-status') === status,
    ) as HTMLElement;
  }

  function rowPaths(fixture: ComponentFixture<FileDiffList>): (string | null)[] {
    return all(fixture, 'file-diff-row').map((row) => row.getAttribute('data-path'));
  }

  function typeFilter(fixture: ComponentFixture<FileDiffList>, value: string): void {
    const input = query<HTMLInputElement>(fixture, 'file-list-filter');
    input!.value = value;
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('derives one filter chip per distinct status, ordered A, M, D, R then the rest', () => {
    const fixture = render({
      files: [
        fileDiff('one.ts', { status: 'T' }),
        fileDiff('two.ts', { status: 'M' }),
        fileDiff('three.ts', { status: 'A' }),
        fileDiff('four.ts', { status: 'R', oldPath: 'old.ts' }),
        fileDiff('five.ts', { status: 'D' }),
        fileDiff('six.ts', { status: 'C' }),
        // A duplicate status must not yield a second chip.
        fileDiff('seven.ts', { status: 'M' }),
      ],
    });

    const chips = all(fixture, 'file-status-filter');
    expect(chips.map((element) => element.getAttribute('data-status'))).toEqual([
      'A',
      'M',
      'D',
      'R',
      'C',
      'T',
    ]);
    // Each chip renders the status letter itself.
    expect(chips.map((element) => element.textContent?.trim())).toEqual([
      'A',
      'M',
      'D',
      'R',
      'C',
      'T',
    ]);
    // The letter carries the status so it inherits the badge colour mapping.
    expect(
      chips[0].querySelector('.st-file-diff-list__chip-letter')?.getAttribute('data-status'),
    ).toBe('A');
    // Chips start off; no filter is active until the user turns one on. The
    // pressed state reaches AT through the inner native button (the host carries
    // no aria-pressed of its own).
    expect(
      chips.every(
        (element) => element.querySelector('button')?.getAttribute('aria-pressed') === 'false',
      ),
    ).toBe(true);
    expect(all(fixture, 'file-diff-row')).toHaveLength(7);
  });

  it('filters the rows to the status a chip turns on', () => {
    const fixture = render({
      files: [fileDiff('a.ts', { status: 'A' }), fileDiff('m.ts'), fileDiff('d.ts', { status: 'D' })],
    });

    chip(fixture, 'D').click();
    fixture.detectChanges();

    expect(rowPaths(fixture)).toEqual(['d.ts']);
    expect(chip(fixture, 'D').querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
    expect(chip(fixture, 'D').classList.contains('st-file-diff-list__chip--active')).toBe(true);
    expect(chip(fixture, 'A').classList.contains('st-file-diff-list__chip--active')).toBe(false);
  });

  it('unions multiple chip selections and clears back to every file', () => {
    const fixture = render({
      files: [fileDiff('a.ts', { status: 'A' }), fileDiff('m.ts'), fileDiff('d.ts', { status: 'D' })],
    });

    // Off -> on adds; a second chip is a union, not a replacement.
    chip(fixture, 'A').click();
    chip(fixture, 'D').click();
    fixture.detectChanges();
    expect(rowPaths(fixture)).toEqual(['a.ts', 'd.ts']);
    expect(query(fixture, 'file-status-filters-clear')).not.toBeNull();

    // On -> off removes that status from the union.
    chip(fixture, 'A').click();
    fixture.detectChanges();
    expect(rowPaths(fixture)).toEqual(['d.ts']);

    // Clear drops every active chip and restores the unfiltered list.
    (query(fixture, 'file-status-filters-clear') as HTMLElement).click();
    fixture.detectChanges();
    expect(rowPaths(fixture)).toEqual(['a.ts', 'm.ts', 'd.ts']);
    expect(query(fixture, 'file-status-filters-clear')).toBeNull();
  });

  it('shows the zero-match state only when the active filters hide every file', () => {
    const fixture = render({ files: [fileDiff('a.ts', { status: 'A' }), fileDiff('m.ts')] });

    chip(fixture, 'A').click();
    fixture.detectChanges();
    expect(query(fixture, 'file-list-filter-empty')).toBeNull();
    expect(rowPaths(fixture)).toEqual(['a.ts']);
    // The genuinely-empty state is not confused with a filtered-out list.
    expect(query(fixture, 'file-list-empty')).toBeNull();

    // The diff refreshes to files that no longer include A: the still-active A
    // filter now matches nothing, so the zero-match state replaces the list.
    fixture.componentRef.setInput('files', [fileDiff('m.ts')]);
    fixture.detectChanges();
    expect(query(fixture, 'file-list-filter-empty')?.textContent).toContain('No files match');
    expect(all(fixture, 'file-diff-row')).toHaveLength(0);
  });

  it('keeps the selection when a filter hides the selected row', () => {
    const fixture = render({
      files: [fileDiff('a.ts', { status: 'A' }), fileDiff('m.ts')],
      selectedPath: 'a.ts',
    });
    const emitted: string[] = [];
    fixture.componentInstance.fileSelect.subscribe((path) => emitted.push(path));

    chip(fixture, 'M').click();
    fixture.detectChanges();

    // a.ts is filtered out of the DOM, but the list must not silently emit a new
    // selection: the store keeps the user's selection, only the row is hidden.
    expect(rowPaths(fixture)).toEqual(['m.ts']);
    expect(emitted).toEqual([]);
    expect(fixture.componentInstance.isActive('M')).toBe(true);
  });

  it('filters the rows by a case-insensitive path substring', () => {
    const fixture = render({ files: [fileDiff('src/App.git-TS'), fileDiff('src/lib/util.ts')] });

    typeFilter(fixture, 'app.git');

    // The query is matched against `file.path` case-insensitively.
    expect(rowPaths(fixture)).toEqual(['src/App.git-TS']);
  });

  it('matches the name filter literally, never as a RegExp', () => {
    // `a.ts` would match both paths as a pattern (`.` = any char); as a literal
    // substring it matches only the real path.
    const fixture = render({ files: [fileDiff('a.ts'), fileDiff('axts')] });

    typeFilter(fixture, 'a.ts');

    expect(rowPaths(fixture)).toEqual(['a.ts']);
  });

  it('clears the name filter too so Clear filters never leaves the list searched', () => {
    const fixture = render({
      files: [fileDiff('a.ts', { status: 'A' }), fileDiff('b.ts')],
    });

    chip(fixture, 'A').click();
    fixture.detectChanges();
    typeFilter(fixture, 'a');
    fixture.detectChanges();

    // Both controls are active, so the clear button is offered.
    const clear = query(fixture, 'file-status-filters-clear');
    expect(clear).not.toBeNull();

    (clear as HTMLElement).click();
    fixture.detectChanges();

    // Every row is restored and the control resets fully: the chip filter AND
    // the name query are gone, and the button disappears with them.
    expect(rowPaths(fixture)).toEqual(['a.ts', 'b.ts']);
    expect(query(fixture, 'file-status-filters-clear')).toBeNull();
    expect(query<HTMLInputElement>(fixture, 'file-list-filter')?.value).toBe('');
  });

  it('combines the name filter with the status chips (AND)', () => {
    const fixture = render({
      files: [
        fileDiff('a.ts', { status: 'A' }),
        fileDiff('src/a.ts'),
        fileDiff('m.ts'),
      ],
    });

    chip(fixture, 'A').click();
    fixture.detectChanges();
    typeFilter(fixture, 'a.ts');

    // Only the A-status file whose path contains `a.ts` survives both controls.
    expect(rowPaths(fixture)).toEqual(['a.ts']);
  });

  it('shows the filter zero-match state distinct from the empty state', () => {
    const fixture = render({ files: [fileDiff('a.ts')] });

    typeFilter(fixture, 'zzz');

    expect(query(fixture, 'file-list-filter-empty')?.textContent).toContain('No files match');
    expect(all(fixture, 'file-diff-row')).toHaveLength(0);
    // Files exist, they are only filtered out — never the genuinely-empty state.
    expect(query(fixture, 'file-list-empty')).toBeNull();

    // Clearing the query restores the list and removes the zero-match state.
    typeFilter(fixture, '');
    expect(rowPaths(fixture)).toEqual(['a.ts']);
    expect(query(fixture, 'file-list-filter-empty')).toBeNull();
  });
});
