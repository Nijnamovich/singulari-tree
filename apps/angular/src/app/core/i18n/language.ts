/**
 * Pure i18n helpers for the renderer.
 *
 * The renderer ships a single English build (Angular's runtime `$localize`
 * mode). English is the default locale; Spanish is loaded at bootstrap from
 * `assets/locale/messages.es.json` when the persisted language is `es`.
 */

/** Supported renderer languages. */
export type Language = 'en' | 'es';

/** localStorage key for the persisted language (matches the `st:` convention). */
export const LANGUAGE_STORAGE_KEY = 'st:language';

/** Shape emitted by the JSON i18n extractor (`{ locale, translations }`). */
export interface TranslationDocument {
  readonly locale: string;
  readonly translations: Record<string, string>;
}

/** Read the persisted language, validating against the supported set. */
export function readStoredLanguage(): Language {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'es' ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

/** Map a {@link Language} to the Angular `LOCALE_ID` used for formatting. */
export function localeIdFor(language: Language): 'en-US' | 'es-ES' {
  return language === 'es' ? 'es-ES' : 'en-US';
}

/**
 * Unwrap the extractor's `{ locale, translations }` document into the flat
 * message-id → translation map expected by `loadTranslations`.
 */
export function unwrapTranslations(
  doc: TranslationDocument | null | undefined,
): Record<string, string> {
  return doc?.translations ?? {};
}
