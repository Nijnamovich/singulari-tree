import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeShellState } from './app.config';
import { LANGUAGE_STORAGE_KEY } from './core/i18n/language';
import { LanguageService } from './core/services/language.service';
import { PreferencesService } from './core/services/preferences.service';
import { ThemeService } from './core/services/theme.service';

/** In-memory Storage stand-in (jsdom's localStorage is absent on globalThis). */
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

function installStorage(entries: Record<string, string>): void {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(entries)) storage.setItem(key, value);
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

/**
 * Boot-level coverage for the app-start initializer wired in `app.config.ts`.
 * `TestBed.runInInjectionContext` runs the same initializer body against the
 * root injector, so a regression that drops the persistence application is
 * caught here.
 */
describe('initializeShellState (app-start initializer)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-st-motion');
    document.documentElement.removeAttribute('data-st-density');
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-st-motion');
    document.documentElement.removeAttribute('data-st-density');
  });

  it('applies the persisted light theme and resolves the stored language at startup', () => {
    installStorage({ 'st:theme': 'light', [LANGUAGE_STORAGE_KEY]: 'es' });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    TestBed.runInInjectionContext(initializeShellState);

    expect(TestBed.inject(ThemeService).theme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(TestBed.inject(LanguageService).language()).toBe('es');
  });

  it('falls back to the dark default and English when nothing is persisted', () => {
    installStorage({});
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    TestBed.runInInjectionContext(initializeShellState);

    expect(TestBed.inject(ThemeService).theme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(TestBed.inject(LanguageService).language()).toBe('en');
  });

  it('applies a persisted motion preference at startup', () => {
    installStorage({ 'st:motion': 'off' });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    TestBed.runInInjectionContext(initializeShellState);

    expect(TestBed.inject(PreferencesService).motion()).toBe('off');
    expect(document.documentElement.getAttribute('data-st-motion')).toBe('off');
  });

  it('applies a persisted density preference at startup', () => {
    installStorage({ 'st:density': 'comfortable' });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    TestBed.runInInjectionContext(initializeShellState);

    expect(TestBed.inject(PreferencesService).density()).toBe('comfortable');
    expect(document.documentElement.getAttribute('data-st-density')).toBe('comfortable');
  });

  it('applies the default comfortable density at startup when nothing is persisted', () => {
    installStorage({});
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    TestBed.runInInjectionContext(initializeShellState);

    // Density has no "follow the OS" state, so <html> always carries it.
    expect(TestBed.inject(PreferencesService).density()).toBe('comfortable');
    expect(document.documentElement.getAttribute('data-st-density')).toBe('comfortable');
  });
});
