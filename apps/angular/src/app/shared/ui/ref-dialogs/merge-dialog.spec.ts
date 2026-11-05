import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MergeResponse } from '@contracts/gitcore';
import { MergeDialog } from './merge-dialog';
import type { MergeValue } from './ref-dialog.models';

interface Options {
  open?: boolean;
  branches?: string[];
  currentBranch?: string;
  defaultRef?: string;
  running?: boolean;
  error?: { code: string; message: string } | null;
  conflict?: MergeResponse | null;
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(MergeDialog);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.componentRef.setInput('branches', options.branches ?? ['main', 'feature/x']);
  fixture.componentRef.setInput('currentBranch', options.currentBranch ?? 'main');
  fixture.componentRef.setInput('defaultRef', options.defaultRef ?? '');
  fixture.componentRef.setInput('running', options.running ?? false);
  fixture.componentRef.setInput('error', options.error ?? null);
  fixture.componentRef.setInput('conflict', options.conflict ?? null);
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

describe('MergeDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'merge-ref')).toBeNull();
  });

  it('excludes the current branch and preselects the requested ref', () => {
    const fixture = render({ defaultRef: 'feature/x' });
    const options = Array.from(
      (query(fixture, 'merge-ref') as HTMLSelectElement).options,
    ).map((o) => o.value);

    expect(options).toEqual(['feature/x']);
    expect((query(fixture, 'merge-ref') as HTMLSelectElement).value).toBe('feature/x');
  });

  it('falls back to the first available ref when the requested one is the current branch', () => {
    const fixture = render({
      branches: ['main', 'develop'],
      currentBranch: 'main',
      defaultRef: 'main',
    });

    expect((query(fixture, 'merge-ref') as HTMLSelectElement).value).toBe('develop');
  });

  it('emits the chosen ref/strategy/flags/message', () => {
    const fixture = render({ defaultRef: 'feature/x' });
    const emitted: MergeValue[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    const strategy = query(fixture, 'merge-strategy') as HTMLSelectElement;
    strategy.value = 'NO_FF';
    strategy.dispatchEvent(new Event('change'));

    const noCommit = query(fixture, 'merge-nocommit') as HTMLInputElement;
    noCommit.checked = true;
    noCommit.dispatchEvent(new Event('change'));

    const message = query(fixture, 'merge-message') as HTMLInputElement;
    message.value = '  merge feature  ';
    message.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    query(fixture, 'merge-submit')?.click();

    expect(emitted).toEqual([
      { ref: 'feature/x', strategy: 'NO_FF', noCommit: true, message: 'merge feature' },
    ]);
  });

  it('lets the user pick another mergeable ref', () => {
    const fixture = render({
      branches: ['main', 'develop', 'feature/x'],
      currentBranch: 'main',
      defaultRef: 'develop',
    });
    const emitted: MergeValue[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    const select = query(fixture, 'merge-ref') as HTMLSelectElement;
    select.value = 'feature/x';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    query(fixture, 'merge-submit')?.click();

    expect(emitted[0].ref).toBe('feature/x');
  });

  it('disables submit when there is no mergeable ref', () => {
    const fixture = render({ branches: ['main'], currentBranch: 'main' });

    expect(innerButton(fixture, 'merge-submit').disabled).toBe(true);
    expect((query(fixture, 'merge-ref') as HTMLSelectElement).options[0].textContent).toContain(
      'No other branch',
    );
  });

  it('shows the conflict notice when the parent reports one', () => {
    const fixture = render({ conflict: { hasConflict: true, oid: 'abc' } });
    expect(query(fixture, 'merge-conflict')?.textContent).toContain('conflicts');
  });

  it('surfaces an error and disables actions while running', () => {
    const fixture = render({ running: true, error: { code: 'MERGE_FAILED', message: 'boom' } });

    expect(query(fixture, 'merge-error')?.textContent).toContain('boom');
    expect(innerButton(fixture, 'merge-submit').disabled).toBe(true);
    expect(innerButton(fixture, 'merge-cancel').disabled).toBe(true);
  });

  it('emits cancelled on dismiss', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    query(fixture, 'merge-cancel')?.click();

    expect(cancelled).toBe(1);
  });
});
