import { Directive, computed, input, output } from '@angular/core';

/**
 * Attribute directive: the ONE reusable selectable-row pattern (plan §2.5).
 *
 * It is deliberately host-agnostic: it adds the shared utility classes
 * (`st-selectable-row`, `st-selectable-row--selected`, `st-selection-bar`,
 * `st-focus-ring--inset`) to whatever element it sits on, owns `tabindex`, and
 * emits `rowActivated` on click or on Enter/Space. It does **not** style the
 * host's geometry — consumers own height, padding and layout, so the same
 * pattern works for the nav rail, history rows, the file list and search hits.
 *
 * A directive cannot carry styles, which is exactly why the visual treatment
 * lives in the utility layer instead.
 */
@Directive({
  selector: '[stSelectableRow]',
  host: {
    class: 'st-selectable-row',
    '[class.st-selectable-row--selected]': 'selected()',
    '[class.st-selection-bar]': 'selected()',
    '[class.st-focus-ring--inset]': 'true',
    '[attr.tabindex]': 'tabindex()',
    '(click)': 'onActivate()',
    '(keydown.enter)': 'onKey($event)',
    '(keydown.space)': 'onKey($event)',
  },
})
export class SelectableRowDirective {
  readonly selected = input(false);
  readonly disabled = input(false);

  readonly rowActivated = output<void>();

  /** `0` when interactive, `null` (attribute removed) when disabled. */
  readonly tabindex = computed(() => (this.disabled() ? null : 0));

  onActivate(): void {
    if (this.disabled()) return;
    this.rowActivated.emit();
  }

  onKey(event: Event): void {
    if (this.disabled()) return;
    event.preventDefault();
    this.rowActivated.emit();
  }
}
