/// <reference types="node" />
import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { clearTranslations, loadTranslations, ɵcomputeMsgId } from '@angular/localize';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

@Component({
  selector: 'st-i18n-probe',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <span i18n>Localized probe</span> `,
})
class I18nProbe {}

@Component({
  selector: 'st-i18n-fallback-probe',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <span i18n>Untranslated probe</span> `,
})
class I18nFallbackProbe {}

/**
 * Proves the binding decision behind this slice: with a single English build in
 * runtime `$localize` mode, calling `loadTranslations` before component creation
 * replaces template `i18n` messages without rebuilding per locale.
 */
describe('runtime i18n', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    // `$localize` state is process-wide under the vitest unit-test builder; never
    // leak the probe translation into other spec files.
    clearTranslations();
  });

  it('translates template i18n messages loaded at runtime', async () => {
    const id = ɵcomputeMsgId('Localized probe');
    loadTranslations({ [id]: 'Sonda localizada' });

    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    const fixture = TestBed.createComponent(I18nProbe);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Sonda localizada');
  });

  it('falls back to the source message when no translation is loaded', async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    const fixture = TestBed.createComponent(I18nFallbackProbe);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Untranslated probe');
  });
});

interface MessageCatalogue {
  locale: string;
  translations: Record<string, string>;
}

/** Read a generated extractor catalogue from disk (`resolveJsonModule` is off, so no JSON import). */
function readCatalogue(fileName: string): MessageCatalogue {
  return JSON.parse(readFileSync(cataloguePath(fileName), 'utf8')) as MessageCatalogue;
}

/**
 * Locate a generated catalogue under `src/locale/` by walking up from the runner's
 * cwd: the unit-test builder serves specs under virtual `/src/**` URLs, so
 * `import.meta.url` cannot reach the real files on disk.
 */
function cataloguePath(fileName: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidates = [
      resolve(dir, 'src/locale', fileName),
      resolve(dir, 'apps/angular/src/locale', fileName),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`locale catalogue not found: ${fileName}`);
    dir = parent;
  }
}

const sourceCatalogue = readCatalogue('messages.json');
const spanishCatalogue = readCatalogue('messages.es.json');

/**
 * Guards the P6 facelift contract at the catalogue level: the English and Spanish
 * extractor outputs must carry exactly the same ids, and the newly added facelift
 * messages must resolve in both, so a locale switch never drops a label.
 */
describe('locale catalogues', () => {
  const sourceIds = Object.keys(sourceCatalogue.translations);
  const spanishIds = Object.keys(spanishCatalogue.translations);

  it('declares the expected source and target locales', () => {
    expect(sourceCatalogue.locale).toBe('en-US');
    expect(spanishCatalogue.locale).toBe('es-ES');
  });

  it('keeps Spanish in exact id parity with the English source', () => {
    const sourceSet = new Set(sourceIds);
    const spanishSet = new Set(spanishIds);

    expect(spanishIds.length).toBe(sourceIds.length);
    expect(sourceIds.filter((id) => !spanishSet.has(id))).toEqual([]);
    expect(spanishIds.filter((id) => !sourceSet.has(id))).toEqual([]);
  });

  // Representative sample of messages introduced by the facelift phases.
  const newMessages = [
    'Pin repositories',
    'Review changes',
    'Synced',
    'Commit analyzer',
    'Commit / author',
    // Plain (non-interpolated) strings added by the graph / diff / file-status pass.
    'Lock commit',
    'Unlock commit',
    'Show in graph',
    'Filter files',
    'Filter changed files',
    'Select changed line',
    'Description',
    'Files',
    'Description or changed files',
    // Commit-details redesign: metadata disclosure, padlock tooltip and the
    // neighbouring sync affordance.
    'Metadata',
    'Locking pins this commit: the details panel keeps showing it after the graph reloads, and while the lock is on, selecting a different commit is refused.',
    'Sync',
    'Fetching repository',
    // Settled per-repository fetch states.
    'Repository up to date',
    'Fetch failed',
    // Commit-details UX pass: the release control's new label and the two
    // delayed nav tooltips.
    'Close',
    'collapse panel',
    'follow commit',
  ];

  it.each(newMessages)('resolves the new message %j in both catalogues', (message) => {
    const id = ɵcomputeMsgId(message);

    expect(sourceCatalogue.translations[id]).toBe(message);
    expect(spanishCatalogue.translations[id]).toBeTruthy();
  });
});
