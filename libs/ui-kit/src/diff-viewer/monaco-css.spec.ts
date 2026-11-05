import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the lazy Monaco stylesheet loader (jsdom).
 *
 * jsdom never fetches a `<link>`'s href, so `load`/`error` never fire on their
 * own: every test dispatches the event manually. The module caches a
 * module-level promise, so each test resets the module registry to get a fresh
 * cache (the `doc` parameter drives an isolated document per test).
 */
type EnsureMonacoCss = (doc: Document) => Promise<void>;

let ensureMonacoCss: EnsureMonacoCss;
let doc: Document;

const MONACO_LINK = 'link[data-st-monaco-css]';

beforeEach(async () => {
  vi.resetModules();
  ({ ensureMonacoCss } = (await import('./monaco-css')) as { ensureMonacoCss: EnsureMonacoCss });
  doc = document.implementation.createHTMLDocument('monaco-css-test');
  const base = doc.createElement('base');
  base.href = 'http://localhost/app/';
  doc.head.appendChild(base);
});

function link(): HTMLLinkElement | null {
  return doc.querySelector<HTMLLinkElement>(MONACO_LINK);
}

describe('ensureMonacoCss', () => {
  it('appends exactly one stylesheet link resolved against the base URI', async () => {
    const ready = ensureMonacoCss(doc);

    const stylesheet = link();
    expect(stylesheet).not.toBeNull();
    expect(stylesheet?.rel).toBe('stylesheet');
    expect(stylesheet?.href).toBe('http://localhost/app/monaco.css');
    expect(doc.head.querySelectorAll(MONACO_LINK)).toHaveLength(1);

    stylesheet?.dispatchEvent(new Event('load'));
    await expect(ready).resolves.toBeUndefined();
  });

  it('resolves when the stylesheet loads', async () => {
    const ready = ensureMonacoCss(doc);
    link()?.dispatchEvent(new Event('load'));
    await expect(ready).resolves.toBeUndefined();
  });

  it('resolves on error so a blocked stylesheet never blocks Monaco', async () => {
    const ready = ensureMonacoCss(doc);
    link()?.dispatchEvent(new Event('error'));
    await expect(ready).resolves.toBeUndefined();
  });

  it('reuses the single link for concurrent and serial calls', async () => {
    const first = ensureMonacoCss(doc);
    const second = ensureMonacoCss(doc);

    expect(doc.head.querySelectorAll(MONACO_LINK)).toHaveLength(1);
    link()?.dispatchEvent(new Event('load'));
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    // Serial call after the cached promise resolved: still one link, no wait.
    await expect(ensureMonacoCss(doc)).resolves.toBeUndefined();
    expect(doc.head.querySelectorAll(MONACO_LINK)).toHaveLength(1);
  });
});
