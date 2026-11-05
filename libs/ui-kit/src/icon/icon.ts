import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ICON_PATHS } from './icons';

/**
 * Dumb, decorative icon: renders one entry of the inline-SVG registry
 * (plan §8.1 decision #9) inside a shared 24×24 stroke shell.
 *
 * The icon is always `aria-hidden` — the accessible name belongs to the host
 * control, never to the glyph. An unknown (or empty) `name` renders nothing and
 * is never an error, so consumers can pass data-driven names freely.
 *
 * Default render size is 17px, expressed as `var(--st-font-17)` (P1 does not add
 * the plan's `--st-icon-size` token; tokens are P2's job). An explicit numeric
 * `size` overrides it as a raw pixel value for the rare non-17px call site.
 */
@Component({
  selector: 'st-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (markup(); as svg) {
      <svg
        class="st-icon"
        data-testid="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [innerHTML]="svg"
      ></svg>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .st-icon {
      display: block;
      flex: none;
      width: var(--st-font-17);
      height: var(--st-font-17);
    }
  `,
})
export class IconComponent {
  private readonly sanitizer = inject(DomSanitizer);

  readonly name = input('');

  /** Explicit pixel size; `null` (default) keeps the tokenised 17px render. */
  readonly size = input<number | null>(null);

  /**
   * The registry markup is a trusted, static constant, so it is explicitly
   * bypassed: the HTML sanitizer only allows HTML tags and would strip every
   * SVG element.
   */
  readonly markup = computed<SafeHtml | null>(() => {
    const inner = ICON_PATHS[this.name()];
    return inner ? this.sanitizer.bypassSecurityTrustHtml(inner) : null;
  });
}
