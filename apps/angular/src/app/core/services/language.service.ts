import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import {
  LANGUAGE_STORAGE_KEY,
  readStoredLanguage,
  type Language,
} from '@core/i18n/language';

/**
 * Reload seam injected so tests can assert the language switch reloads the page
 * without actually navigating jsdom.
 */
export const PAGE_RELOAD = new InjectionToken<() => void>('PAGE_RELOAD', {
  providedIn: 'root',
  factory: () => () => globalThis.location.reload(),
});

/**
 * Root language service: resolves the active {@link Language} and persists it
 * to localStorage.
 *
 * Unlike {@link ThemeService}, switching the language cannot be applied
 * reactively: `$localize` resolves each message once, at first evaluation, and
 * cannot be re-translated without reloading the renderer. `setLanguage`
 * therefore writes the preference synchronously *before* invoking the reload
 * seam, so the next bootstrap reads the new value even in zoneless mode.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly reload = inject(PAGE_RELOAD);

  private readonly state = signal<Language>(readStoredLanguage());
  readonly language = this.state.asReadonly();

  /** Select an explicit language. No-op when it is already active. */
  setLanguage(language: Language): void {
    if (language === this.state()) return;
    this.state.set(language);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Private mode / storage disabled: the reload still boots in English.
    }
    this.reload();
  }

  /** Flip between `en` and `es`. */
  toggle(): void {
    this.setLanguage(this.state() === 'en' ? 'es' : 'en');
  }
}
