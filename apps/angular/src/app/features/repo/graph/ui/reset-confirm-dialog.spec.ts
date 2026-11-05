import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ResetConfirmDialog } from './reset-confirm-dialog';

function render(open = true, oid: string | null = 'a'.repeat(40), busy = false) {
  const fixture = TestBed.createComponent(ResetConfirmDialog);
  fixture.componentRef.setInput('open', open);
  fixture.componentRef.setInput('oid', oid);
  fixture.componentRef.setInput('busy', busy);
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ReturnType<typeof render>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

/** `st-button` forwards the control to its inner native `<button>` (repo-relocate-panel convention). */
function innerButton(fixture: ReturnType<typeof render>, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

describe('ResetConfirmDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render(false);
    expect(query(fixture, 'reset-confirm-warning')).toBeNull();
  });

  it('warns about the destructive hard reset and names the target oid', () => {
    const fixture = render(true, 'b'.repeat(40));

    expect(query(fixture, 'reset-confirm-warning')?.textContent).toContain(
      'discards every working-tree change',
    );
    expect(query(fixture, 'reset-confirm-oid')?.textContent).toContain('b'.repeat(40));
  });

  it('emits confirmed when the destructive action is accepted', () => {
    const fixture = render();
    let confirmed = 0;
    fixture.componentInstance.confirmed.subscribe(() => (confirmed += 1));

    innerButton(fixture, 'reset-confirm-confirm').click();

    expect(confirmed).toBe(1);
  });

  it('emits cancelled when dismissed', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    innerButton(fixture, 'reset-confirm-cancel').click();

    expect(cancelled).toBe(1);
  });

  it('emits cancelled on Escape', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cancelled).toBe(1);
  });

  it('disables both actions while busy', () => {
    const fixture = render(true, 'a'.repeat(40), true);

    expect(innerButton(fixture, 'reset-confirm-confirm').disabled).toBe(true);
    expect(innerButton(fixture, 'reset-confirm-cancel').disabled).toBe(true);
  });
});
