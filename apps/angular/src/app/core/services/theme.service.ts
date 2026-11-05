import { DOCUMENT } from '@angular/core';
import { Injectable, effect, inject, signal } from '@angular/core';

/** Selectable application themes. */
export type Theme = 'dark' | 'light';

/** localStorage key for the persisted theme (matches the `st:` shell convention). */
const THEME_STORAGE_KEY = 'st:theme';

/**
 * Root theme service: resolves the active {@link Theme}, applies it to
 * `document.documentElement[data-theme]` and persists it to localStorage.
 *
 * The initial value is read synchronously during construction and applied
 * immediately, so the theme is correct as soon as the service is instantiated
 * (the first layout change-detection pass).
 *
 * This is intentionally not a true pre-paint bootstrap: the production CSP
 * forbids inline scripts, so the `:root` dark defaults may briefly paint before
 * Angular boots and a persisted `light` theme is applied here. Subsequent
 * changes are applied and persisted from the `effect()` below.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly state = signal<Theme>(this.readInitial());
  readonly theme = this.state.asReadonly();

  constructor() {
    // Apply the resolved theme as soon as the service is constructed.
    this.apply(this.state());

    effect(() => {
      const theme = this.state();
      this.apply(theme);
      this.persist(theme);
    });
  }

  /** Apply an explicit theme. */
  setTheme(theme: Theme): void {
    this.state.set(theme);
  }

  /** Flip between `dark` and `light`. */
  toggle(): void {
    this.state.update((theme) => (theme === 'dark' ? 'light' : 'dark'));
  }

  /** Read the persisted theme, falling back to `dark` for missing/invalid values. */
  private readInitial(): Theme {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  private persist(theme: Theme): void {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private mode / storage disabled: theming still works for this session.
    }
  }

  private apply(theme: Theme): void {
    const root =
      this.document?.documentElement ??
      (globalThis as { document?: Document }).document?.documentElement;
    root?.setAttribute('data-theme', theme);
  }
}
