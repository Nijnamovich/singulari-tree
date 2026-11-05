import { DOCUMENT } from '@angular/core';
import { DestroyRef, Injectable, inject } from '@angular/core';

/** Normalized shortcut key: space is spelled `space`, everything else lowercase. */
export function normalizeKey(key: string): string {
  return key === ' ' ? 'space' : key.toLowerCase();
}

/**
 * Matches text-editable elements (self or ancestor): INPUT/TEXTAREA/SELECT and
 * elements whose `contenteditable` resolves to an editing state. Only truthy
 * values count — a bare `contenteditable="false"` must NOT be treated as
 * editable, so the attribute-presence test was replaced by explicit values.
 */
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * Matches interactive controls that own their own Enter/Space activation
 * (native buttons, links, role=button, form fields, summary, editable regions).
 * The global dispatcher must step aside for these so native keyboard activation
 * is not swallowed.
 */
const INTERACTIVE_SELECTOR =
  'button, a[href], [role="button"], input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** True when the event originates from a text-editable control. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * True when the event originates from an interactive control (or a descendant
 * of one). The global shortcut dispatcher skips these so the native
 * Enter/Space activation of buttons, links and role=button elements keeps
 * working; arrow keys still reach the graph when its body has focus.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

type ShortcutHandler = (event: KeyboardEvent) => void;

/**
 * Root keyboard-shortcut registry backed by a single `window` `keydown`
 * listener. Consumers register a normalized key and receive an unregister
 * function; the listener is removed on service destroy.
 *
 * The dispatcher ignores events that were already `defaultPrevented` or that
 * carry Ctrl/Meta/Alt modifiers, ignores editable and interactive targets
 * (native controls keep their own Enter/Space activation), and calls
 * `preventDefault()` only when a binding actually matches.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutService {
  private readonly document = inject(DOCUMENT);
  private readonly handlers = new Map<string, ShortcutHandler>();

  constructor() {
    const destroyRef = inject(DestroyRef);
    const win =
      this.document?.defaultView ?? (globalThis as { window?: Window }).window;
    if (!win) return;

    win.addEventListener('keydown', this.onKeyDown);
    destroyRef.onDestroy(() => win.removeEventListener('keydown', this.onKeyDown));
  }

  /** Register (or replace) a handler for `key`; returns an idempotent unregister. */
  register(key: string, handler: ShortcutHandler): () => void {
    const normalized = normalizeKey(key);
    this.handlers.set(normalized, handler);
    return () => {
      // Only remove our own binding so a replacement is never clobbered.
      if (this.handlers.get(normalized) === handler) {
        this.handlers.delete(normalized);
      }
    };
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    if (isInteractiveTarget(event.target)) return;

    const handler = this.handlers.get(normalizeKey(event.key));
    if (!handler) return;

    event.preventDefault();
    handler(event);
  };
}
