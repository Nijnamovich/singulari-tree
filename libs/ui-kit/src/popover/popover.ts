import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
} from '@angular/core';

/**
 * Dumb floating layer (plan §4.1 overflow menu, §4.7 unpinned repo drawer,
 * §4.2 context menus). It renders a transparent full-screen backdrop plus a
 * raised panel only while `open()` is true; anchoring is the consumer's job
 * (wrap it in a `position: relative` element).
 *
 * Closing is deliberately over-specified, because an ad-hoc menu that leaks is
 * the bug this primitive replaces: Escape, a backdrop click, and focus leaving
 * the popover subtree each emit `closed`. The parent owns `open` and decides
 * whether to restore focus to its trigger.
 */
@Component({
  selector: 'st-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="st-popover__backdrop" data-testid="popover-backdrop" (click)="close()"></div>
      <div class="st-popover" role="dialog" data-testid="popover">
        <ng-content />
      </div>
    }
  `,
  host: {
    '(focusout)': 'onFocusOut($event)',
  },
  styles: `
    :host {
      display: contents;
    }

    .st-popover__backdrop {
      position: fixed;
      inset: 0;
      z-index: var(--st-z-backdrop);
    }

    .st-popover {
      position: absolute;
      z-index: var(--st-z-popover);
      min-width: var(--st-size-pane-min);
      background: var(--st-color-raised);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-4);
      animation: st-popover-in var(--st-motion-base) var(--st-ease);
    }

    @keyframes st-popover-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
  `,
})
export class PopoverComponent {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly open = input(false);

  readonly closed = output<void>();

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.open()) return;
    this.close();
  }

  onFocusOut(event: FocusEvent): void {
    if (!this.open()) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !this.element.nativeElement.contains(next)) {
      this.close();
    }
  }

  close(): void {
    this.closed.emit();
  }
}
