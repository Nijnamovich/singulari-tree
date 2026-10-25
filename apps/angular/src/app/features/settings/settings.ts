import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { Language } from '@core/i18n/language';
import { DiffModeService, type DiffMode } from '@core/services/diff-mode.service';
import { LanguageService } from '@core/services/language.service';
import {
  PreferencesService,
  type DensityPreference,
  type DiffFontSize,
  type DiffWordWrap,
  type MotionPreference,
} from '@core/services/preferences.service';
import { ThemeService, type Theme } from '@core/services/theme.service';
import {
  ButtonComponent,
  PanelComponent,
  SelectComponent,
  ToggleGroupComponent,
  type ToggleOption,
} from '@singularitree/ui-kit';

/**
 * Settings feature page (plan §4.9, divergence D14). Five grouped preference
 * panels — Appearance, Workspace, Diff, Language and About — all renderer-local
 * (`st:` localStorage, no IPC, no core involvement).
 *
 * **Consumed today:** theme (through `ThemeService`), language (through
 * `LanguageService`, which persists then reloads) and diff layout (through
 * `DiffModeService`, the same service the diff-pane toggle uses — its state is
 * never mirrored here).
 *
 * **Enforced / consumed now:** motion (plan §2.6 — `PreferencesService` applies
 * the stored `auto | on | off` to `<html data-st-motion>` at boot and on every
 * change, so the runtime `off` switch landed with P6) and density (applied to
 * `<html data-st-density>` the same way, driving the shared `--st-size-row-tree`
 * token that sizes every file/tree row). Pane width, diff font size and diff word
 * wrap are persisted here and consumed by their host surfaces — the workspace
 * split and the diff viewer — through ui-kit inputs.
 *
 * The About panel is read-only: it names the product and the shipped design
 * direction and records that git-configuration editing is deferred to V1
 * (divergence D14 — it needs core I/O and is out of the UI layer). It renders
 * no action and writes nothing to storage.
 */
