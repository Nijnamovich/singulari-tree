import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard, readClipboardText } from './clipboard';

/** Install a fake `navigator.clipboard` (jsdom ships none by default). */
function stubClipboard(impl: {
  writeText?: (text: string) => Promise<void>;
  readText?: () => Promise<string>;
}): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn(impl.writeText ?? (async () => {})),
      readText: vi.fn(impl.readText ?? (async () => '')),
    },
    configurable: true,
  });
}

/** Remove `navigator.clipboard` so the fallback path is exercised. */
function removeClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
}

/**
 * Guards the clipboard helpers (ADR-025): the async Clipboard API is preferred,
 * the hidden-textarea fallback covers jsdom/insecure contexts, and read degrades
 * to an empty string instead of throwing.
 */
describe('copyToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes through the async Clipboard API', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({ writeText });

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when the async API rejects', async () => {
    stubClipboard({ writeText: async () => Promise.reject(new Error('denied')) });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false when both paths fail', async () => {
    removeClipboard();
    Object.defineProperty(document, 'execCommand', {
      value: () => {
        throw new Error('nope');
      },
      configurable: true,
    });

    await expect(copyToClipboard('hello')).resolves.toBe(false);
  });
});

describe('readClipboardText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the clipboard text', async () => {
    stubClipboard({ readText: async () => 'git@github.com:org/repo.git' });

    await expect(readClipboardText()).resolves.toBe('git@github.com:org/repo.git');
  });

  it('returns an empty string when the API is unavailable', async () => {
    removeClipboard();

    await expect(readClipboardText()).resolves.toBe('');
  });

  it('returns an empty string for a non-string clipboard value', async () => {
    stubClipboard({ readText: async () => undefined as unknown as string });

    await expect(readClipboardText()).resolves.toBe('');
  });
});
