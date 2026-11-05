import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeService } from './theme.service';

/** jsdom does not copy `window.localStorage` onto `globalThis`; install a spyable one. */
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

function injectTheme(): ThemeService {
  return TestBed.inject(ThemeService);
}

function rootTheme(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

describe('ThemeService', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    // Clean the singleton DOM/localStorage state so specs never leak into each other.
    document.documentElement.removeAttribute('data-theme');
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('defaults to dark and applies data-theme synchronously on construction', () => {
    const theme = injectTheme();

    expect(theme.theme()).toBe('dark');
    expect(rootTheme()).toBe('dark');
  });

  it('applies and persists a theme set through setTheme', () => {
    const theme = injectTheme();
    theme.setTheme('light');
    TestBed.tick();

    expect(theme.theme()).toBe('light');
    expect(rootTheme()).toBe('light');
    expect(localStorage.getItem('st:theme')).toBe('light');
  });

  it('toggle flips between dark and light', () => {
    const theme = injectTheme();
    expect(theme.theme()).toBe('dark');

    theme.toggle();
    TestBed.tick();
    expect(theme.theme()).toBe('light');
    expect(rootTheme()).toBe('light');

    theme.toggle();
    TestBed.tick();
    expect(theme.theme()).toBe('dark');
    expect(rootTheme()).toBe('dark');
  });

  it('restores a persisted light theme', () => {
    localStorage.setItem('st:theme', 'light');

    const theme = injectTheme();

    expect(theme.theme()).toBe('light');
    expect(rootTheme()).toBe('light');
  });

  it('falls back to dark for an invalid stored value', () => {
    localStorage.setItem('st:theme', 'neon');

    const theme = injectTheme();

    expect(theme.theme()).toBe('dark');
    expect(rootTheme()).toBe('dark');
  });

  it('reflects setTheme and toggle through the readonly theme signal', () => {
    const theme = injectTheme();

    theme.setTheme('light');
    expect(theme.theme()).toBe('light');

    theme.toggle();
    expect(theme.theme()).toBe('dark');
  });
});
