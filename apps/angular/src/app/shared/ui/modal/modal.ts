import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { IconComponent } from '@singularitree/ui-kit';

/**
 * Every natively focusable element inside the dialog, in document order. The
 * panel itself carries `tabindex="-1"` and is therefore excluded.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable modal shell for feature dialogs.
 *
 * Renders nothing while `open()` is false. The backdrop closes on click (when
 * `closeOnBackdrop()`) and the component closes on Escape; both paths emit
 * `closed`. Content is projected into the body while elements tagged with the
 * `st-modal-footer` attribute project into the footer.
 *
 * The panel sits on the raised surface over the shared overlay (plan §4.10) —
 * layering comes from the overlay, never from an elevation shadow. It also owns
 * a focus trap and focus restore: on open, focus moves into the dialog and the
 * previously focused element is remembered; on any close (Escape, backdrop,
 * close button or a consumer-driven close) focus returns to it, and Tab / Shift+Tab
 * cycle within the dialog instead of escaping to the page behind.
 */
@Component({
  selector: 'st-modal',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div
        class="st-modal__backdrop"
        data-testid="modal-backdrop"
        (click)="onBackdropClick($event)"
      >
        <div
          class="st-modal"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          data-testid="modal"
        >
          <div class="st-modal__head">
            <h2 class="st-modal__title" data-testid="modal-title">{{ title() }}</h2>
            <button
              class="st-modal__close"
              type="button"
              data-testid="modal-close"
              aria-label="Close"
              (click)="close()"
            >
              <st-icon name="close" />
            </button>
          </div>
          <div class="st-modal__body">
            <ng-content />
          </div>
          <div class="st-modal__footer">
            <ng-content select="[st-modal-footer]" />
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-modal__backdrop {
      position: fixed;
      inset: 0;
      z-index: var(--st-z-modal);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--st-space-6);
      background: var(--st-color-overlay);
    }

    .st-modal {
      display: flex;
      flex-direction: column;
      width: min(560px, 100%);
      max-height: calc(100vh - 2 * var(--st-space-6));
      overflow: auto;
      background: var(--st-color-raised);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-4);
      color: var(--st-color-text);
      animation: st-modal-in var(--st-motion-base) var(--st-ease);
    }

    @keyframes st-modal-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }

    .st-modal__head {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      padding: var(--st-space-3) var(--st-space-4);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
    }

    .st-modal__title {
      flex: 1;
      margin: 0;
      font-size: var(--st-font-13);
      font-weight: 600;
    }

    .st-modal__close {
      display: inline-flex;
      align-items: center;
      background: transparent;
      border: var(--st-hairline) solid transparent;
      color: var(--st-color-text);
      border-radius: var(--st-radius-2);
      cursor: pointer;
      padding: var(--st-space-1) var(--st-space-2);
      line-height: 1;
    }

    .st-modal__close:hover {
      background: color-mix(in srgb, var(--st-color-text) 6%, transparent);
      border-color: var(--st-color-border);
    }

    .st-modal__body {
      padding: var(--st-space-4);
    }

    .st-modal__footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--st-space-2);
      padding: var(--st-space-3) var(--st-space-4);
      border-top: var(--st-hairline) solid var(--st-color-border);
    }
  `,
})
export class ModalComponent {
  readonly open = input(false);
  readonly title = input('');
  readonly closeOnBackdrop = input(true);

  readonly closed = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The element focused before the dialog opened; focus returns to it on close. */
  private restoreTarget: HTMLElement | null = null;
  /** Whether the dialog was open on the previous effect run. */
  private wasOpen = false;

  constructor() {
    // The open/close bookkeeping lives on the instance (not the DOM), so it
    // survives the `@if (open())` re-render. `wasOpen` guards the restore so the
    // initial render (`open` false) never steals focus from a stale target.
    effect(() => {
      const open = this.open();
      if (open) {
        this.restoreTarget = document.activeElement as HTMLElement | null;
        // The panel renders in the same pass; defer focus one microtask so the
        // node exists (mirrors `graph-context-menu`).
        queueMicrotask(() => this.panel()?.focus());
      } else if (this.wasOpen) {
        this.restoreTarget?.focus();
        this.restoreTarget = null;
      }
      this.wasOpen = open;
    });
  }

  /** The dialog panel, when rendered. */
  private panel(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('.st-modal');
  }

  close(): void {
    this.closed.emit();
  }

  /** Close on Escape, but only while the modal is actually open. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.closed.emit();
  }

  /**
   * Trap Tab while open: cycle within the panel's focusable elements instead of
   * letting focus escape to the page behind (the modal counterpart to
   * `st-popover`'s dismissal). An explicit `event.key === 'Tab'` guard is used
   * deliberately — it behaves deterministically under jsdom and zoneless, where a
   * key-name alias could be unreliable.
   */
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.open() || event.key !== 'Tab') return;
    const panel = this.panel();
    if (!panel) return;

    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    event.preventDefault();

    if (focusable.length === 0) {
      panel.focus();
      return;
    }

    const active = document.activeElement;
    const index = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    const delta = event.shiftKey ? -1 : 1;
    const next =
      index === -1
        ? event.shiftKey
          ? focusable[focusable.length - 1]
          : focusable[0]
        : focusable[(index + delta + focusable.length) % focusable.length];
    next?.focus();
  }

  /** Close when the backdrop itself (not the panel or its content) is clicked. */
  onBackdropClick(event: MouseEvent): void {
    if (!this.closeOnBackdrop()) return;
    if (event.target !== event.currentTarget) return;
    this.closed.emit();
  }
}
