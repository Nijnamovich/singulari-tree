import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { RefRenameDialog } from './ref-rename-dialog';

interface Options {
  open?: boolean;
  currentName?: string;
  running?: boolean;
  error?: { code: string; message: string } | null;
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(RefRenameDialog);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.componentRef.setInput('currentName', options.currentName ?? 'main');
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

describe('RefRenameDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'ref-rename-input')).toBeNull();
  });

  it('seeds the input with the current name', () => {
    const fixture = render({ currentName: 'feature/x' });

    expect(query(fixture, 'ref-rename-current')?.textContent).toContain('feature/x');
    expect(query(fixture, 'ref-rename-input')?.value).toBe('feature/x');
    // No change yet → submit stays disabled.
    expect(innerButton(fixture, 'ref-rename-submit').disabled).toBe(true);
  });

  it('emits the trimmed new name once it differs', () => {
    const fixture = render({ currentName: 'main' });
    const emitted: string[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    setInput(query(fixture, 'ref-rename-input')!, '  trunk  ');
    fixture.detectChanges();
    query(fixture, 'ref-rename-submit')?.click();

    expect(emitted).toEqual(['trunk']);
  });

  it('submits on Enter inside the input', () => {
    const fixture = render({ currentName: 'main' });
    let submitted = 0;
    fixture.componentInstance.submitted.subscribe(() => (submitted += 1));

    const input = query(fixture, 'ref-rename-input')!;
    setInput(input, 'trunk');
    fixture.detectChanges();
    // The Enter binding now lives on the `st-input` host, so the synthetic key
    // must bubble (a real keydown does) to reach it.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(submitted).toBe(1);
  });

  it('does not emit when the name is unchanged or empty', () => {
    const fixture = render({ currentName: 'main' });
    let submitted = 0;
    fixture.componentInstance.submitted.subscribe(() => (submitted += 1));

    setInput(query(fixture, 'ref-rename-input')!, 'main');
    fixture.detectChanges();
    query(fixture, 'ref-rename-submit')?.click();

    setInput(query(fixture, 'ref-rename-input')!, '   ');
    fixture.detectChanges();
    query(fixture, 'ref-rename-submit')?.click();

    expect(submitted).toBe(0);
  });

  it('surfaces an error and disables actions while running', () => {
    const fixture = render({
      running: true,
      error: { code: 'BRANCH_EXISTS', message: 'boom' },
    });

    expect(query(fixture, 'ref-rename-error')?.textContent).toContain('boom');
    expect(innerButton(fixture, 'ref-rename-submit').disabled).toBe(true);
    expect(innerButton(fixture, 'ref-rename-cancel').disabled).toBe(true);
  });

  it('emits cancelled on cancel', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    query(fixture, 'ref-rename-cancel')?.click();

    expect(cancelled).toBe(1);
  });

  it('does not submit while running', () => {
    const fixture = render({ currentName: 'main', running: true });
    let submitted = 0;
    fixture.componentInstance.submitted.subscribe(() => (submitted += 1));

    setInput(query(fixture, 'ref-rename-input')!, 'trunk');
    fixture.detectChanges();
    query(fixture, 'ref-rename-submit')?.click();

    expect(submitted).toBe(0);
  });
});
