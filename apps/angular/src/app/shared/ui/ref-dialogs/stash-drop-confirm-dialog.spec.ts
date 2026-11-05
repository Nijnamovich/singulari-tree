import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { StashDropConfirmDialog } from './stash-drop-confirm-dialog';

interface Options {
  open?: boolean;
  index?: number;
  message?: string;
  running?: boolean;
  error?: { code: string; message: string } | null;
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(StashDropConfirmDialog);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.componentRef.setInput('index', options.index ?? 0);
  fixture.componentRef.setInput('message', options.message ?? '');
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

/** `st-button` forwards disabled/click to its inner native `<button>` (repo-relocate-panel convention). */
function innerButton(fixture: ReturnType<typeof render>, testId: string): HTMLButtonElement {
  return query(fixture, testId)!.querySelector('button') as HTMLButtonElement;
}

describe('StashDropConfirmDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'stash-drop-warning')).toBeNull();
  });

  it('shows the stash label and message', () => {
    const fixture = render({ index: 2, message: 'WIP on main' });

    expect(query(fixture, 'stash-drop-warning')?.textContent).toContain('stash@{2}');
    expect(query(fixture, 'stash-drop-message')?.textContent).toContain('WIP on main');
  });

  it('hides the message line when the stash has no message', () => {
    const fixture = render({ index: 1 });
    expect(query(fixture, 'stash-drop-message')).toBeNull();
  });

  it('emits confirmed on drop', () => {
    const fixture = render();
    let confirmed = 0;
    fixture.componentInstance.confirmed.subscribe(() => (confirmed += 1));

    innerButton(fixture, 'stash-drop-confirm').click();

    expect(confirmed).toBe(1);
  });

  it('surfaces an error and disables actions while running', () => {
    const fixture = render({ running: true, error: { code: 'STASH_FAILED', message: 'boom' } });

    expect(query(fixture, 'stash-drop-error')?.textContent).toContain('boom');
    expect(innerButton(fixture, 'stash-drop-confirm').disabled).toBe(true);
    expect(innerButton(fixture, 'stash-drop-cancel').disabled).toBe(true);
  });

  it('does not confirm while running', () => {
    const fixture = render({ running: true });
    let confirmed = 0;
    fixture.componentInstance.confirmed.subscribe(() => (confirmed += 1));

    innerButton(fixture, 'stash-drop-confirm').click();

    expect(confirmed).toBe(0);
  });

  it('emits cancelled on dismiss', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    innerButton(fixture, 'stash-drop-cancel').click();

    expect(cancelled).toBe(1);
  });
});
