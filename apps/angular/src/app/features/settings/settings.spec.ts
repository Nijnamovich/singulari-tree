import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGE_STORAGE_KEY } from '@core/i18n/language';
import { DiffModeService } from '@core/services/diff-mode.service';
import { LanguageService, PAGE_RELOAD } from '@core/services/language.service';
import { PreferencesService } from '@core/services/preferences.service';
import { ThemeService } from '@core/services/theme.service';
import { Settings } from './settings';

/** jsdom does not copy `window.localStorage` onto `globalThis`; install a spyable one. */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  /** Keys touched by `setItem`/`removeItem`, so a test can prove nothing was written. */
  readonly written: string[] = [];

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
    this.written.push(key);
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.written.push(key);
    this.map.set(key, String(value));
  }
}

let storage: MemoryStorage;

function installStorage(): void {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

function query<T extends Element>(
  fixture: ComponentFixture<Settings>,
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

function host(fixture: ComponentFixture<Settings>, testId: string): HTMLElement {
  const el = query<HTMLElement>(fixture, testId);
  if (!el) throw new Error(`missing host ${testId}`);
  return el;
}

/** A segment of the toggle-group whose host owns `groupTestId`. */
function segment(
  fixture: ComponentFixture<Settings>,
  groupTestId: string,
  value: string,
): HTMLButtonElement {
  const el = host(fixture, groupTestId).querySelector<HTMLButtonElement>(
    `[data-testid="toggle-segment-${value}"]`,
  );
  if (!el) throw new Error(`missing segment ${groupTestId}/${value}`);
  return el;
}

/** The native `<select>` projected by the `st-select` host. */
function select(fixture: ComponentFixture<Settings>, hostTestId: string): HTMLSelectElement {
  const el = host(fixture, hostTestId).querySelector<HTMLSelectElement>('select');
  if (!el) throw new Error(`missing select ${hostTestId}`);
  return el;
}

/** The native `<button>` inside the `st-button` host. */
function innerButton(fixture: ComponentFixture<Settings>, hostTestId: string): HTMLButtonElement {
  const el = host(fixture, hostTestId).querySelector<HTMLButtonElement>('button');
  if (!el) throw new Error(`missing inner button ${hostTestId}`);
  return el;
}

function setup() {
  const reload = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: PAGE_RELOAD, useValue: reload },
    ],
  });

  const themeService = TestBed.inject(ThemeService);
  const languageService = TestBed.inject(LanguageService);
  const diffModeService = TestBed.inject(DiffModeService);
  const prefs = TestBed.inject(PreferencesService);
  const setTheme = vi.spyOn(themeService, 'setTheme');
  const setLanguage = vi.spyOn(languageService, 'setLanguage');
  const setMode = vi.spyOn(diffModeService, 'setMode');

  const fixture = TestBed.createComponent(Settings);
  fixture.detectChanges();
  return {
    fixture,
    themeService,
    languageService,
    diffModeService,
    prefs,
    setTheme,
    setLanguage,
    setMode,
    reload,
  };
}

