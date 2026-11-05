import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LANGUAGE_STORAGE_KEY,
  localeIdFor,
  readStoredLanguage,
  unwrapTranslations,
} from './language';

/** jsdom does not expose `window.localStorage` on `globalThis`; install a spyable one. */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

describe('i18n language helpers', () => {
  beforeEach(() => {
    installStorage(new MemoryStorage());
  });

  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('defaults to English when nothing is stored', () => {
    expect(readStoredLanguage()).toBe('en');
  });

  it('restores a persisted Spanish preference', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es');
    expect(readStoredLanguage()).toBe('es');
  });

  it('falls back to English for an unsupported stored value', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
    expect(readStoredLanguage()).toBe('en');
  });

  it('falls back to English when storage access throws', () => {
    installStorage({
      length: 0,
      clear() {},
      getItem(): string | null {
        throw new Error('storage disabled');
      },
      key(): string | null {
        return null;
      },
      removeItem() {},
      setItem() {},
    } as Storage);

    expect(readStoredLanguage()).toBe('en');
  });

  it('maps languages to Angular locale ids', () => {
    expect(localeIdFor('en')).toBe('en-US');
    expect(localeIdFor('es')).toBe('es-ES');
  });

  it('unwraps the extractor document into a flat translation map', () => {
    expect(unwrapTranslations({ locale: 'es', translations: { a: 'A' } })).toEqual({ a: 'A' });
  });

  it('unwraps missing documents to an empty map', () => {
    expect(unwrapTranslations(null)).toEqual({});
    expect(unwrapTranslations(undefined)).toEqual({});
  });
});
