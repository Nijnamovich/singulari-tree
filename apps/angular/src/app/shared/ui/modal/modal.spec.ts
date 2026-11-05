/// <reference types="node" />
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ModalComponent } from './modal';

interface SetupOptions {
  open?: boolean;
  title?: string;
  closeOnBackdrop?: boolean;
}

async function setup(opts: SetupOptions = {}): Promise<ComponentFixture<ModalComponent>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(ModalComponent);
  const ref = fixture.componentRef;
  ref.setInput('open', opts.open ?? true);
  ref.setInput('title', opts.title ?? '');
  if (opts.closeOnBackdrop !== undefined) ref.setInput('closeOnBackdrop', opts.closeOnBackdrop);
  fixture.detectChanges();
  return fixture;
}

function query<T extends Element>(
  fixture: ComponentFixture<ModalComponent>,
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

/**
 * Host that projects real content into the modal's body and footer slots, so the
 * focus trap sees more than the single close button.
 */
@Component({
  standalone: true,
  imports: [ModalComponent],
  template: `
    <st-modal [open]="open()" title="Trap">
      <button type="button" data-testid="host-body">body</button>
      <button type="button" st-modal-footer data-testid="host-footer">footer</button>
    </st-modal>
  `,
})
class TrapHostComponent {
  readonly open = signal(true);
}

/** Locate the ui-kit token source by walking up from the runner's cwd. */
function findTokensPath(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, 'libs/ui-kit/src/styles/tokens.scss');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('ui-kit token source not found');
    dir = parent;
  }
}

/** The modal's source tokens live in the ui-kit stylesheet, read from disk as text. */
const TOKENS_PATH = findTokensPath();

/** Resolve a semantic token's declared (dark) value straight from `tokens.scss`. */
function tokenValue(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = readFileSync(TOKENS_PATH, 'utf8').match(
    new RegExp(`${escaped}\\s*:\\s*([^;]+);`),
  );
  return match ? match[1].trim() : null;
}

/** Every injected `<style>` (component styles); whitespace collapsed for matching. */
function injectedStyles(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n')
    .replace(/\s+/g, ' ');
}

describe('ModalComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing while closed', async () => {
    const fixture = await setup({ open: false, title: 'Fetch' });

    expect(query(fixture, 'modal')).toBeNull();
    expect(query(fixture, 'modal-title')).toBeNull();
  });

  it('renders the title when open', async () => {
    const fixture = await setup({ open: true, title: 'Fetch remotes' });

    expect(query(fixture, 'modal')).not.toBeNull();
    expect(query(fixture, 'modal-title')?.textContent?.trim()).toBe('Fetch remotes');
    expect(query(fixture, 'modal')?.getAttribute('aria-modal')).toBe('true');
  });

  it('emits closed when the close button is clicked', async () => {
    const fixture = await setup();
    let emitted = 0;
    fixture.componentInstance.closed.subscribe(() => emitted++);

    query<HTMLButtonElement>(fixture, 'modal-close')?.click();

    expect(emitted).toBe(1);
  });

  it('emits closed on Escape while open', async () => {
    const fixture = await setup();
    let emitted = 0;
    fixture.componentInstance.closed.subscribe(() => emitted++);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(emitted).toBe(1);
  });

  it('ignores Escape while closed', async () => {
    const fixture = await setup({ open: false });
    let emitted = 0;
    fixture.componentInstance.closed.subscribe(() => emitted++);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(emitted).toBe(0);
  });

  it('emits closed when the backdrop is clicked', async () => {
    const fixture = await setup();
    let emitted = 0;
    fixture.componentInstance.closed.subscribe(() => emitted++);

    query<HTMLElement>(fixture, 'modal-backdrop')?.click();

    expect(emitted).toBe(1);
  });

  it('does not close on backdrop click when closeOnBackdrop is false', async () => {
    const fixture = await setup({ closeOnBackdrop: false });
    let emitted = 0;
    fixture.componentInstance.closed.subscribe(() => emitted++);

    query<HTMLElement>(fixture, 'modal-backdrop')?.click();

    expect(emitted).toBe(0);
  });

  it('does not close when a click originates inside the panel', async () => {
    const fixture = await setup();
    let emitted = 0;
    fixture.componentInstance.closed.subscribe(() => emitted++);

    query<HTMLElement>(fixture, 'modal')?.click();

    expect(emitted).toBe(0);
  });

  // -- focus management (P5) ------------------------------------------------

  it('moves focus into the dialog when it opens', async () => {
    const fixture = await setup({ open: true });
    // The focus move is deferred one microtask so the `@if` node exists.
    await Promise.resolve();

    const panel = query(fixture, 'modal');
    expect(panel?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel);
  });

  it('restores focus to the previously focused element after close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    try {
      const fixture = await setup({ open: true });
      await Promise.resolve();
      expect(document.activeElement).toBe(query(fixture, 'modal'));

      fixture.componentRef.setInput('open', false);
      fixture.detectChanges();

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it('does not move focus on the initial closed render', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    try {
      await setup({ open: false });
      await Promise.resolve();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it('traps Tab inside the dialog while open', async () => {
    const fixture = TestBed.createComponent(TrapHostComponent);
    fixture.detectChanges();
    await Promise.resolve();

    const hostEl = fixture.nativeElement as HTMLElement;
    const close = hostEl.querySelector<HTMLElement>('[data-testid="modal-close"]')!;
    const body = hostEl.querySelector<HTMLElement>('[data-testid="host-body"]')!;
    const footer = hostEl.querySelector<HTMLElement>('[data-testid="host-footer"]')!;

    // The close button is the first focusable element; the footer is the last.
    footer.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(document.activeElement).toBe(close);

    body.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(document.activeElement).toBe(footer);
  });

  it('wraps Shift+Tab backwards inside the dialog while open', async () => {
    const fixture = TestBed.createComponent(TrapHostComponent);
    fixture.detectChanges();
    await Promise.resolve();

    const hostEl = fixture.nativeElement as HTMLElement;
    const close = hostEl.querySelector<HTMLElement>('[data-testid="modal-close"]')!;
    const footer = hostEl.querySelector<HTMLElement>('[data-testid="host-footer"]')!;

    close.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
    expect(document.activeElement).toBe(footer);
  });

  it('leaves Tab untouched while closed', async () => {
    const fixture = await setup({ open: false });
    await Promise.resolve();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));

    // No panel exists, so nothing intercepts or moves focus.
    expect(query(fixture, 'modal')).toBeNull();
  });

  it('consumes the overlay and modal z-scale tokens', async () => {
    await setup({ open: true });

    // The single source of truth for the values.
    expect(tokenValue('--st-z-modal')).toBe('100');

    // jsdom does not resolve `var()`, so assert the declared panel rules that
    // consume the semantic layer (stable under jsdom).
    const styles = injectedStyles();
    expect(styles).toContain('.st-modal__backdrop');
    expect(styles).toMatch(/\.st-modal__backdrop[^{]*\{[^}]*z-index:\s*var\(--st-z-modal\)/);
    expect(styles).toMatch(/\.st-modal__backdrop[^{]*\{[^}]*background:\s*var\(--st-color-overlay\)/);
    expect(styles).toMatch(/\.st-modal\[[^\]]*\][^{]*\{[^}]*background:\s*var\(--st-color-raised\)/);
  });
});
