import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TagCreateDialog } from './tag-create-dialog';
import type { TagCreateValue } from './ref-dialog.models';

interface Options {
  open?: boolean;
  defaultTarget?: string;
  running?: boolean;
  error?: { code: string; message: string } | null;
}

function render(options: Options = {}) {
  const fixture = TestBed.createComponent(TagCreateDialog);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.componentRef.setInput('defaultTarget', options.defaultTarget ?? 'HEAD');
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

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

describe('TagCreateDialog', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders nothing while closed', () => {
    const fixture = render({ open: false });
    expect(query(fixture, 'tag-create-name')).toBeNull();
  });

  it('seeds the target from the caller default', () => {
    const fixture = render({ defaultTarget: 'abc123' });
    expect((query(fixture, 'tag-create-target') as HTMLInputElement).value).toBe('abc123');
  });

  it('emits lightweight-tag values without a message', () => {
    const fixture = render({ defaultTarget: 'HEAD' });
    const emitted: TagCreateValue[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    setValue(query(fixture, 'tag-create-name') as HTMLInputElement, 'v1.0.0');
    fixture.detectChanges();
    innerButton(fixture, 'tag-create-submit').click();

    expect(emitted).toEqual([
      { name: 'v1.0.0', target: 'HEAD', annotated: false, message: '', force: false },
    ]);
  });

  it('requires a message when annotated and carries force', () => {
    const fixture = render();
    const emitted: TagCreateValue[] = [];
    fixture.componentInstance.submitted.subscribe((v) => emitted.push(v));

    setValue(query(fixture, 'tag-create-name') as HTMLInputElement, 'v2.0.0');
    const annotated = query(fixture, 'tag-create-annotated') as HTMLInputElement;
    annotated.checked = true;
    annotated.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    // Message required → submit stays disabled.
    expect(innerButton(fixture, 'tag-create-submit').disabled).toBe(true);

    setValue(query(fixture, 'tag-create-message') as HTMLTextAreaElement, '  release notes  ');
    const force = query(fixture, 'tag-create-force') as HTMLInputElement;
    force.checked = true;
    force.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    innerButton(fixture, 'tag-create-submit').click();

    expect(emitted).toEqual([
      { name: 'v2.0.0', target: 'HEAD', annotated: true, message: 'release notes', force: true },
    ]);
  });

  it('surfaces an error and disables actions while running', () => {
    const fixture = render({ running: true, error: { code: 'TAG_EXISTS', message: 'tag exists' } });

    expect(query(fixture, 'tag-create-error')?.textContent).toContain('tag exists');
    expect(innerButton(fixture, 'tag-create-submit').disabled).toBe(true);
    expect(innerButton(fixture, 'tag-create-cancel').disabled).toBe(true);
  });

  it('emits cancelled on dismiss', () => {
    const fixture = render();
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    innerButton(fixture, 'tag-create-cancel').click();

    expect(cancelled).toBe(1);
  });

  it('does not submit while running', () => {
    const fixture = render({ running: true });
    let submitted = 0;
    fixture.componentInstance.submitted.subscribe(() => (submitted += 1));

    setValue(query(fixture, 'tag-create-name') as HTMLInputElement, 'v9');
    fixture.detectChanges();
    innerButton(fixture, 'tag-create-submit').click();

    expect(submitted).toBe(0);
  });
});
