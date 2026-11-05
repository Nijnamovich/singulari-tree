import { DOCUMENT } from '@angular/core';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

/** User-facing motion preference (plan §2.6). `auto` follows the OS. */
export type MotionPreference = 'auto' | 'on' | 'off';

/** Working-tree density preference (plan §4.9). */
export type DensityPreference = 'compact' | 'comfortable';

/** Diff font size in CSS pixels (plan §4.9). */
export type DiffFontSize = '11' | '12' | '13';

/** Diff soft-wrap preference (plan §4.9). */
export type DiffWordWrap = 'on' | 'off';

/** localStorage keys owned by this service (matches the `st:` shell convention). */
const MOTION_STORAGE_KEY = 'st:motion';
const DENSITY_STORAGE_KEY = 'st:density';
const PANE_WIDTH_STORAGE_KEY = 'st:paneWidth';
const DIFF_FONT_SIZE_STORAGE_KEY = 'st:diffFontSize';
const DIFF_WORD_WRAP_STORAGE_KEY = 'st:diffWordWrap';

/**
 * Root renderer-local preferences service (plan §4.9, decision #10, divergence
 * D14). It owns ONLY the preferences that have no dedicated service yet —
 * theme, language and diff layout stay owned by {@link ThemeService},
 * {@link LanguageService} and {@link DiffModeService} respectively, and are
 * never mirrored here.
 *
 * Every key is independent: the initial value is read synchronously during
 * construction (so the first render already honours a persisted choice), each
 * setter persists, and every localStorage access is wrapped in `try/catch` so a
 * disabled or full storage (private mode) degrades to a session-only
 * preference instead of throwing.
 *
 * The motion preference is enforced at runtime, not merely persisted: it is
 * applied to `document.documentElement[data-st-motion]` exactly as
 * {@link ThemeService} applies `data-theme` — synchronously for the boot value
 * and from an `effect()` on every change. `auto` removes the attribute so the OS
 * `prefers-reduced-motion` query decides; `on` opts back in even under reduce;
 * `off` neutralises motion unconditionally.
 *
 * Density is enforced the same way — synchronously for the boot value and from
 * an `effect()` on every change — by writing an explicit
 * `<html data-st-density="compact|comfortable">`. Unlike motion's `auto` there is
 * no "follow the OS" state, so the attribute is always present and never removed;
 * the single token it overrides (`--st-size-row-tree`) flips every file/tree row
 * consumer at once while graph and dense rows stay frozen. The shipped default is
 * `comfortable` (28px rows), so only an explicit `compact` persisted value renders
 * the 24px rows. The remaining keys —
 * pane width, diff font size and diff word wrap — are persisted here but consumed
 * by their host surfaces (the workspace split and the diff viewer) through ui-kit
 * inputs, not by this service.
 *
 * Invalid or unknown persisted values always fall back to the documented
 * default rather than crashing or propagating a bad value.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly document = inject(DOCUMENT);

  private readonly motionState = signal<MotionPreference>(this.readMotion());
  private readonly densityState = signal<DensityPreference>(this.readDensity());
  private readonly paneWidthState = signal<string>(this.readPaneWidth());
  private readonly diffFontSizeState = signal<DiffFontSize>(this.readDiffFontSize());
  private readonly diffWordWrapState = signal<DiffWordWrap>(this.readDiffWordWrap());

  /** Motion preference: `auto` (OS), `on` or `off`. */
  readonly motion = this.motionState.asReadonly();
  /** Working-tree density: `compact` or `comfortable`. */
  readonly density = this.densityState.asReadonly();
  /** Persisted pane width as a pixel string; `''` means "no explicit width". */
  readonly paneWidth = this.paneWidthState.asReadonly();
  /** Diff font size: `11`, `12` or `13`. */
  readonly diffFontSize = this.diffFontSizeState.asReadonly();
  /** Diff soft wrap: `on` or `off`. */
  readonly diffWordWrap = this.diffWordWrapState.asReadonly();

  /** True when an explicit pane width is persisted, so the reset can be enabled. */
  readonly hasPaneWidth = computed(() => this.paneWidthState() !== '');

  constructor() {
    // Apply the resolved motion/density preferences as soon as the service is constructed.
    this.applyMotion(this.motionState());
    this.applyDensity(this.densityState());

    effect(() => {
      this.applyMotion(this.motionState());
    });

    effect(() => {
      this.applyDensity(this.densityState());
    });
  }

  /** Apply and persist the motion preference. */
  setMotion(value: MotionPreference): void {
    this.motionState.set(value);
    this.write(MOTION_STORAGE_KEY, value);
  }

  /** Apply and persist the density preference. */
  setDensity(value: DensityPreference): void {
    this.densityState.set(value);
    this.write(DENSITY_STORAGE_KEY, value);
  }

  /** Apply and persist an explicit pane width (a pixel number string). */
  setPaneWidth(value: string): void {
    this.paneWidthState.set(value);
    this.write(PANE_WIDTH_STORAGE_KEY, value);
  }

  /** Apply and persist the diff font size. */
  setDiffFontSize(value: DiffFontSize): void {
    this.diffFontSizeState.set(value);
    this.write(DIFF_FONT_SIZE_STORAGE_KEY, value);
  }

  /** Apply and persist the diff soft-wrap preference. */
  setDiffWordWrap(value: DiffWordWrap): void {
    this.diffWordWrapState.set(value);
    this.write(DIFF_WORD_WRAP_STORAGE_KEY, value);
  }

  /** Clear the persisted pane width and fall back to the layout default. */
  resetPaneWidth(): void {
    this.paneWidthState.set('');
    this.remove(PANE_WIDTH_STORAGE_KEY);
  }

  private readMotion(): MotionPreference {
    const stored = this.read(MOTION_STORAGE_KEY);
    return stored === 'on' || stored === 'off' ? stored : 'auto';
  }

  private readDensity(): DensityPreference {
    // `comfortable` (28px rows) is the shipped default; only an explicit
    // `compact` value persisted by the user opts into the 24px rows.
    return this.read(DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
  }

  private readDiffFontSize(): DiffFontSize {
    const stored = this.read(DIFF_FONT_SIZE_STORAGE_KEY);
    return stored === '11' || stored === '13' ? stored : '12';
  }

  private readDiffWordWrap(): DiffWordWrap {
    return this.read(DIFF_WORD_WRAP_STORAGE_KEY) === 'on' ? 'on' : 'off';
  }

  /** Read the pane width, dropping anything that is not a positive pixel number. */
  private readPaneWidth(): string {
    const stored = this.read(PANE_WIDTH_STORAGE_KEY);
    if (!stored) return '';
    const pixels = Number(stored);
    return Number.isFinite(pixels) && pixels > 0 ? stored : '';
  }

  private read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode / storage disabled: the preference lives this session only.
    }
  }

  private remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Private mode / storage disabled: nothing to clear on disk.
    }
  }

  /**
   * Reflect the motion preference onto `document.documentElement`. `auto` removes
   * the attribute so the OS `prefers-reduced-motion` query decides; `on`/`off`
   * set it explicitly. Mirrors {@link ThemeService}'s defensive root lookup.
   */
  private applyMotion(motion: MotionPreference): void {
    const root =
      this.document?.documentElement ??
      (globalThis as { document?: Document }).document?.documentElement;
    if (!root) return;
    if (motion === 'auto') {
      root.removeAttribute('data-st-motion');
    } else {
      root.setAttribute('data-st-motion', motion);
    }
  }

  /**
   * Reflect the density preference onto `document.documentElement` as
   * `<html data-st-density="compact|comfortable">`. Both values are explicit, so
   * unlike motion there is no "follow the OS" state and the attribute is never
   * removed. Mirrors {@link ThemeService}'s defensive root lookup.
   */
  private applyDensity(density: DensityPreference): void {
    const root =
      this.document?.documentElement ??
      (globalThis as { document?: Document }).document?.documentElement;
    if (!root) return;
    root.setAttribute('data-st-density', density);
  }
}