describe('Settings', () => {
  beforeEach(() => {
    installStorage();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.removeAttribute('data-theme');
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('renders the title, the five grouped panels and their controls', () => {
    const { fixture } = setup();

    expect(query(fixture, 'settings')).not.toBeNull();
    for (const panel of [
      'settings-panel-appearance',
      'settings-panel-workspace',
      'settings-panel-diff',
      'settings-panel-language',
      'settings-about',
    ]) {
      expect(query(fixture, panel)).not.toBeNull();
    }
    for (const control of [
      'settings-theme',
      'settings-motion',
      'settings-density',
      'settings-reset-pane-width',
      'settings-diff-layout',
      'settings-diff-font-size',
      'settings-diff-word-wrap',
      'settings-language',
    ]) {
      expect(query(fixture, control)).not.toBeNull();
    }

    expect(segment(fixture, 'settings-theme', 'dark').textContent).toContain('Dark');
    expect(segment(fixture, 'settings-theme', 'light').textContent).toContain('Light');
    expect(segment(fixture, 'settings-language', 'en').textContent).toContain('EN');
    expect(segment(fixture, 'settings-language', 'es').textContent).toContain('ES');
  });

  // A repeated group label ("Preferences" on every panel) carried no
  // information; each panel now names its own group.
  it('labels every panel with a distinct eyebrow', () => {
    const { fixture } = setup();

    const labels = [
      'settings-panel-appearance',
      'settings-panel-workspace',
      'settings-panel-diff',
      'settings-panel-language',
      'settings-about',
    ].map((panel) => {
      const eyebrow = host(fixture, panel).querySelector('.st-eyebrow');
      expect(eyebrow).not.toBeNull();
      return (eyebrow?.textContent ?? '').trim();
    });

    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('reflects the persisted theme and language as active', () => {
    localStorage.setItem('st:theme', 'light');
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es');

    const { fixture } = setup();

    expect(segment(fixture, 'settings-theme', 'light').getAttribute('aria-pressed')).toBe('true');
    expect(segment(fixture, 'settings-theme', 'dark').getAttribute('aria-pressed')).toBe('false');
    expect(segment(fixture, 'settings-language', 'es').getAttribute('aria-pressed')).toBe('true');
    expect(segment(fixture, 'settings-language', 'en').getAttribute('aria-pressed')).toBe('false');
  });

  it('reflects the persisted preferences as active', () => {
    localStorage.setItem('st:motion', 'on');
    localStorage.setItem('st:density', 'comfortable');
    localStorage.setItem('st:paneWidth', '420');
    localStorage.setItem('st:diffFontSize', '13');
    localStorage.setItem('st:diffWordWrap', 'on');
    localStorage.setItem('st:diffMode', 'side-by-side');

    const { fixture } = setup();

    expect(segment(fixture, 'settings-motion', 'on').getAttribute('aria-pressed')).toBe('true');
    expect(segment(fixture, 'settings-density', 'comfortable').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      segment(fixture, 'settings-diff-layout', 'side-by-side').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(segment(fixture, 'settings-diff-word-wrap', 'on').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(select(fixture, 'settings-diff-font-size').value).toBe('13');
    expect(innerButton(fixture, 'settings-reset-pane-width').disabled).toBe(false);
  });

  it('applies the selected theme through ThemeService', () => {
    const { fixture, themeService, setTheme } = setup();

    segment(fixture, 'settings-theme', 'light').click();
    TestBed.tick();

    expect(setTheme).toHaveBeenCalledWith('light');
    expect(themeService.theme()).toBe('light');
    expect(segment(fixture, 'settings-theme', 'light').getAttribute('aria-pressed')).toBe('true');
  });

  it('selects the requested language through LanguageService', () => {
    const { fixture, languageService, setLanguage, reload } = setup();

    segment(fixture, 'settings-language', 'es').click();

    expect(setLanguage).toHaveBeenCalledWith('es');
    expect(languageService.language()).toBe('es');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the active language is selected again', () => {
    const { fixture, setLanguage, reload } = setup();

    segment(fixture, 'settings-language', 'en').click();

    expect(setLanguage).toHaveBeenCalledWith('en');
    expect(reload).not.toHaveBeenCalled();
  });

  it('writes the motion preference to st:motion', () => {
    const { fixture, prefs } = setup();

    segment(fixture, 'settings-motion', 'off').click();
    TestBed.tick();

    expect(prefs.motion()).toBe('off');
    expect(localStorage.getItem('st:motion')).toBe('off');
    expect(segment(fixture, 'settings-motion', 'off').getAttribute('aria-pressed')).toBe('true');
  });

  it('writes the density preference to st:density', () => {
    const { fixture, prefs } = setup();

    segment(fixture, 'settings-density', 'comfortable').click();
    TestBed.tick();

    expect(prefs.density()).toBe('comfortable');
    expect(localStorage.getItem('st:density')).toBe('comfortable');
  });

  it('keeps the pane-width reset disabled until a pane width exists, then clears it', () => {
    const { fixture, prefs } = setup();

    expect(innerButton(fixture, 'settings-reset-pane-width').disabled).toBe(true);

    prefs.setPaneWidth('420');
    fixture.detectChanges();
    expect(innerButton(fixture, 'settings-reset-pane-width').disabled).toBe(false);

    innerButton(fixture, 'settings-reset-pane-width').click();
    TestBed.tick();

    expect(prefs.paneWidth()).toBe('');
    expect(prefs.hasPaneWidth()).toBe(false);
    expect(localStorage.getItem('st:paneWidth')).toBeNull();
    expect(innerButton(fixture, 'settings-reset-pane-width').disabled).toBe(true);
  });

  it('drives the diff layout through DiffModeService', () => {
    const { fixture, diffModeService, setMode } = setup();

    segment(fixture, 'settings-diff-layout', 'side-by-side').click();
    TestBed.tick();

    expect(setMode).toHaveBeenCalledWith('side-by-side');
    expect(diffModeService.mode()).toBe('side-by-side');
    expect(localStorage.getItem('st:diffMode')).toBe('side-by-side');
    expect(
      segment(fixture, 'settings-diff-layout', 'side-by-side').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('writes the diff font size to st:diffFontSize', () => {
    const { fixture, prefs } = setup();

    const el = select(fixture, 'settings-diff-font-size');
    el.value = '11';
    el.dispatchEvent(new Event('change'));
    TestBed.tick();

    expect(prefs.diffFontSize()).toBe('11');
    expect(localStorage.getItem('st:diffFontSize')).toBe('11');
  });

  it('writes the diff word wrap preference to st:diffWordWrap', () => {
    const { fixture, prefs } = setup();

    segment(fixture, 'settings-diff-word-wrap', 'on').click();
    TestBed.tick();

    expect(prefs.diffWordWrap()).toBe('on');
    expect(localStorage.getItem('st:diffWordWrap')).toBe('on');
  });

  it('renders the About panel read-only, with no actions and no storage writes', () => {
    const { fixture } = setup();
    // Ignore whatever construction persisted (e.g. the ThemeService effect).
    storage.written.length = 0;

    const about = host(fixture, 'settings-about');

    expect(about.querySelectorAll('button, select, input, textarea').length).toBe(0);
    expect(about.textContent).toContain('SingulariTree');
    expect(about.textContent).toContain('Dark Neon / Developer Studio');
    expect(storage.written).toEqual([]);
  });
});
