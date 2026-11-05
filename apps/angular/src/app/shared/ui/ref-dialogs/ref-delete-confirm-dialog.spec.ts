import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { RefDeleteConfirmDialog, type RefDeleteKind } from './ref-delete-confirm-dialog';

interface Options {
  open?: boolean;
  kind?: RefDeleteKind;
  name?: string;
  showForce?: boolean;
  running?: boolean;
  error?: { code: string; message: string } | null;
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(RefDeleteConfirmDialog);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.componentRef.setInput('kind', options.kind ?? 'branch');
  fixture.componentRef.setInput('name', options.name ?? 'feature/x');
  fixture.componentRef.setInput('showForce', options.showForce ?? true);
  fixture.componentRef.setInput('running', options.running ?? false);
  fixture.componentRef.setInput('error', options.error ?? null);
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

describe('RefDeleteConfirmDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'ref-delete-warning')).toBeNull();
  });

  it('names the ref and confirms with an unarmed force flag by default', () => {
    const fixture = render({ kind: 'branch', name: 'feature/x' });
    const confirmed: boolean[] = [];
    fixture.componentInstance.confirmed.subscribe((v) => confirmed.push(v));

    expect(query(fixture, 'ref-delete-warning')?.textContent).toContain('feature/x');
    expect(query(fixture, 'ref-delete-force')).not.toBeNull();

    query(fixture, 'ref-delete-confirm')?.click();

    expect(confirmed).toEqual([false]);
  });

  it('carries the force flag once armed', () => {
    const fixture = render();
    const confirmed: boolean[] = [];
    fixture.componentInstance.confirmed.subscribe((v) => confirmed.push(v));

    const force = query(fixture, 'ref-delete-force') as HTMLInputElement;
    force.checked = true;
    force.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    query(fixture, 'ref-delete-confirm')?.click();

    expect(confirmed).toEqual([true]);
  });

  it('hides the force toggle for tags', () => {
    const fixture = render({ kind: 'tag', name: 'v1.0.0', showForce: false });

    expect(query(fixture, 'ref-delete-force')).toBeNull();
    expect(query(fixture, 'modal-title')?.textContent).toContain('Delete tag');
  });

  it('surfaces an error and disables actions while running', () => {
    const fixture = render({ running: true, error: { code: 'BRANCH_NOT_FOUND', message: 'gone' } });

    expect(query(fixture, 'ref-delete-error')?.textContent).toContain('gone');
    expect(innerButton(fixture, 'ref-delete-confirm').disabled).toBe(true);
    expect(innerButton(fixture, 'ref-delete-cancel').disabled).toBe(true);
  });

  it('emits cancelled on dismiss', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    query(fixture, 'ref-delete-cancel')?.click();

    expect(cancelled).toBe(1);
  });

  it('does not confirm while running', () => {
    const fixture = render({ running: true });
    let confirmed = 0;
    fixture.componentInstance.confirmed.subscribe(() => (confirmed += 1));

    query(fixture, 'ref-delete-confirm')?.click();

    expect(confirmed).toBe(0);
  });
});
