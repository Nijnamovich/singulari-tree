import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffModeService } from './diff-mode.service';

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

function injectDiffMode(): DiffModeService {
  return TestBed.inject(DiffModeService);
}

describe('DiffModeService', () => {
  beforeEach(() => {
    installStorage(new MemoryStorage());
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('defaults to unified when nothing is persisted', () => {
    const diffMode = injectDiffMode();

    expect(diffMode.mode()).toBe('unified');
    expect(diffMode.sideBySide()).toBe(false);
  });

  it('defaults to unified for an invalid stored value', () => {
    localStorage.setItem('st:diffMode', 'triple');

    const diffMode = injectDiffMode();

    expect(diffMode.mode()).toBe('unified');
    expect(diffMode.sideBySide()).toBe(false);
  });

  it('defaults to unified when localStorage throws, without throwing from the constructor', () => {
    installStorage(new ThrowingStorage());

    const diffMode = injectDiffMode();

    expect(diffMode.mode()).toBe('unified');
    expect(diffMode.sideBySide()).toBe(false);
  });

  it('persists and reflects a mode set through setMode', () => {
    const diffMode = injectDiffMode();

    diffMode.setMode('side-by-side');

    expect(diffMode.mode()).toBe('side-by-side');
    expect(diffMode.sideBySide()).toBe(true);
    expect(localStorage.getItem('st:diffMode')).toBe('side-by-side');
  });

  it('does not throw when persisting fails', () => {
    const diffMode = injectDiffMode();
    installStorage(new ThrowingStorage());

    expect(() => diffMode.setMode('side-by-side')).not.toThrow();
    expect(diffMode.mode()).toBe('side-by-side');
  });

  it('restores a persisted side-by-side mode', () => {
    localStorage.setItem('st:diffMode', 'side-by-side');

    const diffMode = injectDiffMode();

    expect(diffMode.mode()).toBe('side-by-side');
    expect(diffMode.sideBySide()).toBe(true);
  });

  it('toggle flips between unified and side-by-side', () => {
    const diffMode = injectDiffMode();
    expect(diffMode.mode()).toBe('unified');

    diffMode.toggle();
    expect(diffMode.mode()).toBe('side-by-side');
    expect(diffMode.sideBySide()).toBe(true);
    expect(localStorage.getItem('st:diffMode')).toBe('side-by-side');

    diffMode.toggle();
    expect(diffMode.mode()).toBe('unified');
    expect(diffMode.sideBySide()).toBe(false);
    expect(localStorage.getItem('st:diffMode')).toBe('unified');
  });

  it('reports sideBySide only for the side-by-side mode', () => {
    const diffMode = injectDiffMode();

    diffMode.setMode('unified');
    expect(diffMode.sideBySide()).toBe(false);

    diffMode.setMode('side-by-side');
    expect(diffMode.sideBySide()).toBe(true);
  });
});
