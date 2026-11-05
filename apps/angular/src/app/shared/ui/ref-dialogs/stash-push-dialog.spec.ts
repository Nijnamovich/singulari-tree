import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { StashPushDialog } from './stash-push-dialog';

interface Options {
  open?: boolean;
  running?: boolean;
  error?: { code: string; message: string } | null;
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(StashPushDialog);
  fixture.componentRef.setInput('open', options.open ?? true);
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

describe('StashPushDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'stash-push-message')).toBeNull();
  });

  it('emits the trimmed message', () => {
    const fixture = render();
    const emitted: string[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    const input = query(fixture, 'stash-push-message') as HTMLInputElement;
    input.value = '  WIP  ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    innerButton(fixture, 'stash-push-submit').click();

    expect(emitted).toEqual(['WIP']);
  });

  it('emits an empty message when left blank', () => {
    const fixture = render();
    const emitted: string[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    innerButton(fixture, 'stash-push-submit').click();

    expect(emitted).toEqual(['']);
  });

  it('surfaces an error and disables actions while running', () => {
    const fixture = render({ running: true, error: { code: 'STASH_FAILED', message: 'boom' } });

    expect(query(fixture, 'stash-push-error')?.textContent).toContain('boom');
    expect(innerButton(fixture, 'stash-push-submit').disabled).toBe(true);
    expect(innerButton(fixture, 'stash-push-cancel').disabled).toBe(true);
  });

  it('does not submit while running', () => {
    const fixture = render({ running: true });
    const emitted: string[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    innerButton(fixture, 'stash-push-submit').click();

    expect(emitted).toEqual([]);
  });

  it('emits cancelled on dismiss', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    innerButton(fixture, 'stash-push-cancel').click();

    expect(cancelled).toBe(1);
  });
});
