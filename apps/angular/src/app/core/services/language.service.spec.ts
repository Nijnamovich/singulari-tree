import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGE_STORAGE_KEY } from '@core/i18n/language';
import { LanguageService, PAGE_RELOAD } from './language.service';

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

function setup(): { service: LanguageService; reload: ReturnType<typeof vi.fn> } {
  const reload = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: PAGE_RELOAD, useValue: reload },
    ],
  });
  return { service: TestBed.inject(LanguageService), reload };
}

describe('LanguageService', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('defaults to English', () => {
    const { service } = setup();
    expect(service.language()).toBe('en');
  });

  it('restores a persisted Spanish preference', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es');
    const { service } = setup();
    expect(service.language()).toBe('es');
  });

  it('falls back to English for an invalid stored value', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'klingon');
    const { service } = setup();
    expect(service.language()).toBe('en');
  });

  it('persists and reloads once when the language changes', () => {
    const { service, reload } = setup();
    let observed: string | null = null;
    reload.mockImplementation(() => {
      observed = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    });

    service.setLanguage('es');

    expect(service.language()).toBe('es');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(observed).toBe('es');
  });

  it('does nothing when selecting the already-active language', () => {
    const { service, reload } = setup();

    service.setLanguage('en');

    expect(service.language()).toBe('en');
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it('toggle flips between English and Spanish', () => {
    const { service, reload } = setup();

    service.toggle();
    expect(service.language()).toBe('es');
    expect(reload).toHaveBeenCalledTimes(1);

    service.toggle();
    expect(service.language()).toBe('en');
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
