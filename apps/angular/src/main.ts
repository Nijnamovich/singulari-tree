import { registerLocaleData } from '@angular/common';
import localeEs from '@angular/common/locales/es';
import { LOCALE_ID } from '@angular/core';
import { loadTranslations } from '@angular/localize';
import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import {
  localeIdFor,
  readStoredLanguage,
  unwrapTranslations,
  type Language,
  type TranslationDocument,
} from './app/core/i18n/language';

/**
 * Load the translation catalogue for `language`.
 *
 * English is the source/default locale and needs no catalogue. Spanish ships as
 * a renderer asset (`locale/messages.es.json`); any failure falls back to
 * English rather than blocking bootstrap.
 */
async function loadTranslationsFor(language: Language): Promise<void> {
  if (language !== 'es') return;
  try {
    const response = await fetch('/locale/messages.es.json');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const document = (await response.json()) as TranslationDocument;
    loadTranslations(unwrapTranslations(document));
  } catch (error) {
    console.warn('[i18n] Could not load Spanish translations; using English.', error);
  }
}

async function bootstrap(): Promise<void> {
  const language = readStoredLanguage();
  if (language === 'es') {
    registerLocaleData(localeEs, 'es-ES');
  }
  await loadTranslationsFor(language);

  await bootstrapApplication(App, {
    ...appConfig,
    providers: [
      ...appConfig.providers,
      { provide: LOCALE_ID, useValue: localeIdFor(language) },
    ],
  });
}

bootstrap().catch((error) => console.error(error));
