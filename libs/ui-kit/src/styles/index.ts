/**
 * ui-kit global style entry points.
 *
 * The canonical design-token and utility layers live beside this module as
 * `tokens.scss` and `utilities.scss`. Consumers import the SCSS partials
 * directly (the renderer does so from `apps/angular/src/styles.scss`); this
 * module publishes the canonical entry names and what each one provides, so
 * no consumer ever hand-rolls its own token layer.
 */
export const UIKIT_STYLES = {
  /** Two-tier design tokens: dark defaults in `:root` + matched `[data-theme=light]`. */
  tokens: 'tokens.scss',
  /** Shared utility classes (focus ring, hairline, eyebrow, selection bar…). */
  utilities: 'utilities.scss',
} as const;

export type UiKitStyleEntry = keyof typeof UIKIT_STYLES;
