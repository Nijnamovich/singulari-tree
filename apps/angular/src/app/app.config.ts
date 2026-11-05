import { inject, provideAppInitializer, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withEnabledBlockingInitialNavigation } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { LanguageService } from './core/services/language.service';
import { PreferencesService } from './core/services/preferences.service';
import { ThemeService } from './core/services/theme.service';
import { routes } from './app.routes';

/**
 * Application-start initializer: instantiate the root shell-state services so
 * persisted state is applied before the user opens Settings — a persisted
 * `light` theme lands on `data-theme`, the stored language is resolved, and a
 * persisted `st:motion` (e.g. `off`) is enforced on `data-st-motion` at boot.
 *
 * Exported as a named function so the initializer's effect on persistence can be
 * covered directly by a boot-level spec.
 */
export function initializeShellState(): void {
  inject(ThemeService);
  inject(LanguageService);
  inject(PreferencesService);
}

export const appConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withEnabledBlockingInitialNavigation()),
    provideHttpClient(withFetch()),
    provideAppInitializer(initializeShellState),
  ],
};
