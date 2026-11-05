import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreferencesService } from './preferences.service';

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

/** Storage that throws on every access, as in private mode / disabled storage. */
class ThrowingStorage implements Storage {
  get length(): number {
    throw new Error('storage disabled');
  }

  clear(): void {
    throw new Error('storage disabled');
  }

  getItem(): string | null {
    throw new Error('storage disabled');
  }

  key(): string | null {
    throw new Error('storage disabled');
  }

  removeItem(): void {
    throw new Error('storage disabled');
  }

  setItem(): void {
    throw new Error('storage disabled');
  }
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

function injectPrefs(): PreferencesService {
  return TestBed.inject(PreferencesService);
}

/** The `data-st-motion` attribute the service reflects onto `<html>`. */
function rootMotion(): string | null {
  return document.documentElement.getAttribute('data-st-motion');
}

/** The `data-st-density` attribute the service reflects onto `<html>`. */
function rootDensity(): string | null {
  return document.documentElement.getAttribute('data-st-density');
}

describe('PreferencesService', () => {
  beforeEach(() => {
    installStorage(new MemoryStorage());
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    // Clean the singleton DOM/localStorage state so specs never leak into each other.
    document.documentElement.removeAttribute('data-st-motion');
    document.documentElement.removeAttribute('data-st-density');
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('defaults every preference when nothing is persisted', () => {
    const prefs = injectPrefs();

    expect(prefs.motion()).toBe('auto');
    expect(prefs.density()).toBe('comfortable');
    expect(prefs.paneWidth()).toBe('');
    expect(prefs.diffFontSize()).toBe('12');
    expect(prefs.diffWordWrap()).toBe('off');
    expect(prefs.hasPaneWidth()).toBe(false);
  });

  it('does not set data-st-motion when the preference is auto', () => {
    const prefs = injectPrefs();

    expect(prefs.motion()).toBe('auto');
    expect(rootMotion()).toBeNull();
  });

  it('restores every persisted preference', () => {
    localStorage.setItem('st:motion', 'off');
    localStorage.setItem('st:density', 'comfortable');
    localStorage.setItem('st:paneWidth', '420');
    localStorage.setItem('st:diffFontSize', '11');
    localStorage.setItem('st:diffWordWrap', 'on');

    const prefs = injectPrefs();

    expect(prefs.motion()).toBe('off');
    expect(prefs.density()).toBe('comfortable');
    expect(prefs.paneWidth()).toBe('420');
    expect(prefs.diffFontSize()).toBe('11');
    expect(prefs.diffWordWrap()).toBe('on');
    expect(prefs.hasPaneWidth()).toBe(true);
  });

  it('restores the explicit motion "on" value', () => {
    localStorage.setItem('st:motion', 'on');

    expect(injectPrefs().motion()).toBe('on');
  });

  it('applies data-st-motion=on on construction from a persisted value', () => {
    localStorage.setItem('st:motion', 'on');

    injectPrefs();

    expect(rootMotion()).toBe('on');
  });

  it('applies data-st-motion=off on construction from a persisted value', () => {
    localStorage.setItem('st:motion', 'off');

    injectPrefs();

    expect(rootMotion()).toBe('off');
  });

  it('updates data-st-motion after setMotion settles through the effect', () => {
    const prefs = injectPrefs();
    expect(rootMotion()).toBeNull();

    prefs.setMotion('off');
    TestBed.tick();
    expect(rootMotion()).toBe('off');

    prefs.setMotion('on');
    TestBed.tick();
    expect(rootMotion()).toBe('on');
  });

  it('removes data-st-motion when switching back to auto', () => {
    localStorage.setItem('st:motion', 'off');
    const prefs = injectPrefs();
    expect(rootMotion()).toBe('off');

    prefs.setMotion('auto');
    TestBed.tick();

    expect(prefs.motion()).toBe('auto');
    expect(rootMotion()).toBeNull();
  });

  // -- data-st-density: enforced at runtime, always explicit ---------------

  it('applies data-st-density=comfortable on construction from a persisted value', () => {
    localStorage.setItem('st:density', 'comfortable');

    injectPrefs();

    expect(rootDensity()).toBe('comfortable');
  });

  it('applies the default comfortable density on construction when nothing is persisted', () => {
    injectPrefs();

    // No "follow the OS" state: the attribute is always written, never absent.
    expect(rootDensity()).toBe('comfortable');
  });

  it('updates data-st-density after setDensity settles through the effect', () => {
    const prefs = injectPrefs();
    expect(rootDensity()).toBe('comfortable');

    prefs.setDensity('compact');
    TestBed.tick();
    expect(rootDensity()).toBe('compact');

    prefs.setDensity('comfortable');
    TestBed.tick();
    // Both values are explicit, so the attribute is never removed.
    expect(rootDensity()).toBe('comfortable');
    expect(document.documentElement.hasAttribute('data-st-density')).toBe(true);
  });

  it('restores the explicit diff font size 13', () => {
    localStorage.setItem('st:diffFontSize', '13');

    expect(injectPrefs().diffFontSize()).toBe('13');
  });

  it('falls back to every default for invalid persisted values', () => {
    localStorage.setItem('st:motion', 'fast');
    localStorage.setItem('st:density', 'roomy');
    localStorage.setItem('st:paneWidth', 'wide');
    localStorage.setItem('st:diffFontSize', '99');
    localStorage.setItem('st:diffWordWrap', 'maybe');

    const prefs = injectPrefs();

    expect(prefs.motion()).toBe('auto');
    expect(prefs.density()).toBe('comfortable');
    expect(prefs.paneWidth()).toBe('');
    expect(prefs.diffFontSize()).toBe('12');
    expect(prefs.diffWordWrap()).toBe('off');
    expect(prefs.hasPaneWidth()).toBe(false);
  });

  it('rejects a non-positive pane width', () => {
    localStorage.setItem('st:paneWidth', '0');

    expect(injectPrefs().paneWidth()).toBe('');
  });

  it('defaults every preference when localStorage throws, without throwing from the constructor', () => {
    installStorage(new ThrowingStorage());

    const prefs = injectPrefs();

    expect(prefs.motion()).toBe('auto');
    expect(prefs.density()).toBe('comfortable');
    expect(prefs.paneWidth()).toBe('');
    expect(prefs.diffFontSize()).toBe('12');
    expect(prefs.diffWordWrap()).toBe('off');
  });

  it('persists every preference under its exact st: key', () => {
    const prefs = injectPrefs();

    prefs.setMotion('on');
    prefs.setDensity('comfortable');
    prefs.setPaneWidth('360');
    prefs.setDiffFontSize('13');
    prefs.setDiffWordWrap('on');

    expect(localStorage.getItem('st:motion')).toBe('on');
    expect(localStorage.getItem('st:density')).toBe('comfortable');
    expect(localStorage.getItem('st:paneWidth')).toBe('360');
    expect(localStorage.getItem('st:diffFontSize')).toBe('13');
    expect(localStorage.getItem('st:diffWordWrap')).toBe('on');
  });

  it('reflects every set preference through its signal', () => {
    const prefs = injectPrefs();

    prefs.setMotion('off');
    prefs.setDensity('comfortable');
    prefs.setPaneWidth('300');
    prefs.setDiffFontSize('11');
    prefs.setDiffWordWrap('on');

    expect(prefs.motion()).toBe('off');
    expect(prefs.density()).toBe('comfortable');
    expect(prefs.paneWidth()).toBe('300');
    expect(prefs.diffFontSize()).toBe('11');
    expect(prefs.diffWordWrap()).toBe('on');
  });

  it('clears the pane width on reset and reports it as absent', () => {
    const prefs = injectPrefs();
    prefs.setPaneWidth('420');
    expect(prefs.hasPaneWidth()).toBe(true);

    prefs.resetPaneWidth();

    expect(prefs.paneWidth()).toBe('');
    expect(prefs.hasPaneWidth()).toBe(false);
    expect(localStorage.getItem('st:paneWidth')).toBeNull();
  });

  it('does not throw when persisting or clearing fails', () => {
    const prefs = injectPrefs();
    prefs.setPaneWidth('420');
    installStorage(new ThrowingStorage());

    expect(() => prefs.setMotion('off')).not.toThrow();
    expect(() => prefs.setDensity('comfortable')).not.toThrow();
    expect(() => prefs.setPaneWidth('360')).not.toThrow();
    expect(() => prefs.setDiffFontSize('13')).not.toThrow();
    expect(() => prefs.setDiffWordWrap('on')).not.toThrow();
    expect(() => prefs.resetPaneWidth()).not.toThrow();

    expect(prefs.motion()).toBe('off');
    expect(prefs.paneWidth()).toBe('');
    expect(prefs.hasPaneWidth()).toBe(false);
  });
});