@Component({
  selector: 'st-settings',
  standalone: true,
  imports: [ButtonComponent, PanelComponent, SelectComponent, ToggleGroupComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="st-settings" data-testid="settings">
      <h1 class="st-settings__title" i18n>Settings</h1>

      <st-panel data-testid="settings-panel-appearance">
        <div header class="st-settings__head">
          <span class="st-eyebrow" i18n>Display</span>
          <span class="st-settings__panel-title" i18n>Appearance</span>
        </div>
        <div class="st-settings__body">
          <div class="st-settings__row">
            <span class="st-settings__label" i18n>Theme</span>
            <st-toggle-group
              data-testid="settings-theme"
              ariaLabel="Theme"
              [options]="themeOptions"
              [value]="themeService.theme()"
              (valueChange)="pickTheme($event)"
            />
          </div>
          <div class="st-settings__row">
            <span class="st-settings__label" i18n>Motion</span>
            <st-toggle-group
              data-testid="settings-motion"
              ariaLabel="Motion"
              [options]="motionOptions"
              [value]="prefs.motion()"
              (valueChange)="pickMotion($event)"
            />
          </div>
        </div>
      </st-panel>

      <st-panel data-testid="settings-panel-workspace">
        <div header class="st-settings__head">
          <span class="st-eyebrow" i18n>Layout</span>
          <span class="st-settings__panel-title" i18n>Workspace</span>
        </div>
        <div class="st-settings__body">
          <div class="st-settings__row">
            <span class="st-settings__label" i18n>Density</span>
            <st-toggle-group
              data-testid="settings-density"
              ariaLabel="Density"
              [options]="densityOptions"
              [value]="prefs.density()"
              (valueChange)="pickDensity($event)"
            />
          </div>
          <div class="st-settings__row">
            <span class="st-settings__label" i18n>Pane width</span>
            <st-button
              variant="default"
              size="sm"
              data-testid="settings-reset-pane-width"
              [disabled]="!prefs.hasPaneWidth()"
              (click)="resetPaneWidth()"
              i18n
              >Reset pane width</st-button
            >
          </div>
        </div>
      </st-panel>

      <st-panel data-testid="settings-panel-diff">
        <div header class="st-settings__head">
          <span class="st-eyebrow" i18n>Review</span>
          <span class="st-settings__panel-title" i18n>Diff</span>
        </div>
        <div class="st-settings__body">
          <div class="st-settings__row">
            <span class="st-settings__label" i18n>Layout</span>
            <st-toggle-group
              data-testid="settings-diff-layout"
              ariaLabel="Diff layout"
              [options]="diffLayoutOptions"
              [value]="diffModeService.mode()"
              (valueChange)="pickDiffMode($event)"
            />
          </div>
          <div class="st-settings__row">
            <span class="st-settings__label" i18n>Font size</span>
            <st-select
              data-testid="settings-diff-font-size"
              ariaLabel="Diff font size"
              [value]="prefs.diffFontSize()"
              (valueChange)="pickDiffFontSize($event)"
            >
              <option value="11" i18n>11 px</option>
              <option value="12" i18n>12 px</option>
              <option value="13" i18n>13 px</option>
            </st-select>
          </div>
          <div class="st-settings__row">
            <span class="st-settings__label" i18n>Word wrap</span>
            <st-toggle-group
              data-testid="settings-diff-word-wrap"
              ariaLabel="Diff word wrap"
              [options]="wordWrapOptions"
              [value]="prefs.diffWordWrap()"
              (valueChange)="pickDiffWordWrap($event)"
            />
          </div>
        </div>
      </st-panel>

      <st-panel data-testid="settings-panel-language">
        <div header class="st-settings__head">
          <span class="st-eyebrow" i18n>Localization</span>
          <span class="st-settings__panel-title" i18n>Language</span>
        </div>
        <div class="st-settings__body">
          <div class="st-settings__row">
            <span class="st-settings__label" i18n>Language</span>
            <st-toggle-group
              data-testid="settings-language"
              ariaLabel="Language"
              [options]="languageOptions"
              [value]="languageService.language()"
              (valueChange)="pickLanguage($event)"
            />
          </div>
        </div>
      </st-panel>

      <st-panel data-testid="settings-about">
        <div header class="st-settings__head">
          <span class="st-eyebrow" i18n>Application</span>
          <span class="st-settings__panel-title" i18n>About</span>
        </div>
        <div class="st-settings__body">
          <p class="st-settings__about-name" i18n>SingulariTree</p>
          <p class="st-settings__about-line" i18n>
            Design direction: Dark Neon / Developer Studio.
          </p>
          <p class="st-settings__about-line" i18n>
            Editing Git configuration from Settings is deferred to V1 — it needs core I/O and is
            out of the UI layer.
          </p>
        </div>
      </st-panel>
    </section>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      overflow: auto;
      padding: var(--st-space-4);
      color: var(--st-color-text);
    }

    .st-settings {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-4);
      max-width: 640px;
    }

    .st-settings__title {
      margin: 0;
      font-size: var(--st-font-22);
      font-weight: 600;
      line-height: var(--st-leading-tight);
    }

    /* Eyebrow + title read as one header block; the type's own leading is the
       only separation (a 2px gap sat off the 4px grid and added nothing). */
    .st-settings__head {
      display: flex;
      flex-direction: column;
      gap: 0;
      min-width: 0;
    }

    .st-settings__panel-title {
      font-size: var(--st-font-13);
      font-weight: 600;
      color: var(--st-color-text);
    }

    .st-settings__body {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-3);
      padding: var(--st-space-3);
    }

    .st-settings__row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--st-space-2) var(--st-space-3);
    }

    .st-settings__label {
      font-size: var(--st-font-12);
      font-weight: 400;
      color: var(--st-color-muted);
    }

    .st-settings__about-name {
      margin: 0;
      font-size: var(--st-font-13);
      font-weight: 600;
      color: var(--st-color-text);
    }

    .st-settings__about-line {
      margin: 0;
      font-size: var(--st-font-12);
      color: var(--st-color-muted);
    }
  `,
})
export class Settings {
  readonly themeService = inject(ThemeService);
  readonly languageService = inject(LanguageService);
  readonly diffModeService = inject(DiffModeService);
  readonly prefs = inject(PreferencesService);

  readonly themeOptions: readonly ToggleOption[] = [
    { value: 'dark', label: $localize`Dark` },
    { value: 'light', label: $localize`Light` },
  ];

  readonly motionOptions: readonly ToggleOption[] = [
    { value: 'auto', label: $localize`Auto` },
    { value: 'on', label: $localize`On` },
    { value: 'off', label: $localize`Off` },
  ];

  readonly densityOptions: readonly ToggleOption[] = [
    { value: 'compact', label: $localize`Compact` },
    { value: 'comfortable', label: $localize`Comfortable` },
  ];

  readonly diffLayoutOptions: readonly ToggleOption[] = [
    { value: 'unified', label: $localize`Unified` },
    { value: 'side-by-side', label: $localize`Side by side` },
  ];

  readonly wordWrapOptions: readonly ToggleOption[] = [
    { value: 'on', label: $localize`On` },
    { value: 'off', label: $localize`Off` },
  ];

  readonly languageOptions: readonly ToggleOption[] = [
    { value: 'en', label: 'EN' },
    { value: 'es', label: 'ES' },
  ];

  /** Apply the requested theme (persisted by `ThemeService`). */
  pickTheme(theme: string): void {
    this.themeService.setTheme(theme as Theme);
  }

  /** Apply the requested motion preference (persisted by `PreferencesService`). */
  pickMotion(value: string): void {
    this.prefs.setMotion(value as MotionPreference);
  }

  /** Apply the requested density preference (persisted by `PreferencesService`). */
  pickDensity(value: string): void {
    this.prefs.setDensity(value as DensityPreference);
  }

  /** Clear the persisted pane width (persisted by `PreferencesService`). */
  resetPaneWidth(): void {
    this.prefs.resetPaneWidth();
  }

  /** Apply the requested diff layout through the shared `DiffModeService`. */
  pickDiffMode(value: string): void {
    this.diffModeService.setMode(value as DiffMode);
  }

  /** Apply the requested diff font size (persisted by `PreferencesService`). */
  pickDiffFontSize(value: string): void {
    this.prefs.setDiffFontSize(value as DiffFontSize);
  }

  /** Apply the requested diff soft-wrap preference (persisted by `PreferencesService`). */
  pickDiffWordWrap(value: string): void {
    this.prefs.setDiffWordWrap(value as DiffWordWrap);
  }

  /** Select the requested language (persists, then reloads via `LanguageService`). */
  pickLanguage(language: string): void {
    this.languageService.setLanguage(language as Language);
  }
}
