import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'info' | 'icon';
export type ButtonSize = 'sm' | 'md';
export type ButtonType = 'button' | 'submit' | 'reset';

/**
 * Dumb button: a native `<button>` with projected label. Consumers attach
 * `(click)` on the `<st-button>` host — the inner button's click bubbles up.
 *
 * Variants: `default` (bordered surface), `primary` (the one accented,
 * glowing action), `ghost` (transparent), `danger` (transparent, coral —
 * errors only) and `info` (neutral/muted that takes the electric-blue
 * `--st-color-info` accent only while hovered or focused). `icon` sizes the
 * button square instead of adding a label.
 *
 * Toggle buttons set `[pressed]` to `true`/`false`: it is forwarded as
 * `aria-pressed` on the inner native `<button>` so assistive tech reads the
 * pressed state (which would otherwise be exposed only visually by a host
 * class). The default `null` drops the attribute entirely — a plain button is
 * not a toggle.
 */
@Component({
  selector: 'st-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'st-button-host',
    '[class.st-button-host--disabled]': 'disabled()',
  },
  template: `
    <button
      class="st-button st-button--{{ variant() }} st-button--{{ size() }}"
      data-testid="button"
      [type]="type()"
      [disabled]="disabled()"
      [attr.aria-label]="ariaLabel() || null"
      [attr.aria-describedby]="ariaDescribedby() || null"
      [attr.aria-pressed]="pressed()"
      [attr.aria-expanded]="expanded()"
      [attr.aria-haspopup]="haspopup()"
    >
      <ng-content />
    </button>
  `,
  styles: `
    :host {
      display: inline-block;
    }

    :host(.st-button-host--disabled) {
      opacity: 0.5;
      cursor: default;
    }

    .st-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid var(--st-color-border);
      border-radius: 6px;
      background: var(--st-color-surface);
      color: var(--st-color-text);
      font: inherit;
      cursor: pointer;
      transition:
        background-color 120ms ease,
        border-color 120ms ease;
    }

    .st-button--sm {
      height: 24px;
      padding: 0 8px;
      font-size: 11px;
    }

    .st-button--md {
      height: 30px;
      padding: 0 12px;
      font-size: 12px;
    }

    .st-button--primary {
      background: var(--st-color-accent);
      border-color: var(--st-color-accent);
      color: var(--st-color-accent-contrast);
      /* The ONE permitted glow in the system — the primary action only. */
      box-shadow: 0 2px 10px color-mix(in srgb, var(--st-color-accent) 22%, transparent);
    }

    .st-button--ghost {
      background: transparent;
      border-color: transparent;
    }

    .st-button--danger {
      background: transparent;
      border-color: transparent;
      color: var(--st-color-danger);
    }

    .st-button--info {
      background: transparent;
      border-color: transparent;
      color: var(--st-color-muted);
    }

    .st-button--icon {
      padding: 0;
    }

    .st-button--icon.st-button--sm {
      width: var(--st-size-control-sm);
      height: var(--st-size-control-sm);
      min-width: var(--st-size-control-sm);
    }

    .st-button--icon.st-button--md {
      width: var(--st-size-control-md);
      height: var(--st-size-control-md);
      min-width: var(--st-size-control-md);
    }

    .st-button:not(:disabled):hover {
      border-color: var(--st-color-accent);
    }

    .st-button--primary:not(:disabled):hover {
      background: color-mix(in srgb, var(--st-color-accent) 85%, var(--st-color-accent-contrast));
    }

    /* Declared after the generic hover so the transparent border wins. */
    .st-button--danger:not(:disabled):hover {
      background: var(--st-color-danger-soft);
      border-color: transparent;
    }

    /* Declared after the generic hover so the info accent only appears on
       interaction — a neutral button that lights up electric blue. */
    .st-button--info:not(:disabled):hover,
    .st-button--info:not(:disabled):focus-visible {
      border-color: var(--st-color-info);
      color: var(--st-color-info);
    }

    .st-button:disabled {
      cursor: default;
    }

    .st-button:focus-visible {
      outline: 2px solid var(--st-color-focus);
      outline-offset: 1px;
    }
  `,
})
export class ButtonComponent {
  readonly variant = input<ButtonVariant>('default');
  readonly size = input<ButtonSize>('md');
  readonly disabled = input(false);
  readonly type = input<ButtonType>('button');
  readonly ariaLabel = input('');
  /** `aria-pressed` for toggle buttons; `null` (default) renders no attribute. */
  readonly pressed = input<boolean | null>(null);
  /** `aria-expanded` for disclosure triggers; `null` (default) renders no attribute. */
  readonly expanded = input<boolean | null>(null);
  /** `aria-haspopup` for popup triggers; `null` (default) renders no attribute. */
  readonly haspopup = input<string | null>(null);
  /**
   * `aria-describedby` for a control explained by a tooltip/hint elsewhere;
   * `null` (default) renders no attribute.
   */
  readonly ariaDescribedby = input<string | null>(null);
}
