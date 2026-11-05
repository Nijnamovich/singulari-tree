import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit } from '@contracts/domain';
import type { AppError } from '@core/services/ipc-bridge.service';
import type { ConflictState } from '@core/services/repo-state.service';
import { CherryPickDialog } from './cherry-pick-dialog';
import type { CherryPickValue } from './ref-dialog.models';

const COMMIT: Commit = {
  oid: { hex: 'abcdef1234567890'.padEnd(40, '0'), kind: 'SHA1' },
  parents: [],
  author: { name: 'Ada Lovelace', email: 'ada@example.com', when: '2026-01-02T10:00:00Z' },
  committer: undefined,
  message: 'fix: the first line\n\nand a body line',
  treeOid: undefined,
  committedAt: '2026-01-02T10:05:00Z',
  refs: [],
};

interface Options {
  open?: boolean;
  currentBranch?: string;
  branches?: readonly string[];
  remoteBranches?: readonly string[];
  tags?: readonly string[];
  defaultSource?: string;
  running?: boolean;
  error?: AppError | null;
  conflict?: ConflictState | null;
  preview?: Commit | null;
  previewLoading?: boolean;
  previewError?: AppError | null;
}

function setInputs(fixture: ComponentFixture<CherryPickDialog>, options: Options): void {
  const ref = fixture.componentRef;
  ref.setInput('open', options.open ?? true);
  ref.setInput('currentBranch', options.currentBranch ?? 'main');
  ref.setInput('branches', options.branches ?? ['main', 'feature/x']);
  ref.setInput('remoteBranches', options.remoteBranches ?? ['origin/main', 'origin/topic']);
  ref.setInput('tags', options.tags ?? ['v1.0.0']);
  ref.setInput('defaultSource', options.defaultSource ?? '');
  ref.setInput('running', options.running ?? false);
  ref.setInput('error', options.error ?? null);
  ref.setInput('conflict', options.conflict ?? null);
  ref.setInput('preview', options.preview ?? null);
  ref.setInput('previewLoading', options.previewLoading ?? false);
  ref.setInput('previewError', options.previewError ?? null);
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(CherryPickDialog);
  setInputs(fixture, options);
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ReturnType<typeof render>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

/** The native button inside the `<st-button>` host carrying `testId`. */
function innerButton(fixture: ReturnType<typeof render>, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

function typeSource(fixture: ReturnType<typeof render>, value: string): void {
  const input = query(fixture, 'cherry-source') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('CherryPickDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false, defaultSource: 'abc' });
    expect(query(fixture, 'cherry-source')).toBeNull();
  });

  it('seeds the default source and asks the parent to preview it at once', () => {
    const fixture = TestBed.createComponent(CherryPickDialog);
    const emitted: string[] = [];
    fixture.componentInstance.sourceChange.subscribe((value) => emitted.push(value));

    setInputs(fixture, { open: true, defaultSource: 'abc1234' });
    fixture.detectChanges();

    expect((query(fixture, 'cherry-source') as HTMLInputElement).value).toBe('abc1234');
    expect(emitted).toEqual(['abc1234']);
  });

  it('does not fire a source change for an empty default', () => {
    const fixture = TestBed.createComponent(CherryPickDialog);
    const emitted: string[] = [];
    fixture.componentInstance.sourceChange.subscribe((value) => emitted.push(value));

    setInputs(fixture, { open: true, defaultSource: '' });
    fixture.detectChanges();

    expect(emitted).toEqual([]);
  });

  it('debounces typing into exactly one settled source change', () => {
    vi.useFakeTimers();
    const fixture = render({ open: true });
    const emitted: string[] = [];
    fixture.componentInstance.sourceChange.subscribe((value) => emitted.push(value));

    typeSource(fixture, 'ab');
    typeSource(fixture, 'abc');

    vi.advanceTimersByTime(249);
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['abc']);

    vi.advanceTimersByTime(10_000);
    expect(emitted).toEqual(['abc']);
  });

  it('lists the pickable refs by kind and excludes the current branch', () => {
    const fixture = render({ open: true, currentBranch: 'main' });
    const select = query(fixture, 'cherry-pick-source') as HTMLSelectElement;

    const groups = Array.from(select.querySelectorAll('optgroup'));
    expect(groups.map((group) => group.getAttribute('label'))).toEqual([
      'Local branches',
      'Remote branches',
      'Tags',
    ]);
    expect(groups[0].querySelectorAll('option')).toHaveLength(1);
    expect(
      Array.from(select.querySelectorAll('option')).map((option) => option.value),
    ).not.toContain('main');
  });

  it('writes a picked ref into the source field and previews it', () => {
    vi.useFakeTimers();
    const fixture = render({ open: true });
    const emitted: string[] = [];
    fixture.componentInstance.sourceChange.subscribe((value) => emitted.push(value));

    const select = query(fixture, 'cherry-pick-source') as HTMLSelectElement;
    select.value = 'origin/topic';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect((query(fixture, 'cherry-source') as HTMLInputElement).value).toBe('origin/topic');

    vi.advanceTimersByTime(250);
    expect(emitted).toEqual(['origin/topic']);
  });

  it('renders the preview card with sha, subject, author and date', () => {
    const fixture = render({ open: true, defaultSource: 'abcdef1', preview: COMMIT });

    const card = query(fixture, 'cherry-preview');
    expect(card).not.toBeNull();
    expect(query(fixture, 'cherry-preview-sha')?.textContent?.trim()).toBe('abcdef1');
    expect(query(fixture, 'cherry-preview-subject')?.textContent?.trim()).toBe(
      'fix: the first line',
    );
    expect(query(fixture, 'cherry-preview-author')?.textContent?.trim()).toBe('Ada Lovelace');
    expect(query(fixture, 'cherry-preview-date')?.textContent?.trim()).toBe(
      '2026-01-02T10:05:00Z',
    );
  });

  it('shows a loading line instead of a preview card while resolving', () => {
    const fixture = render({ open: true, defaultSource: 'abc', previewLoading: true });

    expect(query(fixture, 'cherry-preview-loading')).not.toBeNull();
    expect(query(fixture, 'cherry-preview')).toBeNull();
  });

  it('disables submit while the source is blank or unresolved', () => {
    expect(innerButton(render({ open: true }), 'cherry-submit').disabled).toBe(true);
    expect(
      innerButton(render({ open: true, defaultSource: 'abc' }), 'cherry-submit').disabled,
    ).toBe(true);
  });

  it('disables submit while the preview loads, fails or the pick runs', () => {
    expect(
      innerButton(
        render({ open: true, defaultSource: 'abc', preview: COMMIT, previewLoading: true }),
        'cherry-submit',
      ).disabled,
    ).toBe(true);
    expect(
      innerButton(
        render({
          open: true,
          defaultSource: 'abc',
          previewError: { code: 'COMMIT_NOT_FOUND', message: 'nope' },
        }),
        'cherry-submit',
      ).disabled,
    ).toBe(true);
    expect(
      innerButton(
        render({ open: true, defaultSource: 'abc', preview: COMMIT, running: true }),
        'cherry-submit',
      ).disabled,
    ).toBe(true);
  });

  it('enables submit once the source resolves', () => {
    const fixture = render({ open: true, defaultSource: 'abc', preview: COMMIT });
    expect(innerButton(fixture, 'cherry-submit').disabled).toBe(false);
  });

  it('keeps both flags off by default and forwards them on submit', () => {
    const fixture = render({ open: true, defaultSource: 'abc', preview: COMMIT });
    const recordOrigin = query(fixture, 'cherry-record-origin') as HTMLInputElement;
    const noCommit = query(fixture, 'cherry-no-commit') as HTMLInputElement;
    const emitted: CherryPickValue[] = [];
    fixture.componentInstance.submitted.subscribe((value) => emitted.push(value));

    expect(recordOrigin.checked).toBe(false);
    expect(noCommit.checked).toBe(false);

    recordOrigin.checked = true;
    recordOrigin.dispatchEvent(new Event('change'));
    noCommit.checked = true;
    noCommit.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    query(fixture, 'cherry-submit')?.click();

    expect(emitted).toEqual([{ source: 'abc', recordOrigin: true, noCommit: true }]);
  });

  it('maps COMMIT_NOT_FOUND to a plain not-found sentence', () => {
    const fixture = render({
      open: true,
      defaultSource: 'nope',
      previewError: { code: 'COMMIT_NOT_FOUND', message: 'revision not found' },
    });

    expect(query(fixture, 'cherry-preview-error')?.textContent?.trim()).toBe(
      'No commit matches that revision.',
    );
  });

  it('falls back to the error message for other preview failures', () => {
    const fixture = render({
      open: true,
      defaultSource: 'nope',
      previewError: { code: 'GIT_FAILED', message: 'boom' },
    });

    expect(query(fixture, 'cherry-preview-error')?.textContent?.trim()).toBe('boom');
  });

  it('warns about a cherry-pick conflict and ignores other operations', () => {
    const cherry = render({
      open: true,
      defaultSource: 'abc',
      conflict: { operation: 'cherry-pick', hasConflict: true, oid: 'head' },
    });
    expect(query(cherry, 'cherry-conflict')?.textContent).toContain('produced conflicts');

    const merge = render({
      open: true,
      defaultSource: 'abc',
      conflict: { operation: 'merge', hasConflict: true, oid: 'head' },
    });
    expect(query(merge, 'cherry-conflict')).toBeNull();
  });

  it('maps DETACHED_HEAD at submit to a plain detached sentence', () => {
    const fixture = render({
      open: true,
      defaultSource: 'abc',
      preview: COMMIT,
      error: { code: 'DETACHED_HEAD', message: 'HEAD is not on a branch' },
    });

    expect(query(fixture, 'cherry-error')?.textContent?.trim()).toBe(
      'Cannot cherry-pick on a detached HEAD.',
    );
  });

  it('maps the empty reason token even when the code is generic', () => {
    const fixture = render({
      open: true,
      defaultSource: 'abc',
      preview: COMMIT,
      error: {
        code: 'CHERRY_PICK_FAILED',
        message: 'nothing to commit',
        details: { reason: 'empty' },
      },
    });

    expect(query(fixture, 'cherry-error')?.textContent?.trim()).toBe(
      'That change is already applied, so nothing was picked.',
    );
  });

  it('maps the in-progress reason token to the finish-or-abort sentence', () => {
    const fixture = render({
      open: true,
      defaultSource: 'abc',
      preview: COMMIT,
      error: {
        code: 'CHERRY_PICK_FAILED',
        message: 'sequencer busy',
        details: { reason: 'in-progress' },
      },
    });

    expect(query(fixture, 'cherry-error')?.textContent?.trim()).toBe(
      'Another operation is in progress. Finish or abort it first.',
    );
  });

  it('surfaces a generic error row with the raw message fallback', () => {
    const fixture = render({
      open: true,
      defaultSource: 'abc',
      error: { code: 'CHERRY_PICK_FAILED', message: 'boom' },
    });

    expect(query(fixture, 'cherry-error')?.textContent?.trim()).toBe('boom');
  });

  it('emits cancelled and never submits', () => {
    const fixture = render({ open: true, defaultSource: 'abc', preview: COMMIT });
    let cancelled = 0;
    let submitted = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));
    fixture.componentInstance.submitted.subscribe(() => (submitted += 1));

    query(fixture, 'cherry-cancel')?.click();

    expect(cancelled).toBe(1);
    expect(submitted).toBe(0);
  });
});
