import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppError } from '@core/services/ipc-bridge.service';
import { BranchCreateDialog } from './branch-create-dialog';
import type { BranchCreateValue } from './ref-dialog.models';

interface Options {
  open?: boolean;
  defaultStartPoint?: string;
  running?: boolean;
  error?: AppError | null;
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(BranchCreateDialog);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.componentRef.setInput('defaultStartPoint', options.defaultStartPoint ?? 'HEAD');
  fixture.componentRef.setInput('running', options.running ?? false);
  fixture.componentRef.setInput('error', options.error ?? null);
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ReturnType<typeof render>, testId: string): HTMLInputElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
    `[data-testid="${testId}"]`,
  );
}

function setInput(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

/** The native button inside the `<st-button>` host carrying `testId`. */
function innerButton(fixture: ReturnType<typeof render>, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

describe('BranchCreateDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'branch-create-name')).toBeNull();
  });

  it('seeds the start point from the caller default and defaults checkout on', () => {
    const fixture = render({ defaultStartPoint: 'abc123' });

    expect(query(fixture, 'branch-create-start')?.value).toBe('abc123');
    expect(query(fixture, 'branch-create-checkout')?.checked).toBe(true);
  });

  it('keeps the submit disabled until a name is entered', () => {
    const fixture = render();
    expect(innerButton(fixture, 'branch-create-submit').disabled).toBe(true);

    setInput(query(fixture, 'branch-create-name')!, 'feature/x');
    fixture.detectChanges();

    expect(innerButton(fixture, 'branch-create-submit').disabled).toBe(false);
  });

  it('emits the trimmed name, start point and checkout flag', () => {
    const fixture = render({ defaultStartPoint: 'develop' });
    const emitted: BranchCreateValue[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    setInput(query(fixture, 'branch-create-name')!, '  feature/login  ');
    fixture.detectChanges();
    query(fixture, 'branch-create-submit')?.click();

    expect(emitted).toEqual([{ name: 'feature/login', startPoint: 'develop', checkout: true }]);
  });

  it('carries a cleared checkout flag', () => {
    const fixture = render();
    const emitted: BranchCreateValue[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    setInput(query(fixture, 'branch-create-name')!, 'topic');
    const checkout = query(fixture, 'branch-create-checkout')!;
    checkout.checked = false;
    checkout.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    query(fixture, 'branch-create-submit')?.click();

    expect(emitted[0].checkout).toBe(false);
  });

  it('uses an edited start point', () => {
    const fixture = render({ defaultStartPoint: 'develop' });
    const emitted: BranchCreateValue[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    setInput(query(fixture, 'branch-create-name')!, 'topic');
    setInput(query(fixture, 'branch-create-start')!, '  abc123  ');
    fixture.detectChanges();
    query(fixture, 'branch-create-submit')?.click();

    expect(emitted[0].startPoint).toBe('abc123');
  });

  it('surfaces an error message from the parent', () => {
    const fixture = render({ error: { code: 'BRANCH_EXISTS', message: 'already exists' } });

    expect(query(fixture, 'branch-create-error')?.textContent).toContain('already exists');
  });

  it('emits cancelled on cancel and on Escape', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    query(fixture, 'branch-create-cancel')?.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cancelled).toBe(2);
  });

  it('disables both actions while running', () => {
    const fixture = render({ running: true });

    expect(innerButton(fixture, 'branch-create-submit').disabled).toBe(true);
    expect(innerButton(fixture, 'branch-create-cancel').disabled).toBe(true);
  });
});
